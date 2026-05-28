/* ============================================================
   main.js — shared application state, color scales, tooltip,
   and the linked-brushing engine that ties every view together.

   Optimised for the full 170k-track Kaggle dataset:
   - Per-track fields live in TYPED ARRAYS (Float32/Uint8) not JS objects.
   - The "is this track currently visible" question is answered by two
     Uint8Array masks (filterMask × brushMask) — O(1) check, no Set ops.
   - Color is computed by bucketing into a small palette so canvas
     renderers can draw 170k points in a few large fillRect batches per
     color rather than 170k per-element style writes.
   ============================================================ */
const App = {
  meta: null,                 // /api/meta payload
  n: 0,                       // total number of tracks
  features: [],
  featureLabels: {},

  // ---- typed-array columns (filled by boot.js) ----
  // coords[mode] -> Float32Array(2n) interleaved x,y in unit [0,1]
  coords: { pca: null, umap: null },
  feats01: null,              // Float32Array(8n), feature normalized 0..1
  feats: null,                // raw features in original units, Float32Array(8n)
  popularity: null,           // Uint8Array(n)
  decadeIdx: null,            // Uint8Array(n)  (0=first decade, ...)
  collab: null,               // Uint8Array(n)
  key: null,                  // Uint8Array(n)
  mode: null,                 // Uint8Array(n)
  explicit: null,             // Uint8Array(n)
  year: null,                 // Uint16Array(n)
  tempo: null,                // Float32Array(n)
  duration: null,             // Uint32Array(n)
  // text
  names: [], artistsStr: [], releaseDates: [],

  // ---- global interaction state ----
  colorMode: "decade",        // decade | popularity | collab
  projMode: "pca",            // pca | umap
  pcpScale: "minmax",         // minmax | raw
  activeDecades: new Set(),   // EXCLUDED set; empty = all included
  popMin: 0,
  popMax: 100,
  collabFilter: null,         // null = all, 0 = solo, 1 = collab
  artistFilter: new Set(),    // selected artist names; empty = no filter
  // masks
  filterMask: null,           // Uint8Array(n), 1 if track passes filters
  brushMask: null,            // Uint8Array(n) OR null when no brush
  // hover linking
  hovered: -1,
  // registered views
  views: [],
};

/* ---------- color scales ---------- */
const DECADE_COLORS = {
  1920: "#2D5A6B", 1930: "#1E6B6B", 1940: "#178A5A", 1950: "#1DB954",
  1960: "#2ED760", 1970: "#57E389", 1980: "#8FF0A4", 1990: "#C9F299",
  2000: "#F2E96B", 2010: "#F2B705", 2020: "#F2790D",
};
function decadeColor(d){ return DECADE_COLORS[d] || "#888"; }
App.decadeColor = decadeColor;

const POP_RAMP = ["#1a4a32", "#1DB954", "#8FF0A4", "#F2E96B"];
const COLLAB_COLORS = ["#1DB954", "#F2790D"]; // 0=Solo, 1=Collaboration
const popInterp = d3.interpolateRgbBasis(POP_RAMP);

/* ---------- palette: per-bucket color array + per-track bucket index ----
   Returned:
     {
       colors:  string[]  — CSS color per bucket (length = numBuckets)
       buckets: Uint8Array(n) — which bucket each track falls into
     }
   Buckets group records by shared color so canvas redraw can batch the
   170k points into ~32 fillRect groups instead of 170k style writes.
*/
const NUM_CONT_BUCKETS = 24;
App.palette = function(){
  const n = App.n;
  if (App.colorMode === "decade"){
    const decs = App.meta.decades;
    const colors = decs.map(decadeColor);
    return { colors, buckets: App.decadeIdx };
  }
  if (App.colorMode === "popularity"){
    const colors = d3.range(NUM_CONT_BUCKETS).map(
      i => popInterp(i / (NUM_CONT_BUCKETS - 1)));
    const buckets = new Uint8Array(n);
    const pop = App.popularity;
    const s = (NUM_CONT_BUCKETS - 1) / 100;
    for (let i = 0; i < n; i++) buckets[i] = Math.min(NUM_CONT_BUCKETS - 1, (pop[i] * s) | 0);
    return { colors, buckets };
  }
  // collab: 2 buckets (0=Solo, 1=Collaboration)
  return { colors: COLLAB_COLORS, buckets: App.collab };
};

App.colorOf = function(i){
  if (App.colorMode === "decade") return decadeColor(App.meta.decades[App.decadeIdx[i]]);
  if (App.colorMode === "popularity") return popInterp(App.popularity[i] / 100);
  return COLLAB_COLORS[App.collab[i]];
};

