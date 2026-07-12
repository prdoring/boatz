// Procedural island roster — generates a fresh sea of organic archipelagos from a seed.
// PURE (no engine, no Date/Math.random — all randomness comes from the seed), so the host
// can roll a new sea each boot while tests pin a seed for determinism. Returns the same
// shape the old data/islands.json had: { ocean, islands:[{id,name,x,y,type,color,primary,
// secondary,k,produces}] }. ~10 producers per base resource, every good made, 5 shipyards,
// resources shuffled so each cluster is diverse, and a viability pass so no island is left
// implausibly far from food.

const RES = ['Grain', 'Iron', 'Meat', 'Wood', 'Fiber', 'PreciousMetal'];
const TYPE = { Grain: 'plantation', Fiber: 'plantation', Meat: 'ranch', Wood: 'forest', Iron: 'mining', PreciousMetal: 'mining' };
const COLOR = { Grain: '#d9c25a', Fiber: '#b6c96a', Meat: '#cf9b6a', Wood: '#6cbf5a', Iron: '#8e9aa6', PreciousMetal: '#c9cdd6' };
const KBASE = { plantation: 135, ranch: 135, forest: 118, mining: 100, shipyard: 105 };
const SEC = {
  Grain: ['Wood', 'Meat', 'Wood', 'Fiber', 'Meat', 'Wood', 'Iron', 'Meat', 'Wood', 'Fiber'],
  Iron: ['Wood', 'Wood', 'PreciousMetal', 'Wood', 'Meat', 'Wood', 'Grain', 'Wood', 'Fiber', 'Wood'],
  Meat: ['Grain', 'Fiber', 'Grain', 'Wood', 'Grain', 'Iron', 'Grain', 'Fiber', 'Grain', 'Wood'],
  Wood: ['Iron', 'Grain', 'Iron', 'Fiber', 'Iron', 'Grain', 'Iron', 'PreciousMetal', 'Iron', 'Grain'],
  Fiber: ['Grain', 'Meat', 'Grain', 'PreciousMetal', 'Grain', 'Meat', 'Wood', 'Grain', 'Meat', 'Grain'],
  PreciousMetal: ['Iron', 'Fiber', 'Grain', 'Iron', 'Meat', 'Fiber', 'Iron', 'Grain', 'Fiber', 'Iron'],
};
const NAMEPRE = {
  Grain: ['Grain', 'Wheat', 'Barley', 'Corn', 'Meadow', 'Harvest', 'Rye', 'Field', 'Furrow', 'Golden'],
  Iron: ['Iron', 'Forge', 'Ore', 'Anvil', 'Ember', 'Cinder', 'Slag', 'Steel', 'Coal', 'Rust'],
  Meat: ['Cattle', 'Stag', 'Elk', 'Ram', 'Hunt', 'Bison', 'Drover', 'Herd', 'Boar', 'Pasture'],
  Wood: ['Oak', 'Pine', 'Cedar', 'Timber', 'Ash', 'Birch', 'Grove', 'Thorn', 'Elm', 'Maple'],
  Fiber: ['Flax', 'Loom', 'Linen', 'Weaver', 'Reed', 'Thread', 'Cotton', 'Fleece', 'Spindle', 'Wool'],
  PreciousMetal: ['Silver', 'Gem', 'Gold', 'Bright', 'Quartz', 'Onyx', 'Marble', 'Amber', 'Opal', 'Pearl'],
};
const SHIPPRE = ['Keel', 'Harbor', 'Dock', 'Mast', 'Anchor'];
const SUF = ['peak', 'holm', 'hold', 'moor', 'bay', 'field', 'vale', 'cliff', 'port', 'fell', 'haven', 'reach', 'watch', 'ford', 'shoal', 'cove', 'ridge', 'strand', 'wick', 'mere', 'crag', 'landing', 'point', 'stead'];

const OCEAN_W = 9600, OCEAN_H = 6800, N = 60;

