/* ============================================================
   parallel.js — Parallel Coordinates (canvas) for 170k tracks.
   The polylines are stroked into a <canvas> with very low alpha
   so density emerges as a visible "flow map". An SVG overlay
   handles axes, ticks, per-axis brushes, drag-to-reorder, hover.
   Raw vs Min–Max only changes tick labels (the y pixel positions
   are identical since each axis already fills its column).
   ============================================================ */
function initParallel(){
  const panel = document.getElementById("panel-pcp");
  const body = panel.querySelector(".panel-body");
  const canvas = body.querySelector("canvas#pcpCanvas");
  const svg = body.querySelector("svg#pcpSvg");

  // Layout uses panel-body inner box for both canvas and SVG.
  const rect = body.getBoundingClientRect();
  const W = Math.floor(rect.width) - 16;
  const H = Math.floor(rect.height) - 16;
  const m = {t:24, r:16, b:26, l:34};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  // Size canvas (offset by m.l/m.t so we can draw in axis-local coords).
  // +8 matches the SVG's CSS left/top:8px so canvas and SVG axes align.
  canvas.style.left = (m.l + 8) + "px";
  canvas.style.top = (m.t + 8) + "px";
  canvas.style.position = "absolute";
  canvas.style.width = iw + "px";
  canvas.style.height = ih + "px";
  const dpr = window.devicePixelRatio || 1;
  canvas.width = iw * dpr;
  canvas.height = ih * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let dims = App.features.slice();
  const fcount = App.features.length;

  // Per-axis pixel-y for each track. Float32Array(n * fcount), indexed
  // by [feature_idx_in_App.features * n + i]. We compute from feats01 once.
  const ys = new Float32Array(App.n * fcount);
  for (let k = 0; k < fcount; k++){
    const off = k * App.n;
    for (let i = 0; i < App.n; i++){
      ys[off + i] = ih - App.feats01[i*fcount + k] * ih;
    }
  }

  // x scale (re-derived from dims order after each reorder)
  let x = d3.scalePoint().domain(dims).range([0, iw]).padding(0.06);

  // y scales for axis ticks (raw or minmax). Pixel positions are the same.
  const yRaw = {}, yNorm = {};
  App.features.forEach((f, k) => {
    const rng = App.meta.ranges[f];
    yRaw[f] = d3.scaleLinear().domain(rng).range([ih, 0]);
    yNorm[f] = d3.scaleLinear().domain([0,1]).range([ih, 0]);
  });
  const yScaleFor = (f) => App.pcpScale === "raw" ? yRaw[f] : yNorm[f];

  /* ---- SVG overlay (axes + brushes + hover) ---- */
  const d3svg = d3.select(svg)
    .attr("width", W).attr("height", H);
  const root = d3svg.append("g").attr("transform",`translate(${m.l},${m.t})`);
  const axesG = root.append("g");
  const hoverG = root.append("g");

  // per-axis brush extents in pixel space, keyed by feature name.
  const brushes = {};

  function applyBrush(){
    const active = Object.keys(brushes);
    if (!active.length){ App.setBrush(null); return; }
    const n = App.n;
    const mask = new Uint8Array(n);
    // For each track, all active axis brushes must include it.
    outer: for (let i = 0; i < n; i++){
      for (let ai = 0; ai < active.length; ai++){
        const f = active[ai];
        const k = App.features.indexOf(f);
        const [y0, y1] = brushes[f];
        const yy = ys[k * n + i];
        if (yy < y0 || yy > y1) continue outer;
      }
      mask[i] = 1;
    }
    App.setBrush(mask);
  }

  function drawAxes(){
    x.domain(dims);
    const axG = axesG.selectAll("g.dim").data(dims, d=>d);
    axG.exit().remove();
    const enter = axG.enter().append("g").attr("class","dim pcp-axis");
    enter.append("g").attr("class","scale");
    enter.append("text").attr("class","axis-title anchor-label")
      .attr("y",-10).attr("text-anchor","middle").style("cursor","grab");
    enter.append("g").attr("class","brush");

    const all = enter.merge(axG);
    all.attr("transform", d=>`translate(${x(d)},0)`);
    all.select("text.axis-title").text(d=>App.featureLabels[d]);

    all.select("g.scale").each(function(f){
      d3.select(this).call(d3.axisLeft(yScaleFor(f)).ticks(5).tickSize(0))
        .call(g=>g.select(".domain").attr("stroke","var(--line)"))
        .call(g=>g.selectAll("text").attr("fill","var(--ink-faint)").attr("font-size","9px"));
    });

    all.select("g.brush").each(function(f){
      const b = d3.brushY().extent([[-9,0],[9,ih]])
        .on("brush end", (ev)=>{
          if (ev.selection){ brushes[f] = ev.selection; }
          else { delete brushes[f]; }
          applyBrush();
        });
      // Only attach a brush if this axis doesn't already have one
      // (otherwise re-attaching would clear the current selection).
      if (!d3.select(this).select(".overlay").size()){
        d3.select(this).call(b);
      }
    });

    // drag-to-reorder axes via title
    all.select("text.axis-title").call(d3.drag()
      .on("start", function(ev, f){
        d3.select(this).style("cursor","grabbing").classed("hot",true);
        this._dragStartX = x(f);
      })
      .on("drag", function(ev, f){
        const sx = Math.max(0, Math.min(iw, this._dragStartX + ev.x));
        dims.sort((a,b)=> (a===f?sx:x(a)) - (b===f?sx:x(b)));
        x.domain(dims);
        axesG.selectAll("g.dim").attr("transform", d=> d===f
          ? `translate(${sx},0)` : `translate(${x(d)},0)`);
        // Live-redraw canvas during drag (cheap-ish; sub-second)
        drawCanvas();
      })
      .on("end", function(ev, f){
        d3.select(this).style("cursor","grab").classed("hot",false);
        x.domain(dims);
        drawAxes(); drawCanvas();
      })
    );
  }

  /* ---- canvas paint: 170k polylines, bucketed by color ----
     Hides any track that fails the filter. With an active brush, also
     paints filter-passing-not-brushed in a faint context layer. */
  function drawCanvas(){
    ctx.clearRect(0, 0, iw, ih);
    const n = App.n;
    const dimsIdx = dims.map(d => App.features.indexOf(d));
    const dimsX = dims.map(d => x(d));
    const f = App.filterMask, b = App.brushMask;
    const { colors, buckets } = App.palette();
    // Auto-tune alpha to filter size so a small selection still reads strongly.
    const filterCount = App.filterMask.reduce((s, v) => s + v, 0);
    const baseAlpha = filterCount < 200 ? 0.85
                    : filterCount < 2000 ? 0.45
                    : filterCount < 20000 ? 0.25
                    : 0.18;

    if (!b){
      // No brush: only filter-passing tracks, per color bucket.
      ctx.lineWidth = filterCount < 2000 ? 1.2 : 0.8;
      ctx.globalAlpha = baseAlpha;
      for (let bi = 0; bi < colors.length; bi++){
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < n; i++){
          if (buckets[i] !== bi) continue;
          if (f[i] === 0) continue;
          let k = dimsIdx[0];
          ctx.moveTo(dimsX[0], ys[k * n + i]);
          for (let j = 1; j < dimsIdx.length; j++){
            k = dimsIdx[j];
            ctx.lineTo(dimsX[j], ys[k * n + i]);
          }
          any = true;
        }
        if (any){ ctx.strokeStyle = colors[bi]; ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
      return;
    }

    // Brush active: dim filter-passing-not-brushed first
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = Math.min(baseAlpha * 0.15, 0.04);
    for (let bi = 0; bi < colors.length; bi++){
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++){
        if (buckets[i] !== bi) continue;
        if (f[i] === 0 || b[i] === 1) continue;
        let k = dimsIdx[0];
        ctx.moveTo(dimsX[0], ys[k * n + i]);
        for (let j = 1; j < dimsIdx.length; j++){
          k = dimsIdx[j];
          ctx.lineTo(dimsX[j], ys[k * n + i]);
        }
        any = true;
      }
      if (any){ ctx.strokeStyle = colors[bi]; ctx.stroke(); }
    }
    // Brushed tracks bright
    ctx.lineWidth = filterCount < 2000 ? 1.2 : 0.8;
    ctx.globalAlpha = baseAlpha;
    for (let bi = 0; bi < colors.length; bi++){
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++){
        if (buckets[i] !== bi) continue;
        if (f[i] === 0 || b[i] === 0) continue;
        let k = dimsIdx[0];
        ctx.moveTo(dimsX[0], ys[k * n + i]);
        for (let j = 1; j < dimsIdx.length; j++){
          k = dimsIdx[j];
          ctx.lineTo(dimsX[j], ys[k * n + i]);
        }
        any = true;
      }
      if (any){ ctx.strokeStyle = colors[bi]; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- hover: find nearest axis, then binary-search the closest y on that axis ---- */
  // Per-axis sorted indices of tracks by y (so we can do log-n nearest lookup).
  const sortedIdxByAxis = [];   // sortedIdxByAxis[k] = Uint32Array (n) sorted by ys[k*n+i]
  for (let k = 0; k < fcount; k++){
    const off = k * App.n;
    const idx = new Uint32Array(App.n);
    for (let i = 0; i < App.n; i++) idx[i] = i;
    // Sort by y at this axis
    Array.prototype.sort.call(idx, (a,b) => ys[off+a] - ys[off+b]);
    sortedIdxByAxis.push(idx);
  }

  function findHover(mx, my){
    // Closest axis (by x distance)
    let bestAx = 0, bestAxDist = Infinity;
    for (let j = 0; j < dims.length; j++){
      const xx = x(dims[j]);
      const d = Math.abs(xx - mx);
      if (d < bestAxDist){ bestAxDist = d; bestAx = j; }
    }
    if (bestAxDist > 30) return -1;
    const k = App.features.indexOf(dims[bestAx]);
    const off = k * App.n;
    const idx = sortedIdxByAxis[k];
    // binary search the track with y closest to my
    let lo = 0, hi = idx.length - 1;
    while (lo < hi){
      const mid = (lo + hi) >>> 1;
      if (ys[off + idx[mid]] < my) lo = mid + 1;
      else hi = mid;
    }
    // Try a small neighborhood around lo to find a track that passes the filter
    let best = -1, bestDy = 4;  // px tolerance
    for (let d = -50; d <= 50; d++){
      const j = lo + d;
      if (j < 0 || j >= idx.length) continue;
      const i = idx[j];
      if (!App.passesFilter(i)) continue;
      const dy = Math.abs(ys[off + i] - my);
      if (dy < bestDy){ bestDy = dy; best = i; }
    }
    return best;
  }

  let lastHover = -1;
  d3svg.on("mousemove", function(ev){
    const pt = d3.pointer(ev, root.node());
    const i = findHover(pt[0], pt[1]);
    if (i !== -1){
      if (i !== lastHover){
        lastHover = i; App.setHover(i);
        App.tip.show(App.trackTip(App.recAt(i)), ev);
      } else App.tip.move(ev);
    } else if (lastHover !== -1){
      lastHover = -1; App.setHover(-1); App.tip.hide();
    }
  }).on("mouseleave", ()=>{
    if (lastHover !== -1){ lastHover = -1; App.setHover(-1); App.tip.hide(); }
  }).on("click", function(ev){
    const pt = d3.pointer(ev, root.node());
    const i = findHover(pt[0], pt[1]);
    if (i !== -1) App.showDetail(i);
  });

  function drawHover(){
    hoverG.selectAll("*").remove();
    const i = App.hovered;
    if (i < 0) return;
    const n = App.n;
    const pts = dims.map(d => {
      const k = App.features.indexOf(d);
      return [x(d), ys[k * n + i]];
    });
    hoverG.append("path")
      .attr("d", d3.line()(pts))
      .attr("fill","none")
      .attr("stroke", App.colorOf(i))
      .attr("stroke-width", 2)
      .attr("pointer-events","none")
      .attr("stroke-dasharray", null);
  }

  function rescale(){
    axesG.selectAll("g.dim.pcp-axis").each(function(f){
      d3.select(this).select("g.scale")
        .call(d3.axisLeft(yScaleFor(f)).ticks(5).tickSize(0))
        .call(g => g.select(".domain").attr("stroke","var(--line)"))
        .call(g => g.selectAll("text")
          .attr("fill","var(--ink-faint)")
          .attr("font-size","9px"));
    });
  }
  App.onPcpScaleChange = rescale;

  drawAxes(); drawCanvas();
  App.registerView(drawCanvas);
  App.registerHoverView(drawHover);
}