/* ---------- filter mask (recomputed only when filters change) ---------- */
function rebuildFilterMask(){
  const n = App.n;
  const mask = new Uint8Array(n);
  const popMin = App.popMin;
  const popMax = App.popMax;
  const pop = App.popularity;
  const dec = App.decadeIdx;
  // Decade chip set holds INCLUDED decades (empty = include all).
  const decFilter = App.activeDecades.size > 0;
  let decAllowed = null;
  if (decFilter){
    decAllowed = new Uint8Array(App.meta.decades.length);
    App.meta.decades.forEach((d, idx) => { if (App.activeDecades.has(d)) decAllowed[idx] = 1; });
  }
  // Artist filter: precompute the union of track indices for the selected
  // artists (each artist maps to a Uint32Array of indices on the client).
  let artistMask = null;
  if (App.artistFilter.size > 0){
    artistMask = new Uint8Array(n);
    App.artistFilter.forEach(name => {
      const ids = App.artistToIds.get(name);
      if (!ids) return;
      for (let k = 0; k < ids.length; k++) artistMask[ids[k]] = 1;
    });
  }
  const collabF = App.collabFilter;
  for (let i = 0; i < n; i++){
    if (pop[i] < popMin || pop[i] > popMax) continue;
    if (decAllowed && !decAllowed[dec[i]]) continue;
    if (artistMask && !artistMask[i]) continue;
    if (collabF !== null && App.collab[i] !== collabF) continue;
    mask[i] = 1;
  }
  App.filterMask = mask;
}
App.rebuildFilterMask = rebuildFilterMask;

App.passesFilter = (i) => App.filterMask[i] === 1;
App.isSelected = (i) => App.filterMask[i] === 1 && (!App.brushMask || App.brushMask[i] === 1);
App.selectedCount = () => {
  const f = App.filterMask, b = App.brushMask, n = App.n;
  let c = 0;
  if (!b){ for (let i = 0; i < n; i++) c += f[i]; }
  else  { for (let i = 0; i < n; i++) c += (f[i] & b[i]); }
  return c;
};

/* ---------- the linking engine ---------- */
App.registerView = (fn) => App.views.push(fn);
App.refresh = () => {
  rebuildFilterMask();
  d3.select("#selCount").text(App.selectedCount().toLocaleString());
  App.views.forEach((fn) => { try { fn(); } catch(e){ console.error(e); } });
  updateLegend();
};

App.setBrush = (mask) => {
  // mask: Uint8Array(n) or null to clear
  App.brushMask = mask;
  d3.select("#selCount").text(App.selectedCount().toLocaleString());
  App.views.forEach((fn) => { try { fn(); } catch(e){ console.error(e); } });
};

App.setHover = (id) => {
  if (App.hovered === id) return;
  App.hovered = id;
  // Only redraw view-level overlays; main canvases don't need to redraw
  // for hover (each view paints its hover marker on a separate layer).
  App.hoverViews.forEach((fn) => { try { fn(); } catch(e){} });
};
App.hoverViews = [];
App.registerHoverView = (fn) => App.hoverViews.push(fn);

/* ---------- canvas helpers ---------- */
// Set up a canvas for HiDPI rendering. Returns {ctx, W, H, dpr}.
App.setupCanvas = (canvas) => {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width));
  const H = Math.max(1, Math.floor(rect.height));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H, dpr };
};

