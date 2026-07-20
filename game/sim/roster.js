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
// Resource-themed name stems (20 per resource). A Grain isle reads "Wheat-", an ore isle "Forge-",
// so a port's name hints at its trade. Kept distinct from SUF/QUAL words so stems don't self-echo.
const NAMEPRE = {
  Grain: ['Grain', 'Wheat', 'Barley', 'Corn', 'Meadow', 'Harvest', 'Rye', 'Furrow', 'Granary', 'Golden', 'Millet', 'Sheaf', 'Oat', 'Clover', 'Bramble', 'Husk', 'Hearth', 'Amber', 'Ripe', 'Loam'],
  Iron: ['Iron', 'Forge', 'Ore', 'Anvil', 'Ember', 'Cinder', 'Slag', 'Steel', 'Coal', 'Rust', 'Bellows', 'Smelt', 'Clinker', 'Furnace', 'Scoria', 'Ironstone', 'Dross', 'Tinder', 'Hammer', 'Foundry'],
  Meat: ['Cattle', 'Stag', 'Elk', 'Ram', 'Hunt', 'Bison', 'Drover', 'Herd', 'Boar', 'Pasture', 'Ox', 'Buck', 'Hart', 'Venison', 'Shepherd', 'Grazing', 'Tallow', 'Hoof', 'Antler', 'Byre'],
  Wood: ['Oak', 'Pine', 'Cedar', 'Timber', 'Ash', 'Birch', 'Grove', 'Thorn', 'Elm', 'Maple', 'Aspen', 'Willow', 'Rowan', 'Alder', 'Yew', 'Beech', 'Hazel', 'Sawyer', 'Bark', 'Larch'],
  Fiber: ['Flax', 'Loom', 'Linen', 'Weaver', 'Reed', 'Thread', 'Cotton', 'Fleece', 'Spindle', 'Wool', 'Hemp', 'Twine', 'Distaff', 'Shear', 'Carder', 'Fuller', 'Skein', 'Tow', 'Nettle', 'Ramie'],
  PreciousMetal: ['Silver', 'Gem', 'Gold', 'Bright', 'Quartz', 'Onyx', 'Marble', 'Amber', 'Opal', 'Pearl', 'Argent', 'Lustre', 'Sapphire', 'Jasper', 'Beryl', 'Garnet', 'Ingot', 'Bullion', 'Coronet', 'Glimmer'],
};
const SHIPPRE = ['Keel', 'Harbor', 'Dock', 'Mast', 'Anchor', 'Wharf', 'Hull', 'Careen', 'Boom', 'Capstan', 'Tiller', 'Shipwright', 'Slipway', 'Bosun', 'Chandler', 'Quay'];
const SUF = ['peak', 'holm', 'hold', 'moor', 'bay', 'field', 'vale', 'cliff', 'port', 'fell', 'haven', 'reach', 'watch', 'ford', 'shoal', 'cove', 'ridge', 'strand', 'wick', 'mere', 'crag', 'point', 'stead', 'gate', 'dell', 'glen', 'hollow', 'barrow', 'cairn', 'tarn', 'sound', 'head', 'ness', 'reef', 'key', 'march', 'wold', 'thorpe', 'garth', 'holt', 'by', 'mouth', 'bight', 'spur'];
// Generic leading qualifiers, applied to a minority of ports ("North Oakhaven", "Little Ironmoor").
// Multiplies the realized namespace ~13× so a 1000-island sea reads as distinct places, not "Oakbay2".
const QUAL = ['North', 'South', 'East', 'West', 'Upper', 'Lower', 'Little', 'Great', 'Old', 'New', 'Far', 'High', 'Nether', 'Outer', 'Inner', 'Grey', 'Black', 'White', 'Cold', 'Fair', 'Wild', 'Lone', 'Kings', 'Saint', 'Storm', 'Sunder', 'Windward', 'Leeward'];
const QUAL_PROB = 0.45;

