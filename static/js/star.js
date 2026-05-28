/* ============================================================
   star.js — Star Coordinates with draggable, weighted axes
   (canvas-based for 170k tracks). Drag an axis handle to change
   its direction (angle) & length (weight); the cloud re-projects
   live. Double-click an axis to reset it. Hover on a track uses
   a quadtree rebuilt after each layout change.
   ============================================================ */
function initStar(){
  const panel = document.getElementById("panel-star");
  const body = panel.querySelector(".panel-body");
  const canvas = body.querySelector("canvas#starCanvas");
  const svg = body.querySelector("svg#starSvg");

  const { ctx, W, H } = App.setupCanvas(canvas);
  const cx = W/2, cy = H/2;
  const baseLen = Math.min(W,H)/2 - 60;

  const feats = App.features;
  function defaultAxes(){
    return feats.map((f,i)=>({
      f, angle: (Math.PI*2*i/feats.length) - Math.PI/2, weight: 0.62,
    }));
  }
  let axes = defaultAxes();

  const px = new Float32Array(App.n * 2);
  let tree = null;

  function reproject(){
    const n = App.n, fcount = feats.length;
    const f01 = App.feats01;
    // Precompute axis vector for each feature.
    const vx = new Float32Array(fcount), vy = new Float32Array(fcount);
    for (let k = 0; k < fcount; k++){
      vx[k] = Math.cos(axes[k].angle)*baseLen*axes[k].weight;
      vy[k] = Math.sin(axes[k].angle)*baseLen*axes[k].weight;
    }
    for (let i = 0; i < n; i++){
      let x = cx, y = cy;
      const base = i * fcount;
      for (let k = 0; k < fcount; k++){
        const v = f01[base + k];
        x += vx[k]*v; y += vy[k]*v;
      }
      px[i*2] = x; px[i*2+1] = y;
    }
    drawCanvas();
    drawAxes();
    drawHover();
  }

  function rebuildTree(){
    tree = d3.quadtree().x(i=>px[i*2]).y(i=>px[i*2+1]);
    for (let i = 0; i < App.n; i++) tree.add(i);
  }

  function drawCanvas(){
    App.drawPointsCanvas(ctx, W, H, px, { dimAlpha: .035, selAlpha: .58 });
  }

  /* ---- SVG overlay: axes + handles + hover ---- */
  const d3svg = d3.select(svg).attr("width", W).attr("height", H);
  const axesLinkG = d3svg.append("g");
  const axesHandleG = d3svg.append("g");
  const hoverG = d3svg.append("g");

  function drawAxes(){
    // lines
    const lines = axesLinkG.selectAll("line").data(axes);
    lines.join("line")
      .attr("class","axis-line")
      .attr("x1",cx).attr("y1",cy)
      .attr("x2",d=>cx + Math.cos(d.angle)*baseLen*d.weight)
      .attr("y2",d=>cy + Math.sin(d.angle)*baseLen*d.weight)
      .attr("stroke","var(--line)").attr("stroke-width",1);

    // handles
    const hg = axesHandleG.selectAll("g.ax").data(axes);
    const hgEnter = hg.enter().append("g").attr("class","ax star-axis");
    hgEnter.append("circle").attr("class","star-handle").attr("r",6)
      .attr("fill","var(--green)").attr("stroke","var(--bg)").attr("stroke-width",2);
    hgEnter.append("text").attr("class","anchor-label").attr("font-size","10px");
    const hgAll = hgEnter.merge(hg);
    hgAll.attr("transform",d=>`translate(${cx+Math.cos(d.angle)*baseLen*d.weight},${cy+Math.sin(d.angle)*baseLen*d.weight})`);
    hgAll.select("text")
      .attr("text-anchor", d => Math.cos(d.angle)>0?"start":"end")
      .attr("dx", d => Math.cos(d.angle)>0?9:-9).attr("dy",4)
      .text(d=>App.featureLabels[d.f]);

    hgAll.call(d3.drag()
      .on("start", function(){ d3.select(this).select("circle").attr("r",8); })
      .on("drag", function(ev,d){
        const dx = ev.x - cx, dy = ev.y - cy;
        d.angle = Math.atan2(dy, dx);
        d.weight = Math.max(0.05, Math.min(1.3, Math.hypot(dx,dy)/baseLen));
        reproject();
      })
      .on("end", function(){
        d3.select(this).select("circle").attr("r",6);
        rebuildTree();
      })
    );
    hgAll.on("dblclick", function(ev,d){
      const i = feats.indexOf(d.f);
      d.angle = (Math.PI*2*i/feats.length) - Math.PI/2; d.weight = 0.62;
      reproject(); rebuildTree();
    });
  }

  /* ---- hover via filter-aware quadtree pick ---- */
  let lastHover = -1;
  const pickAt = (pt) => tree
    ? App.findFilteredPoint(tree, i=>px[i*2], i=>px[i*2+1], pt[0], pt[1], 12)
    : -1;
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
      .attr("pointer-events","none");
  }

  /* ---- controls ---- */
  d3.select("#starReset").on("click", ()=>{ axes = defaultAxes(); reproject(); rebuildTree(); });
  let spinning = false, timer=null;
  d3.select("#starSpin").on("click", function(){
    spinning = !spinning;
    d3.select(this).style("color", spinning?"var(--green)":null)
      .style("border-color", spinning?"var(--green)":null);
    if (spinning){
      // Don't rebuild quadtree during spin (would be too expensive); rebuild at end.
      timer = d3.timer(()=>{ axes.forEach((a,i)=> a.angle += 0.004*(1+i*0.05)); reproject(); });
    } else if (timer){ timer.stop(); rebuildTree(); }
  });

  reproject(); rebuildTree();
  App.registerView(drawCanvas);
  App.registerHoverView(drawHover);
}
