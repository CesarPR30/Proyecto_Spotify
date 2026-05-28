/* ============================================================
   boot.js — fetches the three payloads (meta JSON, records binary,
   text JSON), decodes the binary into typed arrays, wires the
   global controls, then initialises every view.
   ============================================================ */
(async function boot(){
  const loaderMsg = document.querySelector("#loader p");
  function setMsg(t){ if (loaderMsg) loaderMsg.textContent = t; }

  let meta, bin, text;
  try {
    setMsg("Obteniendo metadatos…");
    const [metaRes, binRes, textRes] = await Promise.all([
      fetch("/api/meta"),
      fetch("/api/records.bin"),
      fetch("/api/records.json"),
    ]);
    setMsg("Decodificando 170k canciones…");
    meta = await metaRes.json();
    bin = await binRes.arrayBuffer();
    text = await textRes.json();
  } catch(e){
    document.getElementById("loader").innerHTML =
      "<p style='color:#ff7a59;font-family:Montserrat'>No se pudieron cargar los datos. ¿Está corriendo el servidor Flask?</p>";
    console.error(e);
    return;
  }

  // ---- decode binary records ----
  // Layout (per record, RECORD_BYTES bytes): see app.py for the canonical map.
  //   0..16  f32 ×4  pca_x, pca_y, umap_x, umap_y
  //   16..24 u8  ×8  features 0..255
  //   24     u8 popularity
  //   25     u8 decade_idx
  //   26     u8 collab
  //   27     u8 key
  //   28     u8 mode
  //   29     u8 explicit
  //   30..32 u16 year
  //   32..34 u16 tempo*10
  //   36..40 u32 duration_ms
  const RB = meta.record_bytes;
  const n = meta.n;
  if (bin.byteLength !== n * RB){
    console.error(`Binary payload size mismatch: ${bin.byteLength} vs ${n*RB}`);
  }
  const u8 = new Uint8Array(bin);
  const dv = new DataView(bin);

  // De-interleave fields into separate typed arrays for fast iteration.
  const pca = new Float32Array(n*2);
  const umap = new Float32Array(n*2);
  const feats01 = new Float32Array(n*8);
  const featsRaw = new Float32Array(n*8);
  const popularity = new Uint8Array(n);
  const decadeIdx = new Uint8Array(n);
  const collab = new Uint8Array(n);
  const key = new Uint8Array(n);
  const mode = new Uint8Array(n);
  const explicit = new Uint8Array(n);
  const year = new Uint16Array(n);
  const tempo = new Float32Array(n);
  const duration = new Uint32Array(n);

  // Pre-compute raw-feature scaling: raw = min + n01 * (max - min)
  const featMin = new Float32Array(8), featMax = new Float32Array(8);
  meta.features.forEach((f, k) => {
    featMin[k] = meta.ranges[f][0];
    featMax[k] = meta.ranges[f][1];
  });

  // Endian: ArrayBuffer reads as little-endian when using DataView with
  // littleEndian=true. numpy on x86 produces little-endian, which matches.
  const LE = true;
  for (let i = 0; i < n; i++){
    const o = i * RB;
    pca[i*2]    = dv.getFloat32(o + 0,  LE);
    pca[i*2+1]  = dv.getFloat32(o + 4,  LE);
    umap[i*2]   = dv.getFloat32(o + 8,  LE);
    umap[i*2+1] = dv.getFloat32(o + 12, LE);
    for (let k = 0; k < 8; k++){
      const q = u8[o + 16 + k] / 255;
      feats01[i*8 + k] = q;
      featsRaw[i*8 + k] = featMin[k] + q * (featMax[k] - featMin[k]);
    }
    popularity[i] = u8[o + 24];
    decadeIdx[i]  = u8[o + 25];
    collab[i]     = u8[o + 26];
    key[i]        = u8[o + 27];
    mode[i]       = u8[o + 28];
    explicit[i]   = u8[o + 29];
    year[i]       = dv.getUint16(o + 30, LE);
    tempo[i]      = dv.getUint16(o + 32, LE) / 10;
    duration[i]   = dv.getUint32(o + 36, LE);
  }

  // Convert text artist-index from {name: [ids]} to Map<name, Uint32Array>
  const artistToIds = new Map();
  for (const [name, ids] of Object.entries(text.artist_to_ids)){
    artistToIds.set(name, Uint32Array.from(ids));
  }

  // ---- install on App ----
  App.meta = meta;
  App.n = n;
  App.features = meta.features;
  App.featureLabels = meta.feature_labels;
  App.coords.pca = pca;
  App.coords.umap = umap;
  App.feats01 = feats01;
  App.feats = featsRaw;
  App.popularity = popularity;
  App.decadeIdx = decadeIdx;
  App.collab = collab;
  App.key = key;
  App.mode = mode;
  App.explicit = explicit;
  App.year = year;
  App.tempo = tempo;
  App.duration = duration;
  App.names = text.names;
  App.artistsStr = text.artists;
  App.releaseDates = text.release_dates || [];
  App.artistToIds = artistToIds;

  // Initial filter mask (everything passes)
  App.rebuildFilterMask();

  d3.select("#trackCount").text(n.toLocaleString());
  d3.select("#dataNote").text(`${n.toLocaleString()} canciones · 8 características de audio · dataset completo`);

  /* ---- decade chips ---- */
  const chips = d3.select("#decadeFilter");
  meta.decades.forEach(dd=>{
    chips.append("div").attr("class","chip on")
      .style("background", App.decadeColor(dd))
      .style("color","#000")
      .text(`${dd}s`)
      .on("click", function(){
        const on = !d3.select(this).classed("on");
        d3.select(this).classed("on", on);
        if (on){ d3.select(this).style("background",App.decadeColor(dd)).style("color","#000"); }
        else   { d3.select(this).style("background","var(--surface)").style("color","var(--ink-faint)"); }
        recomputeDecadeFilter();
      });
  });
  function recomputeDecadeFilter(){
    const included = new Set();
    chips.selectAll(".chip").each(function(_,i){
      if (d3.select(this).classed("on")) included.add(meta.decades[i]);
    });
    App.activeDecades = included.size===meta.decades.length ? new Set() : included;
    App.refresh();
  }

  /* ---- collab filter chips ---- */
  d3.select("#collabFilter").selectAll(".chip").on("click", function(){
    d3.select("#collabFilter").selectAll(".chip").classed("on", false);
    d3.select(this).classed("on", true);
    const val = d3.select(this).attr("data-collab");
    App.collabFilter = val === "solo" ? 0 : val === "collab" ? 1 : null;
    App.refresh();
  });

  /* ---- popularity dual-range slider ---- */
  function updatePopTrack(){
    const left  = App.popMin;
    const right = App.popMax;
    d3.select("#popTrackFill")
      .style("left",  left  + "%")
      .style("width", (right - left) + "%");
  }
  updatePopTrack();

  d3.select("#popMinSlider").on("input", function(){
    let v = +this.value;
    if (v > App.popMax) v = App.popMax;
    this.value = v;
    App.popMin = v;
    d3.select("#popMinVal").text(v);
    updatePopTrack();
    App.refresh();
  });
  d3.select("#popMaxSlider").on("input", function(){
    let v = +this.value;
    if (v < App.popMin) v = App.popMin;
    this.value = v;
    App.popMax = v;
    d3.select("#popMaxVal").text(v);
    updatePopTrack();
    App.refresh();
  });

  /* ---- artist search ---- */
  const artists = meta.artists || [];       // top 5000, by track count
  const input = d3.select("#artistInput");
  const dropdown = d3.select("#artistDropdown");
  const activeBox = d3.select("#artistActive");

  function renderDropdown(query){
    const q = (query || "").trim().toLowerCase();
    const matches = (q
      ? artists.filter(a => a.name.toLowerCase().includes(q))
      : artists
    ).slice(0, 40);
    dropdown.selectAll("*").remove();
    if (!matches.length){
      dropdown.append("div").attr("class","artist-opt")
        .style("cursor","default")
        .append("span").attr("class","a-name").style("color","var(--ink-faint)")
        .text("No se encontraron artistas");
    } else {
      matches.forEach(a=>{
        const isSel = App.artistFilter.has(a.name);
        const opt = dropdown.append("div")
          .attr("class", isSel ? "artist-opt a-selected" : "artist-opt")
          .on("mousedown", (ev)=>{ ev.preventDefault(); toggleArtist(a.name); });
        opt.append("span").attr("class","a-check").text(isSel ? "✓" : "");
        opt.append("span").attr("class","a-name").text(a.name);
        opt.append("span").attr("class","a-count").text(`${a.count} ${a.count>1?"canciones":"canción"}`);
      });
    }
    dropdown.classed("open", true);
  }

  function renderArtistTags(){
    activeBox.selectAll("*").remove();
    if (App.artistFilter.size === 0){ activeBox.style("display","none"); return; }
    activeBox.style("display","flex");
    App.artistFilter.forEach(name => {
      const tag = activeBox.append("div").attr("class","artist-tag");
      tag.append("span").text(name);
      tag.append("button").attr("title","Quitar").text("×")
        .on("click", ()=>{ App.artistFilter.delete(name); renderArtistTags(); renderDropdown(input.property("value")); App.refresh(); });
    });
    if (App.artistFilter.size > 1){
      activeBox.append("button").attr("class","artist-clear-all").text("Limpiar")
        .on("click", ()=>{ App.artistFilter.clear(); renderArtistTags(); renderDropdown(input.property("value")); App.refresh(); });
    }
  }
  function toggleArtist(name){
    if (App.artistFilter.has(name)) App.artistFilter.delete(name);
    else App.artistFilter.add(name);
    renderDropdown(input.property("value"));
    renderArtistTags();
    App.refresh();
  }
  input.on("focus", function(){ renderDropdown(this.value); })
       .on("input", function(){ renderDropdown(this.value); })
       .on("blur", function(){ setTimeout(()=>dropdown.classed("open", false), 150); });

  /* ---- color mode ---- */
  d3.select("#colorMode").selectAll("button").on("click", function(){
    d3.select("#colorMode").selectAll("button").classed("active",false);
    d3.select(this).classed("active",true);
    App.colorMode = this.dataset.mode;
    App.refresh();
  });

  /* ---- projection mode ---- */
  d3.select("#projMode").selectAll("button").on("click", function(){
    d3.select("#projMode").selectAll("button").classed("active",false);
    d3.select(this).classed("active",true);
    App.projMode = this.dataset.p;
    if (App.onProjChange) App.onProjChange();
  });

  /* ---- pcp scaling: fixed to Min–Max ---- */
  App.pcpScale = "minmax";

  /* ---- reset ---- */
  d3.select("#resetBtn").on("click", ()=>{
    App.activeDecades = new Set(); App.popMin = 0; App.popMax = 100; App.brushMask = null;
    App.collabFilter = null;
    d3.select("#collabFilter").selectAll(".chip").classed("on", false);
    d3.select("#collabFilter").select("[data-collab='all']").classed("on", true);
    App.artistFilter.clear();
    renderArtistTags();
    d3.select("#artistInput").property("value","");
    d3.select("#popMinSlider").property("value", 0);  d3.select("#popMinVal").text("0");
    d3.select("#popMaxSlider").property("value", 100); d3.select("#popMaxVal").text("100");
    updatePopTrack();
    chips.selectAll(".chip").classed("on",true).each(function(_,i){
      d3.select(this).style("background",App.decadeColor(meta.decades[i])).style("color","#000");
    });
    App.refresh();
  });

  /* ---- init all views ---- */
  setMsg("Construyendo visualizaciones de 170,000 puntos…");
  // Defer a tick so the loader message paints before view init blocks the thread.
  await new Promise(r => setTimeout(r, 30));

  initRadViz();
  initStar();
  initProjection();
  initParallel();
  initCorrelation();
  initDistribution();

  App.updateLegend();
  App.refresh();

  // hide loader
  setTimeout(()=> d3.select("#loader").classed("gone",true), 350);
})();
