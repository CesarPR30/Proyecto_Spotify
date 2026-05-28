/* ============================================================
   projection.js — Dimensionality-reduction scatter (canvas).
   PCA / UMAP coordinates are pre-computed server-side. The dot
   cloud (170k points) is painted to a <canvas>; an SVG overlay
   on top handles the box brush, biplot arrows and hover marker.
   Hover hit-testing uses a d3.quadtree built per projection mode.
   ============================================================ */
function initProjection(){
  const panel = document.getElementById("panel-proj");
  const body = panel.querySelector(".panel-body");
  const canvas = body.querySelector("canvas#projCanvas");
  const svg = body.querySelector("svg#projSvg");

  const setup = App.setupCanvas(canvas);
  let { ctx, W, H } = setup;
  const m = 30;
  const sx = d3.scaleLinear().domain([0,1]).range([m, W-m]);
  const sy = d3.scaleLinear().domain([0,1]).range([H-m, m]);

  // Pixel coordinates for each track in each projection (cached).
  // Float32Array(2n) interleaved x,y.
  const pixels = { pca: null, umap: null };
  function rebuildPixels(){
    const n = App.n;
    for (const mode of ["pca", "umap"]){
      const src = App.coords[mode];
      const out = new Float32Array(n*2);
      for (let i = 0; i < n; i++){
        out[i*2]   = sx(src[i*2]);
        out[i*2+1] = sy(src[i*2+1]);
      }
      pixels[mode] = out;
    }
  }
  rebuildPixels();

  // Quadtree for hover hit-testing, per projection mode.
  const qtrees = { pca: null, umap: null };
  function rebuildQuadtree(mode){
    const px = pixels[mode];
    const n = App.n;
    const tree = d3.quadtree()
      .x(i => px[i*2])
      .y(i => px[i*2+1]);
    // Add by index for O(1) record access on hover.
    const ids = new Array(n);
    for (let i = 0; i < n; i++) ids[i] = i;
    tree.addAll(ids);
    qtrees[mode] = tree;
  }
  rebuildQuadtree("pca");
  rebuildQuadtree("umap");

  /* ---- SVG overlay: brush + biplot + hover marker ---- */
  const d3svg = d3.select(svg);
  d3svg.attr("width", W).attr("height", H);
  const overlayG = d3svg.append("g");
  // biplot/hover layers are decorative — must not absorb mouse events,
  // otherwise the brush gesture gets blocked over arrows.
  const biplotG = d3svg.append("g").attr("pointer-events", "none");
  const hoverG = d3svg.append("g").attr("pointer-events", "none");

  // Arrowhead marker for biplot.
  const defs = d3svg.append("defs");
  defs.append("marker").attr("id","arrh").attr("viewBox","0 0 10 10")
    .attr("refX",8).attr("refY",5).attr("markerWidth",8).attr("markerHeight",8)
    .attr("orient","auto-start-reverse")
    .append("path").attr("d","M0,0L10,5L0,10z").attr("fill","#000000");

  function drawCanvas(){
    const px = pixels[App.projMode];
    App.drawPointsCanvas(ctx, W, H, px, { dimAlpha: .035, selAlpha: .55, dimSize: 1, selSize: 2 });
  }

  function drawBiplot(){
    biplotG.selectAll("*").remove();
    const show = App.projMode==="pca" && d3.select("#biplotChk").property("checked");
    if (!show) return;
    const load = App.meta.pca_loadings;
    const maxabs = d3.max(load.flat().map(Math.abs)) || 1;
    const cx = sx(0.5), cy = sy(0.5);
    const scaleArr = (Math.min(W,H)/2 - m) * 0.9;
    App.features.forEach((f,i)=>{
      const ex = cx + (load[i][0]/maxabs)*scaleArr;
      const ey = cy - (load[i][1]/maxabs)*scaleArr;
      biplotG.append("line").attr("x1",cx).attr("y1",cy).attr("x2",ex).attr("y2",ey)
        .attr("stroke","#000000").attr("stroke-width",1.5).attr("opacity",.85)
        .attr("marker-end","url(#arrh)");
      biplotG.append("text").attr("x",ex).attr("y",ey)
        .attr("dx", load[i][0]>=0?4:-4).attr("dy",ey<cy?-3:10)
        .attr("text-anchor", load[i][0]>=0?"start":"end")
        .attr("fill","#b3b3b3").attr("font-size","11px").attr("font-family","Montserrat")
        .attr("font-weight","700")
        .attr("stroke","#000").attr("stroke-width",1.5)
        .attr("stroke-linejoin","round").attr("paint-order","stroke")
        .text(App.featureLabels[f]);
    });
  }

  /* ---- brushing (box-brush over the canvas via SVG overlay) ---- */
  const brush = d3.brush().extent([[0,0],[W,H]])
    .on("brush end", (ev)=>{
      if (!ev.selection){ App.setBrush(null); return; }
      const [[x0,y0],[x1,y1]] = ev.selection;
      const px = pixels[App.projMode];
      const n = App.n;
      const mask = new Uint8Array(n);
      // Iterate quadtree.visit for speed: only visit nodes overlapping the rect.
      qtrees[App.projMode].visit((node, nx0, ny0, nx1, ny1) => {
        if (nx0 > x1 || nx1 < x0 || ny0 > y1 || ny1 < y0) return true; // skip
        if (!node.length){
          do {
            const i = node.data;
            const x = px[i*2], y = px[i*2+1];
            if (x>=x0 && x<=x1 && y>=y0 && y<=y1) mask[i] = 1;
          } while ((node = node.next));
        }
        return false;
      });
      App.setBrush(mask);
    });
  const brushG = overlayG.append("g").attr("class","brush").call(brush);

  /* ---- hover: closest filter-passing track within radius ---- */
  let lastHover = -1;
  function pickAt(pt){
    const tree = qtrees[App.projMode];
    const px = pixels[App.projMode];
    return App.findFilteredPoint(tree, i=>px[i*2], i=>px[i*2+1], pt[0], pt[1], 14);
  }
  d3svg.on("mousemove", function(ev){
    const pt = d3.pointer(ev, this);
    const i = pickAt(pt);
    if (i !== -1){
      if (i !== lastHover){
        lastHover = i;
        App.setHover(i);
        App.tip.show(App.trackTip(App.recAt(i)), ev);
      } else {
        App.tip.move(ev);
      }
    } else if (lastHover !== -1){
      lastHover = -1; App.setHover(-1); App.tip.hide();
    }
  }).on("mouseleave", function(){
    if (lastHover !== -1){ lastHover = -1; App.setHover(-1); App.tip.hide(); }
  }).on("click", function(ev){
    const pt = d3.pointer(ev, this);
    const i = pickAt(pt);
    if (i !== -1) App.showDetail(i);
  });

  function drawHoverMarker(){
    hoverG.selectAll("*").remove();
    const i = App.hovered;
    if (i < 0) return;
    const px = pixels[App.projMode];
    hoverG.append("circle")
      .attr("cx", px[i*2]).attr("cy", px[i*2+1])
      .attr("r", 5).attr("fill", App.colorOf(i))
      .attr("stroke", "#fff").attr("stroke-width", 1.5)
      .attr("pointer-events", "none");
  }

  function info(){
    const p = App.projMode;
    if (p==="pca"){
      const v = App.meta.pca_variance;
      d3.select("#projInfo").text(`PC1 ${v[0]}% · PC2 ${v[1]}% varianza · ${App.n.toLocaleString()} canciones`);
    } else {
      d3.select("#projInfo").text(`UMAP · n_neighbors 15 · min_dist 0.1 · ${App.n.toLocaleString()} canciones`);
    }
  }

  App.onProjChange = ()=>{ drawCanvas(); drawBiplot(); drawHoverMarker(); info(); };
  d3.select("#biplotChk").on("change", drawBiplot);

  drawCanvas(); drawBiplot(); info();
  App.registerView(drawCanvas);
  App.registerHoverView(drawHoverMarker);
}