function goodsFor(p, s, shipyard) {
  const has = new Set([p, s]);
  if (shipyard) { const g = ['Ships']; if (has.has('Iron') && has.has('Wood')) g.unshift('Weapons'); return g; }
  const g = [];
  if (has.has('Iron') && has.has('Wood')) g.push('Weapons');
  if (has.has('PreciousMetal')) g.push('LuxuryGoods');
  if (has.has('Fiber')) g.push('Clothing');
  if (has.has('Grain') && has.has('Wood')) g.push('Ale');
  if (has.has('Grain') || has.has('Meat')) g.push('Food');
  if (g.length > 2) { const food = g.includes('Food'); const top = g.filter((x) => x !== 'Food').slice(0, 1); return food ? [...top, 'Food'] : g.slice(0, 2); }
  return g.length ? g : ['Food'];
}

/** Scatter island positions into organic archipelagos. Returns {positions, clusterOf}. */
function scatter(rng) {
  const clusters = [];
  for (let rem = N; rem > 0;) {
    const roll = rng();
    let size = roll < 0.22 ? 1 + Math.floor(rng() * 2) : roll < 0.78 ? 3 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 3);
    size = Math.min(size, rem);
    clusters.push(size);
    rem -= size;
  }
  const MARGIN = 950, MIN_CENTER = 1250, centers = [];
  for (let c = 0; c < clusters.length; c++) {
    let placed = false;
    for (let t = 0; t < 600 && !placed; t++) {
      const x = MARGIN + rng() * (OCEAN_W - 2 * MARGIN), y = MARGIN + rng() * (OCEAN_H - 2 * MARGIN);
      if (centers.every((ct) => Math.hypot(ct.x - x, ct.y - y) >= MIN_CENTER)) { centers.push({ x, y }); placed = true; }
    }
    if (!placed) centers.push({ x: MARGIN + rng() * (OCEAN_W - 2 * MARGIN), y: MARGIN + rng() * (OCEAN_H - 2 * MARGIN) });
  }
  const MIN_ISLAND = 160, positions = [], clusterOf = [];
  const placeNear = (cx, cy, spread) => {
    for (let t = 0; t < 300; t++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * spread;
      const x = Math.max(320, Math.min(OCEAN_W - 320, cx + Math.cos(a) * r));
      const y = Math.max(320, Math.min(OCEAN_H - 320, cy + Math.sin(a) * r));
      if (positions.every((p) => Math.hypot(p.x - x, p.y - y) >= MIN_ISLAND)) return { x: Math.round(x), y: Math.round(y) };
    }
    const a = rng() * Math.PI * 2;
    return { x: Math.round(Math.max(320, Math.min(OCEAN_W - 320, cx + Math.cos(a) * spread * 1.6))), y: Math.round(Math.max(320, Math.min(OCEAN_H - 320, cy + Math.sin(a) * spread * 1.6))) };
  };
  for (let c = 0; c < clusters.length; c++) {
    const center = centers[c], spread = 340 + clusters[c] * 95;
    for (let j = 0; j < clusters[c]; j++) { positions.push(j === 0 ? { x: Math.round(center.x), y: Math.round(center.y) } : placeNear(center.x, center.y, spread)); clusterOf.push(c); }
  }
  return { positions, clusterOf };
}

/** A tiny seedable LCG local to generation (keeps the module pure + independent per call). */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** Capacity multiplier with a WIDE spread so islands range from tiny outposts to huge
 *  metropolises (biased toward smaller, with a few giants) — this is what drives real
 *  size variance, since draw size scales with capacity k. */
function pickScale(rng) {
  const r = rng();
  if (r < 0.16) return 0.22 + rng() * 0.22;   // tiny outpost   (~k 22-55)
  if (r < 0.70) return 0.6 + rng() * 0.6;      // town           (~k 60-160)
  if (r < 0.90) return 1.3 + rng() * 0.6;      // large island   (~k 130-250)
  return 2.0 + rng() * 0.7;                     // huge metropolis(~k 210-360)
}
const kFor = (base, rng) => Math.max(24, Math.round(base * pickScale(rng)));

