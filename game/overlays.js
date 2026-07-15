// Map data-overlay REGISTRY + the PURE math behind it (normalisation, aggregation,
// leaderboards, relational-edge extraction). This module imports NOTHING canvas- or
// engine-bound, so it loads cheaply in Node and is directly unit-testable (see
// tests/overviewOverlays.test.js). WorldRenderer + SimScene + OverviewDashboard read from
// here; WorldRenderer re-exports OVERLAYS/heatColor so existing importers keep resolving.
//
// An overlay is a data VIEW of the archipelago. `kind:'scalar'` tints every port by one
// per-island number (auto-ranged, so the colour scale fits the LIVE spread instead of a
// hard-coded divisor). `kind:'edges'` draws lines BETWEEN islands (alliances, trade lanes,
// pirate hunts). `kind:'off'` is the do-nothing default.

// ─── colour ramp ─────────────────────────────────────────────────────────────
/** Diverging red→amber→green heat. `t` in 0..1 where 1 is the "good" end; alpha for
 *  translucency. The single source both the map discs and every legend/swatch paint from. */
export function heatColor(t, alpha = 1) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  // red (200,60,50) → amber (230,190,60) → green (90,200,110)
  let r, g, b;
  if (t < 0.5) { const u = t / 0.5; r = 200 + u * 30; g = 60 + u * 130; b = 50 + u * 10; }
  else { const u = (t - 0.5) / 0.5; r = 230 - u * 140; g = 190 + u * 10; b = 60 + u * 50; }
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}
/** Muted slate for a port with NO data on the active metric (missing stat / 0-pop rock) —
 *  so it never reads as "worst-red". */
export function neutralColor(alpha = 1) { return `rgba(122,140,150,${alpha})`; }