const pickFrom = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];
/** A port name: a resource stem + toponymic suffix, with a leading qualifier on QUAL_PROB of ports. */
function placeName(primary, rng) {
  const core = pickFrom(NAMEPRE[primary], rng()) + pickFrom(SUF, rng());
  return rng() < QUAL_PROB ? `${pickFrom(QUAL, rng())} ${core}` : core;
}
/** A shipyard's name — a dockside stem + suffix, same qualifier treatment. */
function yardName(rng) {
  const core = pickFrom(SHIPPRE, rng()) + pickFrom(SUF, rng());
  return rng() < QUAL_PROB ? `${pickFrom(QUAL, rng())} ${core}` : core;
}

// Density reference: a 60-island sea in a 9600×6800 ocean. Larger seas keep this island
// density by scaling the ocean ∝√N, so spacing/travel-times stay comparable at any count.
const BASE_W = 9600, BASE_H = 6800, BASE_N = 60;
export const REFERENCE_ISLANDS = BASE_N; // the density/tuning reference (60-island sea)

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
function scatter(rng, N, OCEAN_W, OCEAN_H) {
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

export function generateRoster(seed = 1, count = BASE_N) {
  // N islands in an ocean scaled ∝√N (constant density): at N=60 the same ocean size, per-resource
  // count, and 5 shipyards as the historical roster; larger counts only extend the same construction.
  // Everything is a pure function of `seed` (names now drawn from the seeded rng, not the island
  // index), so a seed reproduces exactly while different seeds give genuinely different seas.
  const N = Math.max(1, Math.round(count));
  const scale = Math.sqrt(N / BASE_N);
  const OCEAN_W = Math.round(BASE_W * scale), OCEAN_H = Math.round(BASE_H * scale);
  const perRes = Math.ceil(N / RES.length);   // producers per base resource (10 at N=60)
  const nYards = Math.max(5, Math.round(N / 12)); // shipyards ∝ N (5 at N=60)
  const rng = makeRng(seed);

  // Resources shuffled so archipelagos get a diverse mix (food reachable within a cluster).
  const resPool = [];
  for (const r of RES) for (let i = 0; i < perRes; i++) resPool.push(r);
  for (let i = resPool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [resPool[i], resPool[j]] = [resPool[j], resPool[i]]; }

  // Try a few scatterings; keep the one where the farthest island is closest to some food
  // producer (so every random sea is playable, not just organic-looking).
  const foodPrimary = new Set(['Grain', 'Meat']);
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < 12; attempt++) {
    const { positions, clusterOf } = scatter(rng, N, OCEAN_W, OCEAN_H);
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
    const nm = uniqName(placeName(primary, rng));
    islands.push({ id: idFor(nm), name: nm, x: positions[i].x, y: positions[i].y, type, color, primary, secondary, k, produces: goodsFor(primary, secondary, false), _cluster: clusterOf[i] });
  }

  // nYards shipyards (∝ N; 5 at N=60) among Iron+Wood islands, one per cluster where possible.
  let made = 0; const usedClusters = new Set();
  for (const isl of islands) {
    if (made >= nYards) break;
    const has = new Set([isl.primary, isl.secondary]);
    if (has.has('Iron') && has.has('Wood') && !usedClusters.has(isl._cluster)) {
      isl.type = 'shipyard'; isl.color = '#b08a5a'; isl.k = kFor(KBASE.shipyard, rng);
      isl.name = uniqName(yardName(rng)); isl.produces = goodsFor(isl.primary, isl.secondary, true);
      usedClusters.add(isl._cluster); made++;
    }
  }
  for (const isl of islands) { if (made >= nYards) break; const has = new Set([isl.primary, isl.secondary]); if (has.has('Iron') && has.has('Wood') && isl.type !== 'shipyard') { isl.type = 'shipyard'; isl.color = '#b08a5a'; isl.produces = goodsFor(isl.primary, isl.secondary, true); made++; } }
  for (const isl of islands) delete isl._cluster;

  return { ocean: { width: OCEAN_W, height: OCEAN_H }, islands };
}