export function generateRoster(seed = 1) {
  const rng = makeRng(seed);

  // Resources shuffled so archipelagos get a diverse mix (food reachable within a cluster).
  const resPool = [];
  for (const r of RES) for (let i = 0; i < 10; i++) resPool.push(r);
  for (let i = resPool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [resPool[i], resPool[j]] = [resPool[j], resPool[i]]; }

  // Try a few scatterings; keep the one where the farthest island is closest to some food
  // producer (so every random sea is playable, not just organic-looking).
  const foodPrimary = new Set(['Grain', 'Meat']);
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < 12; attempt++) {
    const { positions, clusterOf } = scatter(rng);
    const foodIdx = [];
    for (let i = 0; i < N; i++) if (foodPrimary.has(resPool[i])) foodIdx.push(i);
    let worst = 0;
    for (let i = 0; i < N; i++) {
      let nearest = Infinity;
      for (const f of foodIdx) if (f !== i) nearest = Math.min(nearest, Math.hypot(positions[i].x - positions[f].x, positions[i].y - positions[f].y));
      worst = Math.max(worst, nearest);
    }
    if (worst < bestScore) { bestScore = worst; best = { positions, clusterOf }; }
    if (worst < 3200) break; // good enough
  }
  const { positions, clusterOf } = best;

  const usedNames = new Set(), usedIds = new Set();
  const uniqName = (nm) => { let b = nm, k = 2; while (usedNames.has(nm)) nm = b + k++; usedNames.add(nm); return nm; };
  const idFor = (nm) => { let base = nm.toLowerCase().replace(/[^a-z]/g, ''); let id = base, k = 2; while (usedIds.has(id)) id = base + k++; usedIds.add(id); return id; };
  const secCount = { Grain: 0, Iron: 0, Meat: 0, Wood: 0, Fiber: 0, PreciousMetal: 0 };

  const islands = [];
  for (let i = 0; i < N; i++) {
    const primary = resPool[i];
    const secondary = SEC[primary][secCount[primary]++ % 10];
    const type = TYPE[primary], color = COLOR[primary], k = kFor(KBASE[type], rng);
    const nm = uniqName(NAMEPRE[primary][(i * 3) % 10] + SUF[(i * 5) % SUF.length]);
    islands.push({ id: idFor(nm), name: nm, x: positions[i].x, y: positions[i].y, type, color, primary, secondary, k, produces: goodsFor(primary, secondary, false), _cluster: clusterOf[i] });
  }

  // 5 shipyards among Iron+Wood islands, one per cluster where possible.
  let made = 0; const usedClusters = new Set();
  for (const isl of islands) {
    if (made >= 5) break;
    const has = new Set([isl.primary, isl.secondary]);
    if (has.has('Iron') && has.has('Wood') && !usedClusters.has(isl._cluster)) {
      isl.type = 'shipyard'; isl.color = '#b08a5a'; isl.k = kFor(KBASE.shipyard, rng);
      isl.name = uniqName(SHIPPRE[made] + SUF[(made * 7) % SUF.length]); isl.produces = goodsFor(isl.primary, isl.secondary, true);
      usedClusters.add(isl._cluster); made++;
    }
  }
  for (const isl of islands) { if (made >= 5) break; const has = new Set([isl.primary, isl.secondary]); if (has.has('Iron') && has.has('Wood') && isl.type !== 'shipyard') { isl.type = 'shipyard'; isl.color = '#b08a5a'; isl.produces = goodsFor(isl.primary, isl.secondary, true); made++; } }
  for (const isl of islands) delete isl._cluster;

  return { ocean: { width: OCEAN_W, height: OCEAN_H }, islands };
}