// ─── scalar accessors + tiny formatters ──────────────────────────────────────
export function perCapitaGold(isl) { return (isl.gold || 0) / Math.max(1, isl.population || 1); }
export function fill(isl) { return Math.min(1, (isl.population || 0) / Math.max(1, isl.k || 120)); }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const pct = (v) => Math.round(v * 100) + '%';
const shortGold = (v) => {
  v = Math.round(v);
  const a = Math.abs(v);
  return (a >= 1000 ? (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k' : '' + v) + 'g';
};

// ─── the registry ────────────────────────────────────────────────────────────
// Each scalar entry: { key, kind, category, label, icon, good, accessor, vfmt, domain,
//   skipEmpty, lo, hi }. `accessor(isl)` → a raw number or null ("no data"). `vfmt(v)`
//   formats a raw value (drives the badge, the hover line, and the legend endpoints).
//   `domain`: 'unit' (already a 0..1 ratio — keep absolute meaning) | 'auto' (p5..p95 across
//   the live islands — clamps outliers) | [lo,hi] (fixed). `good:true` → high is green.
export const OVERLAYS = [
  { key: 'off', kind: 'off', label: 'Off' },

  { key: 'wealth', kind: 'scalar', category: 'Economy', label: 'Wealth / capita', icon: 'coin',
    good: true, accessor: perCapitaGold, vfmt: (v) => Math.round(v) + 'g',
    domain: 'auto', skipEmpty: true, lo: 'poor', hi: 'rich' },
  { key: 'treasury', kind: 'scalar', category: 'Economy', label: 'Treasury', icon: 'coin',
    good: true, accessor: (isl) => num(isl.gold), vfmt: shortGold,
    domain: 'auto', skipEmpty: false, lo: 'lean', hi: 'flush' },

  { key: 'prosperity', kind: 'scalar', category: 'Society', label: 'Prosperity', icon: 'spark',
    good: true, accessor: (isl) => num(isl.civ), vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'squalid', hi: 'thriving' },
  { key: 'population', kind: 'scalar', category: 'Society', label: 'Population', icon: 'anchor',
    good: true, accessor: fill, vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'empty', hi: 'packed' },
  { key: 'loyalty', kind: 'scalar', category: 'Society', label: 'Loyalty', icon: 'shield',
    good: true, accessor: (isl) => num(isl.loyalty), vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'seething', hi: 'devoted' },

  { key: 'food', kind: 'scalar', category: 'Sustenance', label: 'Food security', icon: 'wheat',
    good: true, accessor: (isl) => num(isl.foodDays), vfmt: (v) => v.toFixed(1) + 'd',
    domain: 'auto', skipEmpty: true, lo: 'starving', hi: 'secure' },

  { key: 'unrest', kind: 'scalar', category: 'Order', label: 'Lawlessness', icon: 'sabres',
    good: false, accessor: (isl) => num(isl.lawlessness), vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'orderly', hi: 'lawless' },
  { key: 'grievance', kind: 'scalar', category: 'Order', label: 'Grievance', icon: 'flame',
    good: false, accessor: (isl) => num(isl.grievance), vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'content', hi: 'resentful' },
  { key: 'strife', kind: 'scalar', category: 'Order', label: 'Rebel pressure', icon: 'storm',
    good: false, accessor: (isl) => num(isl.unrest), vfmt: (v) => v.toFixed(0) + 'd',
    domain: 'auto', skipEmpty: true, lo: 'settled', hi: 'seething' },

  { key: 'danger', kind: 'scalar', category: 'Threat', label: 'Pirate danger', icon: 'skull',
    good: false, accessor: (isl) => num(isl.danger), vfmt: pct,
    domain: 'unit', skipEmpty: false, lo: 'safe', hi: 'haunted' },
  { key: 'havenrisk', kind: 'scalar', category: 'Threat', label: 'Haven risk', icon: 'warning',
    good: false, accessor: (isl) => num(isl.havenPressure), vfmt: (v) => v.toFixed(0) + 'd',
    domain: 'auto', skipEmpty: false, lo: 'stable', hi: 'failing' },

  { key: 'fleet', kind: 'scalar', category: 'Naval', label: 'Fleet strength', icon: 'flag',
    good: true, accessor: (isl) => num(isl.fleet && isl.fleet.total), vfmt: (v) => Math.round(v) + '',
    domain: 'auto', skipEmpty: false, lo: 'none', hi: 'armada' },

  { key: 'intel', kind: 'scalar', category: 'Intel', label: 'Price-intel reach', icon: 'map',
    good: true, accessor: (isl) => num(isl.intel && isl.intel.known), vfmt: (v) => Math.round(v) + '',
    domain: 'auto', skipEmpty: false, lo: 'isolated', hi: 'connected' },

  // ── relational (edges between islands) ──
  { key: 'alliances', kind: 'edges', category: 'Relations', label: 'Alliances & rivalries',
    icon: 'link', edgeKinds: ['ally', 'rival'] },
  { key: 'lanes', kind: 'edges', category: 'Relations', label: 'Trade lanes',
    icon: 'anchor', edgeKinds: ['lane'] },
  { key: 'aid', kind: 'edges', category: 'Relations', label: 'Aid convoys',
    icon: 'wheat', edgeKinds: ['aid'] },
  { key: 'blocs', kind: 'edges', category: 'Relations', label: 'Blocs & embargoes',
    icon: 'link', edgeKinds: ['ally', 'rival', 'embargo'] },
  { key: 'hunts', kind: 'edges', category: 'Relations', label: 'Hunts & patrols',
    icon: 'sabres', edgeKinds: ['hunt', 'guard'] },
];

/** The active spec for a key (falls back to `off`). */
export function overlayByKey(key) { return OVERLAYS.find((o) => o.key === key) || OVERLAYS[0]; }
/** Format one island's value on a spec (badge / hover / leaderboard rows). */
export function fmtValue(spec, isl) {
  const v = spec.accessor(isl);
  return (v == null || !Number.isFinite(v)) ? '—' : spec.vfmt(v);
}
/** Next overlay key when cycling only entries of `kind` ('scalar'|'edges'), with `off` in the
 *  ring so you can always cycle back to a clear map. `dir` < 0 steps backward. */
export function cycleOverlay(curKey, kind, dir) {
  const ring = ['off', ...OVERLAYS.filter((o) => o.kind === kind).map((o) => o.key)];
  let i = ring.indexOf(curKey);
  if (i < 0) i = 0; // current overlay is a different kind → start the ring at `off`
  i = (i + (dir < 0 ? ring.length - 1 : 1)) % ring.length;
  return ring[i];
}

// ─── pure normalisation / aggregation ────────────────────────────────────────
/** Interpolated percentile of an ASCENDING-sorted array. `p` in 0..1. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = clamp01(p) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

/** Colour domain {lo,hi} for a set of raw values. `method`: 'p5p95' (default, clamps outliers)
 *  or 'minmax'. Empty → {0,1}; all-equal → {v,v} (normalize then returns 0.5). */
export function computeDomain(values, method = 'p5p95') {
  if (!values.length) return { lo: 0, hi: 1 };
  const s = values.slice().sort((a, b) => a - b);
  const min = s[0], max = s[s.length - 1];
  if (method === 'minmax') return { lo: min, hi: max };
  let lo = percentile(s, 0.05), hi = percentile(s, 0.95);
  if (hi <= lo) { lo = min; hi = max; } // degenerate percentile band → fall back to full range
  return { lo, hi };
}

/** Map a raw value into 0..1 across [lo,hi]. Returns null for missing/non-finite input (→ the
 *  caller paints neutral); 0.5 for a degenerate domain (no div-by-zero). */
export function normalize(v, lo, hi) {
  if (v == null || !Number.isFinite(v)) return null;
  if (hi <= lo) return 0.5;
  return clamp01((v - lo) / (hi - lo));
}

/** One O(N) pass → {min,p50,max,mean,count,lo,hi}. `lo/hi` are the colour domain (per
 *  spec.domain). Skips null/non-finite and, when spec.skipEmpty, 0-population ports. */
export function aggregate(islands, spec) {
  const vals = [];
  for (const isl of islands) {
    if (spec.skipEmpty && !(isl.population > 0)) continue;
    const v = spec.accessor(isl);
    if (v == null || !Number.isFinite(v)) continue;
    vals.push(v);
  }
  const count = vals.length;
  if (!count) return { min: 0, p50: 0, max: 0, mean: 0, count: 0, lo: 0, hi: 1 };
  const s = vals.slice().sort((a, b) => a - b);
  const min = s[0], max = s[s.length - 1];
  const p50 = percentile(s, 0.5);
  let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i];
  const mean = sum / count;
  let lo, hi;
  const dom = spec.domain;
  if (Array.isArray(dom)) { lo = dom[0]; hi = dom[1]; }
  else if (dom === 'unit') { lo = 0; hi = 1; }
  else { lo = percentile(s, 0.05); hi = percentile(s, 0.95); if (hi <= lo) { lo = min; hi = max; } }
  return { min, p50, max, mean, count, lo, hi };
}

/** Ranked islands for a scalar spec: `top` = the best end (oriented by spec.good), `bottom` =
 *  the worst end (worst-first), plus `rankById` (1 = best) for the hover "12/240" line. */
export function leaderboard(islands, spec, n = 8) {
  const rows = [];
  for (const isl of islands) {
    if (spec.skipEmpty && !(isl.population > 0)) continue;
    const v = spec.accessor(isl);
    if (v == null || !Number.isFinite(v)) continue;
    rows.push({ id: isl.id, name: isl.name, v });
  }
  rows.sort((a, b) => spec.good ? b.v - a.v : a.v - b.v); // index 0 = "best" end
  const rankById = new Map();
  for (let i = 0; i < rows.length; i++) rankById.set(rows[i].id, i + 1);
  return {
    top: rows.slice(0, n),
    bottom: rows.slice(Math.max(0, rows.length - n)).reverse(), // worst end, worst-first
    count: rows.length,
    rankById,
  };
}

/** World-level "what's on fire" tallies (independent of the active metric) for the almanac. */
export function troubleCounts(islands) {
  let starving = 0, rebelling = 0, havens = 0, lawless = 0, blighted = 0, plagued = 0;
  for (const isl of islands) {
    if ((isl.foodDays == null ? 9 : isl.foodDays) < 1.5 && isl.population > 0) starving++;
    if (isl.rebellion) rebelling++;
    if (isl.haven) havens++;
    if ((isl.lawlessness || 0) > 0.35) lawless++;
    if (isl.blight) blighted++;
    if (isl.plague) plagued++;
  }
  return { starving, rebelling, havens, lawless, blighted, plagued };
}

// ─── relational edges (island ↔ island) ──────────────────────────────────────
const lookup = (byId, id) => byId && (byId.get ? byId.get(id) : byId[id]);

/** Deduped alliance/rivalry edges from each island's top allies/rivals (already on the wire).
 *  Undirected: a→b and b→a collapse to one edge per (pair,kind). O(N·6). Skips a partner not
 *  present in `islandsById`. Endpoints carry both island coords + |reputation| as `v`. */
export function relationEdges(islands, islandsById) {
  const seen = new Set();
  const edges = [];
  for (const isl of islands) {
    for (const kind of ['ally', 'rival']) {
      const list = kind === 'ally' ? isl.allies : isl.rivals;
      if (!list) continue;
      for (const rel of list) {
        if (rel == null || rel.id == null || rel.id === isl.id) continue;
        const other = lookup(islandsById, rel.id);
        if (!other) continue;
        const a = isl.id < rel.id ? isl.id : rel.id;
        const b = isl.id < rel.id ? rel.id : isl.id;
        const key = kind + ':' + a + '|' + b;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ ax: isl.x, ay: isl.y, bx: other.x, by: other.y, kind, v: Math.abs(rel.v || 0), a, b });
      }
    }
  }
  return edges;
}

