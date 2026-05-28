/* ============================================================
   correlation.js — Pearson correlation matrix heatmap.
   With 170k tracks we don't recompute on every brush (that would
   stall the UI). Instead: show the cached full-dataset correlation
   by default, and recompute only when a brush is active AND its
   size is reasonable (<25k) on a debounce.
   ============================================================ */
function initCorrelation(){
  const svg = d3.select("#corr");
  const node = svg.node();
  const W = node.clientWidth, H = node.clientHeight;
  const n = App.features.length;
  const m = {t:18, r:56, b:88, l:112};
  const size = Math.min(W-m.l-m.r, H-m.t-m.b);
  const cell = size / n;

  const color = d3.scaleSequential(
    t => d3.interpolateRgbBasis(["#E22134","#282828","#1DB954"])(t)
  ).domain([-1,1]);

  const defs = svg.append("defs");
  const grad = defs.append("linearGradient")
    .attr("id","corr-legend-grad")
    .attr("x1","0%").attr("y1","0%").attr("x2","0%").attr("y2","100%");
  grad.append("stop").attr("offset","0%").attr("stop-color","#1DB954");
  grad.append("stop").attr("offset","50%").attr("stop-color","#282828");
  grad.append("stop").attr("offset","100%").attr("stop-color","#E22134");

  const root = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);
  const cellsG = root.append("g");

  App.features.forEach((f,i)=>{
    root.append("text").attr("x",-8).attr("y",i*cell+cell/2)
      .attr("text-anchor","end").attr("dominant-baseline","middle")
      .attr("font-size","10px").attr("font-family","Montserrat")
      .attr("fill","var(--ink-dim)").text(App.featureLabels[f]);
    root.append("text")
      .attr("transform",`translate(${i*cell+cell/2},${n*cell+8}) rotate(-45)`)
      .attr("text-anchor","end").attr("dominant-baseline","middle")
      .attr("font-size","10px").attr("font-family","Montserrat")
      .attr("fill","var(--ink-dim)").text(App.featureLabels[f]);
  });

  const legX = size + 14, legBarW = 10, legH = size;
  root.append("rect")
    .attr("x",legX).attr("y",0)
    .attr("width",legBarW).attr("height",legH)
    .attr("rx",3).attr("fill","url(#corr-legend-grad)");
  [1, 0.5, 0, -0.5, -1].forEach(v=>{
    const y = ((1-v)/2)*legH;
    root.append("line")
      .attr("x1",legX+legBarW).attr("x2",legX+legBarW+4)
      .attr("y1",y).attr("y2",y)
      .attr("stroke","var(--ink-dim)").attr("stroke-width",1);
    root.append("text")
      .attr("x",legX+legBarW+8).attr("y",y)
      .attr("dominant-baseline","middle")
      .attr("font-size","9px").attr("font-family","Montserrat")
      .attr("fill","var(--ink-dim)")
      .text(v===0?"0":v>0?`+${v.toFixed(1)}`:v.toFixed(1));
  });

  // Compute Pearson r over the (filter ∩ brush) subset, sampled if huge.
  function computeCorr(){
    const f = App.filterMask, b = App.brushMask;
    const n = App.n, fc = App.features.length;
    const feats01 = App.feats01;
    // Collect indices of selected
    const idx = [];
    for (let i = 0; i < n; i++) if (f[i] === 1 && (!b || b[i] === 1)) idx.push(i);
    if (idx.length < 2) return App.meta.correlation;
    // Sample if more than 25k to keep correlation fast.
    let sample = idx;
    if (idx.length > 25000){
      sample = [];
      const stride = idx.length / 25000;
      for (let k = 0; k < 25000; k++) sample.push(idx[Math.floor(k*stride)]);
    }
    const N = sample.length;
    // Compute means
    const mean = new Float64Array(fc);
    for (let s = 0; s < N; s++){
      const base = sample[s] * fc;
      for (let k = 0; k < fc; k++) mean[k] += feats01[base + k];
    }
    for (let k = 0; k < fc; k++) mean[k] /= N;
    // Compute correlation matrix
    const mat = Array.from({length:fc}, () => new Array(fc).fill(0));
    for (let i = 0; i < fc; i++){
      mat[i][i] = 1;
      for (let j = i+1; j < fc; j++){
        let num = 0, di2 = 0, dj2 = 0;
        for (let s = 0; s < N; s++){
          const base = sample[s] * fc;
          const dx = feats01[base+i] - mean[i];
          const dy = feats01[base+j] - mean[j];
          num += dx*dy; di2 += dx*dx; dj2 += dy*dy;
        }
        const denom = Math.sqrt(di2*dj2);
        const r = denom ? num/denom : 0;
        mat[i][j] = r; mat[j][i] = r;
      }
    }
    return mat;
  }

  let lastDrawn = null;
  function redraw(){
    const corr = computeCorr();
    if (corr === lastDrawn) return;
    lastDrawn = corr;
    cellsG.selectAll("*").remove();
    for (let i = 0; i < n; i++){
      for (let j = 0; j < n; j++){
        const v = corr[i][j];
        cellsG.append("rect")
          .attr("x",j*cell).attr("y",i*cell)
          .attr("width",cell-1.5).attr("height",cell-1.5)
          .attr("rx",2).attr("fill",color(v))
          .style("cursor","pointer")
          .on("mouseenter",function(ev){
            d3.select(this).attr("stroke","var(--ink)").attr("stroke-width",1.5);
            App.tip.show(
              `<div class="tt-name" style="font-size:13px">${App.featureLabels[App.features[i]]} × ${App.featureLabels[App.features[j]]}</div>
               <div class="tt-row"><span>Pearson r</span><b>${v.toFixed(3)}</b></div>`, ev);
          })
          .on("mousemove",ev=>App.tip.move(ev))
          .on("mouseleave",function(){ d3.select(this).attr("stroke","none"); App.tip.hide(); });
        if (Math.abs(v) > 0.25 && cell > 26){
          cellsG.append("text")
            .attr("x",j*cell+cell/2-0.75).attr("y",i*cell+cell/2)
            .attr("text-anchor","middle").attr("dominant-baseline","middle")
            .attr("font-size","9px").attr("font-family","Montserrat")
            .attr("fill",Math.abs(v)>0.6?"#10120a":"var(--ink-dim)")
            .attr("pointer-events","none")
            .text(v.toFixed(2).replace("0.",".").replace("-0.","-."));
        }
      }
    }
  }

  // Debounce redraws (filter changes can cascade quickly).
  let debounceTimer = null;
  function debouncedRedraw(){
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(redraw, 120);
  }

  App.registerView(debouncedRedraw);
  redraw();
}
