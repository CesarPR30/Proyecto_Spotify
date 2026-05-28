/* ============================================================
   distribution.js — Feature-by-decade trend.
   Mean of a chosen feature per decade, computed live over the
   current selection. Iterates the typed-array columns directly
   so it runs in <50ms even on the full 170k tracks.
   ============================================================ */
function initDistribution(){
  const svg = d3.select("#dist");
  const node = svg.node();
  const parent = node.parentElement;
  const W = parent.clientWidth - 16;
  const H = parent.clientHeight - 16;
  const m = {t:18, r:18, b:34, l:40};
  const iw = W-m.l-m.r, ih = H-m.t-m.b;

  const seg = d3.select("#distFeature");
  let current = "energy";
  let currentIdx = App.features.indexOf(current);
  App.features.forEach(f=>{
    seg.append("button").attr("data-f",f)
      .classed("active", f===current)
      .text(App.featureLabels[f])
      .on("click", function(){
        current = f;
        currentIdx = App.features.indexOf(f);
        seg.selectAll("button").classed("active",false);
        d3.select(this).classed("active",true);
        redraw();
      });
  });

  const decades = App.meta.decades;
  const x = d3.scalePoint().domain(decades).range([0, iw]).padding(0.5);
  const y = d3.scaleLinear().range([ih,0]);

  const root = svg.append("g").attr("transform",`translate(${m.l},${m.t})`);
  const gx = root.append("g").attr("transform",`translate(0,${ih})`).attr("class","axis");
  const gy = root.append("g").attr("class","axis");
  const areaPath = root.append("path");
  const linePath = root.append("path");
  const dotsG = root.append("g");
  const allPath = root.append("path");

  // Compute mean-per-decade over a (filter ∩ brush) iteration of typed arrays.
  function meansSelected(){
    const n = App.n, fc = App.features.length;
    const f = App.filterMask, b = App.brushMask;
    const feats = App.feats;       // raw values
    const dec = App.decadeIdx;
    const sums = new Float64Array(decades.length);
    const counts = new Uint32Array(decades.length);
    for (let i = 0; i < n; i++){
      if (f[i] === 0 || (b && b[i] === 0)) continue;
      const di = dec[i];
      sums[di] += feats[i*fc + currentIdx];
      counts[di]++;
    }
    return decades.map((dd, k) => ({
      decade: dd, value: counts[k] ? sums[k]/counts[k] : null
    }));
  }

  // Full-dataset baseline, computed once and cached per feature.
  const allMeansCache = new Map();
  function meansAll(){
    if (allMeansCache.has(current)) return allMeansCache.get(current);
    const n = App.n, fc = App.features.length;
    const feats = App.feats;
    const dec = App.decadeIdx;
    const sums = new Float64Array(decades.length);
    const counts = new Uint32Array(decades.length);
    for (let i = 0; i < n; i++){
      const di = dec[i];
      sums[di] += feats[i*fc + currentIdx];
      counts[di]++;
    }
    const arr = decades.map((dd, k) => ({
      decade: dd, value: counts[k] ? sums[k]/counts[k] : null
    }));
    allMeansCache.set(current, arr);
    return arr;
  }

  function redraw(){
    const selData = meansSelected().filter(d=>d.value!=null);
    const allData = meansAll().filter(d=>d.value!=null);

    // y-domain from the feature's full range (so brushing doesn't rescale).
    const rng = App.meta.ranges[current];
    const padding = (rng[1] - rng[0]) * 0.05;
    const min = rng[0] >= 0 ? Math.max(0, rng[0] - padding) : rng[0] - padding;
    y.domain([min, rng[1] + padding]).nice();

    gx.call(d3.axisBottom(x).tickFormat(d=>`'${String(d).slice(2)}`).tickSize(0))
      .call(g=>g.select(".domain").attr("stroke","var(--line)"))
      .call(g=>g.selectAll("text").attr("fill","var(--ink-faint)"));
    gy.call(d3.axisLeft(y).ticks(5).tickSize(-iw))
      .call(g=>g.select(".domain").remove())
      .call(g=>g.selectAll(".tick line").attr("stroke","var(--line-soft)"))
      .call(g=>g.selectAll("text").attr("fill","var(--ink-faint)"));

    const line = d3.line().x(d=>x(d.decade)).y(d=>y(d.value)).curve(d3.curveMonotoneX);
    const area = d3.area().x(d=>x(d.decade)).y0(ih).y1(d=>y(d.value)).curve(d3.curveMonotoneX);

    allPath.datum(allData).attr("fill","none")
      .attr("stroke","var(--ink-faint)").attr("stroke-width",1)
      .attr("stroke-dasharray","3 3").attr("opacity",.5)
      .transition().duration(400).attr("d", line);

    areaPath.datum(selData).attr("fill","var(--green)").attr("opacity",.10)
      .transition().duration(400).attr("d", area);
    linePath.datum(selData).attr("fill","none")
      .attr("stroke","var(--green)").attr("stroke-width",2.4)
      .transition().duration(400).attr("d", line);

    const dots = dotsG.selectAll("circle").data(selData);
    dots.join("circle")
      .attr("r",4).attr("fill","var(--green)").attr("stroke","var(--bg)").attr("stroke-width",1.5)
      .on("mouseenter", function(ev,d){
        App.tip.show(`<div class="tt-row"><span>${d.decade}s ${App.featureLabels[current]}</span><b>${d.value.toFixed(3)}</b></div>`, ev);
      })
      .on("mousemove",(ev)=>App.tip.move(ev))
      .on("mouseleave", ()=>App.tip.hide())
      .transition().duration(400)
      .attr("cx", d=>x(d.decade)).attr("cy", d=>y(d.value));
  }

  App.registerView(redraw);
  redraw();
}