/** Severed-trade (embargo) edges from each island's projected `embargoes` id list. Deduped
 *  undirected, same shape as relationEdges but kind:'embargo'. */
export function embargoEdges(islands, islandsById) {
  const seen = new Set();
  const edges = [];
  for (const isl of islands) {
    if (!isl.embargoes) continue;
    for (const oid of isl.embargoes) {
      if (oid == null || oid === isl.id) continue;
      const other = lookup(islandsById, oid);
      if (!other) continue;
      const a = isl.id < oid ? isl.id : oid;
      const b = isl.id < oid ? oid : isl.id;
      const key = a + '|' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ ax: isl.x, ay: isl.y, bx: other.x, by: other.y, kind: 'embargo', v: 1, a, b });
    }
  }
  return edges;
}

/** Traffic-weighted shipping lanes: count how many in-flight ships traverse each island→island
 *  route leg (route[] is on the wire). Undirected. Returns positioned edges {ax..by,weight}.
 *  `shipsById` may be a Map or a plain id→ship object. O(S·legs). */
export function laneEdges(shipsById, islandsById) {
  const w = new Map(); // "a|b" → { a, b, weight }
  const bump = (x, y) => {
    if (x == null || y == null || x === y) return;
    const a = x < y ? x : y, b = x < y ? y : x;
    const key = a + '|' + b;
    const e = w.get(key);
    if (e) e.weight++; else w.set(key, { a, b, weight: 1 });
  };
  const visit = (s) => {
    const r = s && s.route;
    if (!r || r.length < 2) return;
    for (let i = 0; i < r.length - 1; i++) bump(r[i], r[i + 1]);
  };
  if (shipsById instanceof Map) shipsById.forEach(visit);
  else for (const id in shipsById) visit(shipsById[id]);
  const edges = [];
  for (const e of w.values()) {
    const A = lookup(islandsById, e.a), B = lookup(islandsById, e.b);
    if (!A || !B) continue;
    edges.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y, weight: e.weight, kind: 'lane', a: e.a, b: e.b });
  }
  return edges;
}