/* Draw all points to a canvas, bucketed by color.
   coords: Float32Array(2n) of pixel positions (interleaved x,y)

   Visibility rules (per user request):
   - Tracks that FAIL the filter (decade/popularity/artist) are NOT drawn
     at all — the filter culls them visually.
   - When NO brush is active: all filter-passing tracks are drawn bright.
   - When a brush IS active: filter-passing-AND-brushed tracks are drawn
     bright; filter-passing-but-not-brushed are drawn dim for context.
*/
App.drawPointsCanvas = (ctx, W, H, coords, opts = {}) => {
  const dimAlpha = opts.dimAlpha ?? 0.06;
  const selAlpha = opts.selAlpha ?? 0.7;
  const dimSize  = opts.dimSize  ?? 1;
  const selSize  = opts.selSize  ?? 2;
  ctx.clearRect(0, 0, W, H);
  const { colors, buckets } = App.palette();
  const f = App.filterMask, b = App.brushMask, n = App.n;
  const half = selSize / 2;

  if (!b){
    // No brush: only filter-passing tracks, all bright.
    ctx.globalAlpha = selAlpha;
    for (let bi = 0; bi < colors.length; bi++){
      ctx.fillStyle = colors[bi];
      for (let i = 0; i < n; i++){
        if (buckets[i] !== bi) continue;
        if (f[i] === 0) continue;
        const x = coords[i*2], y = coords[i*2+1];
        ctx.fillRect(x - half, y - half, selSize, selSize);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Brush active: dim filter-passing-not-brushed first, bright brushed on top.
  ctx.globalAlpha = dimAlpha;
  for (let bi = 0; bi < colors.length; bi++){
    ctx.fillStyle = colors[bi];
    for (let i = 0; i < n; i++){
      if (buckets[i] !== bi) continue;
      if (f[i] === 0 || b[i] === 1) continue;
      const x = coords[i*2], y = coords[i*2+1];
      ctx.fillRect(x, y, dimSize, dimSize);
    }
  }
  ctx.globalAlpha = selAlpha;
  for (let bi = 0; bi < colors.length; bi++){
    ctx.fillStyle = colors[bi];
    for (let i = 0; i < n; i++){
      if (buckets[i] !== bi) continue;
      if (f[i] === 0 || b[i] === 0) continue;
      const x = coords[i*2], y = coords[i*2+1];
      ctx.fillRect(x - half, y - half, selSize, selSize);
    }
  }
  ctx.globalAlpha = 1;
};

/* Find the closest filter-passing track to (mx, my) within radius r.
   Quadtree.find() returns the geometrically nearest point and doesn't
   know about filtering — so when the user filters to a small subset,
   hover would land on dimmed/hidden neighbours. This walks the quadtree
   and only considers tracks whose filterMask bit is set. */
App.findFilteredPoint = (tree, getX, getY, mx, my, r) => {
  let best = -1, bestD2 = r * r;
  const f = App.filterMask;
  tree.visit((node, x0, y0, x1, y1) => {
    if (x0 > mx + r || x1 < mx - r || y0 > my + r || y1 < my - r) return true;
    if (!node.length){
      do {
        const i = node.data;
        if (f[i] === 1){
          const dx = getX(i) - mx, dy = getY(i) - my;
          const d2 = dx*dx + dy*dy;
          if (d2 < bestD2){ bestD2 = d2; best = i; }
        }
      } while ((node = node.next));
    }
    return false;
  });
  return best;
};

/* Draw the hover marker (single point ring) on top of a points canvas. */
App.drawHoverMarker = (ctx, x, y, color) => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI*2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.restore();
};

/* ---------- track-record proxy for tooltip / detail ----------
   Some places (tooltip, detail panel) still want a "record-like"
   object. Build one on demand from typed arrays. */
App.recAt = (i) => {
  const f = App.features;
  const rec = {
    id: i,
    name: App.names[i],
    artist: App.artistsStr[i],
    year: App.year[i],
    decade: App.meta.decades[App.decadeIdx[i]],
    popularity: App.popularity[i],
    collab: !!App.collab[i],
    explicit: !!App.explicit[i],
    key: App.key[i],
    mode: App.mode[i],
    tempo: App.tempo[i],
    duration_ms: App.duration[i],
    release_date: App.releaseDates[i] || String(App.year[i]),
  };
  for (let k = 0; k < f.length; k++){
    rec[f[k]] = App.feats[i*f.length + k];
    rec[f[k]+"_n"] = App.feats01[i*f.length + k];
  }
  return rec;
};

/* ---------- tooltip ---------- */
const tt = d3.select("#tooltip");
App.tip = {
  show(html, ev){ tt.html(html).style("opacity", 1); this.move(ev); },
  move(ev){
    const pad = 16, w = 240;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth) x = ev.clientX - w - pad;
    if (y + 160 > window.innerHeight) y = ev.clientY - 160;
    tt.style("left", x + "px").style("top", y + "px");
  },
  hide(){ tt.style("opacity", 0); },
};
App.trackTip = (rec) => `
  <div class="tt-name">${rec.name}${rec.explicit ? '<span class="tt-explicit">E</span>' : ''}${rec.collab ? '<span class="tt-collab">COLAB</span>' : ''}</div>
  <div class="tt-artist">${rec.artist}</div>
  <div class="tt-row"><span>Año</span><b>${rec.year}</b></div>
  <div class="tt-row"><span>Popularidad</span><b>${rec.popularity}</b></div>
  <div class="tt-row"><span>Energy</span><b>${rec.energy.toFixed(2)}</b></div>
  <div class="tt-row"><span>Danceability</span><b>${rec.danceability.toFixed(2)}</b></div>
  <div class="tt-row"><span>Valence</span><b>${rec.valence.toFixed(2)}</b></div>
  <div class="tt-row"><span>Acousticness</span><b>${rec.acousticness.toFixed(2)}</b></div>`;

/* ---------- legend ---------- */
function updateLegend(){
  const box = d3.select("#legendSwatches");
  box.selectAll("*").remove();
  if (App.colorMode === "decade"){
    Object.keys(DECADE_COLORS).forEach((d) => {
      const s = box.append("div").attr("class", "swatch");
      s.append("i").style("background", DECADE_COLORS[d]);
      s.append("span").text(`${d}s`);
    });
  } else if (App.colorMode === "popularity") {
    const grad = `linear-gradient(90deg,${POP_RAMP.join(",")})`;
    const wrap = box.append("div").attr("class", "swatch bar");
    wrap.append("div").attr("class", "grad-bar").style("background", grad);
    const sc = wrap.append("div").attr("class", "grad-scale");
    sc.append("span").text("0"); sc.append("span").text("popularidad"); sc.append("span").text("100");
  } else {
    // collab
    ["Solo", "Colaboración"].forEach((label, i) => {
      const s = box.append("div").attr("class", "swatch");
      s.append("i").style("background", COLLAB_COLORS[i]);
      s.append("span").text(label);
    });
  }
}
App.updateLegend = updateLegend;

/* ---------- detail card (radar of one track) ---------- */
App.showDetail = (i) => {
  const rec = App.recAt(i);
  d3.select("#detail").classed("hidden", false);
  const safeName = rec.name.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  d3.select("#dName").html(safeName + (rec.explicit ? ' <span class="d-explicit-badge">E</span>' : ''));
  d3.select("#dArtist").text(rec.artist + " · " + rec.year);
  d3.select("#dCollabBadge")
    .style("display", rec.collab ? "inline-block" : "none")
    .text(rec.collab ? `Colaboración` : "");
  const keyNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const mins = Math.floor(rec.duration_ms / 60000);
  const secs = Math.floor((rec.duration_ms % 60000) / 1000);
  const durStr = `${mins}:${String(secs).padStart(2,"0")}`;
  d3.select("#dMeta").html(`
    <div>Pop <b>${rec.popularity}</b></div>
    <div>Tono <b>${keyNames[rec.key]} ${rec.mode? "may":"men"}</b></div>
    <div>Tempo <b>${rec.tempo.toFixed(1)}</b></div>
    <div>Década <b>${rec.decade}s</b></div>
    <div>Estreno <b>${rec.release_date}</b></div>
    <div>Duración <b>${durStr}</b></div>`);
  drawRadar(rec, i);
};
d3.select("#detailClose").on("click", () => d3.select("#detail").classed("hidden", true));

function drawRadar(rec, i){
  const svg = d3.select("#dRadar");
  svg.selectAll("*").remove();
  const W = svg.node().clientWidth || 260, H = 200, cx = W/2, cy = H/2 + 6, R = 72;
  const feats = App.features;
  const ang = (k) => (Math.PI*2*k/feats.length) - Math.PI/2;
  const g = svg.append("g");
  [0.25,0.5,0.75,1].forEach(r=>{
    g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",R*r)
      .attr("fill","none").attr("stroke","var(--line)").attr("stroke-width",.5);
  });
  feats.forEach((f,k)=>{
    const x=cx+Math.cos(ang(k))*R, y=cy+Math.sin(ang(k))*R;
    g.append("line").attr("x1",cx).attr("y1",cy).attr("x2",x).attr("y2",y)
      .attr("stroke","var(--line)").attr("stroke-width",.5);
    const lx=cx+Math.cos(ang(k))*(R+12), ly=cy+Math.sin(ang(k))*(R+12);
    g.append("text").attr("x",lx).attr("y",ly).attr("text-anchor","middle")
      .attr("dominant-baseline","middle").attr("fill","var(--ink-faint)")
      .attr("font-size","8px").attr("font-family","Montserrat")
      .text(App.featureLabels[f].slice(0,4));
  });
  const pts = feats.map((f,k)=>{
    const v = rec[f+"_n"];
    return [cx+Math.cos(ang(k))*R*v, cy+Math.sin(ang(k))*R*v];
  });
  const color = App.colorOf(i);
  g.append("path").attr("d", d3.line()(pts)+"Z")
    .attr("fill", color).attr("fill-opacity",.25)
    .attr("stroke", color).attr("stroke-width",1.5);
  pts.forEach(p=> g.append("circle").attr("cx",p[0]).attr("cy",p[1]).attr("r",2.5).attr("fill",color));
}
