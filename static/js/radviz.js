/* ============================================================
   radviz.js — RadViz (dimensional anchoring) on canvas.
   Each feature anchor sits on the unit circle; each track lands
   at the normalised, weighted sum of anchor positions. With 170k
   tracks the cloud is painted to <canvas>; SVG handles the ring,
   anchors, hover marker, and anchor-hover highlight.
   ============================================================ */
function initRadViz(){
  const panel = document.getElementById("panel-radviz");
  const body = panel.querySelector(".panel-body");
  const canvas = body.querySelector("canvas#rvCanvas");
  const svg = body.querySelector("svg#rvSvg");

  const { ctx, W, H } = App.setupCanvas(canvas);
  const cx = W/2, cy = H/2;
  const R = Math.min(W, H)/2 - 56;

  const feats = App.features;
  const anchors = feats.map((f,i) => {
    const a = (Math.PI*2*i/feats.length) - Math.PI/2;
    return { f, a, x: cx + Math.cos(a)*R, y: cy + Math.sin(a)*R };
  });

  /* ---- pre-compute per-track pixel position ---- */
  const px = new Float32Array(App.n * 2);
  function computePositions(){
    const n = App.n;
    const fcount = feats.length;
    const f01 = App.feats01;
    const ax = new Float32Array(fcount);
    const ay = new Float32Array(fcount);
    for (let k = 0; k < fcount; k++){ ax[k] = anchors[k].x; ay[k] = anchors[k].y; }
    for (let i = 0; i < n; i++){
      let xs = 0, ys = 0, ws = 0;
      const base = i * fcount;
      for (let k = 0; k < fcount; k++){
        const w = f01[base + k];
        xs += ax[k] * w; ys += ay[k] * w; ws += w;
      }
      if (ws === 0){ px[i*2] = cx; px[i*2+1] = cy; }
      else        { px[i*2] = xs/ws; px[i*2+1] = ys/ws; }
    }
  }
  computePositions();

  const tree = d3.quadtree().x(i=>px[i*2]).y(i=>px[i*2+1]);
  for (let i = 0; i < App.n; i++) tree.add(i);

  /* ---- SVG overlay: ring, anchors, hover marker ---- */
  const d3svg = d3.select(svg).attr("width", W).attr("height", H);
  const g = d3svg.append("g");
  g.append("circle").attr("class","ring").attr("cx",cx).attr("cy",cy)
    .attr("r",R).attr("stroke-dasharray","2 4");
  const spokes = g.append("g");
  anchors.forEach(an=>{
    spokes.append("line").attr("x1",cx).attr("y1",cy).attr("x2",an.x).attr("y2",an.y)
      .attr("stroke","var(--line-soft)").attr("stroke-width",.5);
  });
  const hoverG = g.append("g");

  /* ---- canvas paint ---- */
  let anchorHotFeat = null;   // feature name currently being hovered (or null)
  function drawCanvas(){
    if (anchorHotFeat){
      // Anchor hovered: highlight tracks scoring >0.6 on this feature.
      // Non-filter tracks are NOT drawn at all.
      const fIdx = feats.indexOf(anchorHotFeat);
      const f01 = App.feats01;
      const f = App.filterMask;
      const n = App.n;
      const { colors, buckets } = App.palette();
      ctx.clearRect(0, 0, W, H);
      // Filter-passing but cold: faint context.
      ctx.globalAlpha = 0.12;
      for (let bi = 0; bi < colors.length; bi++){
        ctx.fillStyle = colors[bi];
        for (let i = 0; i < n; i++){
          if (buckets[i] !== bi) continue;
          if (f[i] === 0) continue;
          if (f01[i*8 + fIdx] > 0.6) continue;
          ctx.fillRect(px[i*2], px[i*2+1], 1, 1);
        }
      }
      // Filter-passing AND hot: bright highlight.
      ctx.globalAlpha = 0.9;
      for (let bi = 0; bi < colors.length; bi++){
        ctx.fillStyle = colors[bi];
        for (let i = 0; i < n; i++){
          if (buckets[i] !== bi) continue;
          if (f[i] === 0) continue;
          if (f01[i*8 + fIdx] <= 0.6) continue;
          ctx.fillRect(px[i*2]-1, px[i*2+1]-1, 2, 2);
        }
      }
      ctx.globalAlpha = 1;
      return;
    }
    App.drawPointsCanvas(ctx, W, H, px);
  }

  /* ---- anchors (interactive) ---- */
  const anchorG = g.append("g");
  const anchorNodes = anchorG.selectAll("g").data(anchors).join("g")
    .attr("transform", d=>`translate(${d.x},${d.y})`)
    .style("cursor","pointer")
    .on("mouseenter", function(ev,an){
      d3.select(this).select("text").classed("hot",true);
      d3.select(this).select("circle").attr("r",7).attr("fill","var(--green)");
      anchorHotFeat = an.f;
      drawCanvas();
    })
    .on("mouseleave", function(){
      d3.select(this).select("text").classed("hot",false);
      d3.select(this).select("circle").attr("r",4.5).attr("fill","var(--ink-faint)");
      anchorHotFeat = null;
      drawCanvas();
    });
  anchorNodes.append("circle").attr("r",4.5).attr("fill","var(--ink-faint)");
  anchorNodes.append("text")
    .attr("class","anchor-label")
    .attr("text-anchor", d => Math.abs(Math.cos(d.a))<.3 ? "middle" : (Math.cos(d.a)>0?"start":"end"))
    .attr("dx", d => Math.cos(d.a)>0 ? 9 : (Math.abs(Math.cos(d.a))<.3?0:-9))
    .attr("dy", d => Math.sin(d.a)>.3 ? 16 : (Math.sin(d.a)<-.3?-9:4))
    .text(d => App.featureLabels[d.f]);

  /* ---- hover: closest filter-passing track ---- */
  let lastHover = -1;
  const pickAt = (pt) => App.findFilteredPoint(
    tree, i=>px[i*2], i=>px[i*2+1], pt[0], pt[1], 12);
  d3svg.on("mousemove", function(ev){
    const pt = d3.pointer(ev, this);
    const i = pickAt(pt);
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
    const pt = d3.pointer(ev, this);
    const i = pickAt(pt);
    if (i !== -1) App.showDetail(i);
  });

  function drawHover(){
    hoverG.selectAll("*").remove();
    const i = App.hovered;
    if (i < 0) return;
    hoverG.append("circle")
      .attr("cx", px[i*2]).attr("cy", px[i*2+1])
      .attr("r", 5).attr("fill", App.colorOf(i))
      .attr("stroke", "#fff").attr("stroke-width", 1.5)
      .attr("pointer-events", "none");
  }

  drawCanvas();
  App.registerView(drawCanvas);
  App.registerHoverView(drawHover);
}