/** Relief-convoy edges: a line from each ship on an `aid` errand to the port it's relieving
 *  (its live position → the destination island). Endpoint a is the ship (moving), b the island. */
export function aidEdges(shipsById, islandsById) {
  const edges = [];
  const visit = (s) => {
    if (!s || s.reason !== 'aid' || s.destId == null || s.x == null || s.y == null) return;
    const dst = lookup(islandsById, s.destId);
    if (!dst) return;
    edges.push({ ax: s.x, ay: s.y, bx: dst.x, by: dst.y, kind: 'aid', a: s.homeId, b: s.destId });
  };
  if (shipsById instanceof Map) shipsById.forEach(visit);
  else for (const id in shipsById) visit(shipsById[id]);
  return edges;
}

/** Predation/protection edges: pirate→prey (or blockaded port) as 'hunt'; privateer→hunted-pirate
 *  (or guarded port) as 'guard'. Endpoints are live ship / island positions (a ship end moves). */
export function huntEdges(shipsById, islandsById) {
  const edges = [];
  const shipPos = (id) => lookup(shipsById, id);
  const visit = (s) => {
    if (!s || s.x == null) return;
    if (s.pirate) {
      if (s.prey) { const t = shipPos(s.prey); if (t && t.x != null) edges.push({ ax: s.x, ay: s.y, bx: t.x, by: t.y, kind: 'hunt' }); }
      if (s.siege) { const isl = lookup(islandsById, s.siege); if (isl) edges.push({ ax: s.x, ay: s.y, bx: isl.x, by: isl.y, kind: 'hunt' }); }
    } else if (s.privateer) {
      if (s.prey) { const t = shipPos(s.prey); if (t && t.x != null) edges.push({ ax: s.x, ay: s.y, bx: t.x, by: t.y, kind: 'guard' }); }
      else if (s.guard) { const isl = lookup(islandsById, s.guard); if (isl) edges.push({ ax: s.x, ay: s.y, bx: isl.x, by: isl.y, kind: 'guard' }); }
    }
  };
  if (shipsById instanceof Map) shipsById.forEach(visit);
  else for (const id in shipsById) visit(shipsById[id]);
  return edges;
}

/** Conservative world-space cull: does the AABB of segment a→b intersect the view rect? Keeps a
 *  segment whose bbox overlaps even if the line itself skims a corner (cheap + safe). */
export function segmentInBounds(ax, ay, bx, by, b) {
  const minx = ax < bx ? ax : bx, maxx = ax > bx ? ax : bx;
  const miny = ay < by ? ay : by, maxy = ay > by ? ay : by;
  return maxx >= b.left && minx <= b.right && maxy >= b.top && miny <= b.bottom;
}
