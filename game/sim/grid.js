// Static uniform spatial grid over the ocean for island proximity queries. Islands never move,
// so it is built once (lazily, on world.spatialIndex) and reused across substeps — turning the
// per-ship O(N) island scans (sightAtSea's range sweep, nearest-port lookups) into O(cells in
// range). A DERIVED index: never serialized (rebuilt on demand), and it never changes the ANSWER
// — same islands, exact distances, and a deterministic "earliest in world.islands order" tie-break
// that matches the linear first-min the callers used. Buckets store island INDICES so the tie-break
// and the islands[] lookup are both cheap. PURE.

function build(world) {
  const islands = world.islands;
  const n = islands.length;
  const W = world.mapW || 1, H = world.mapH || 1;
  const cell = Math.max(1, Math.sqrt((W * H) / Math.max(1, n))); // ~1 island per cell on average
  const cols = Math.max(1, Math.ceil(W / cell) + 1);
  const rows = Math.max(1, Math.ceil(H / cell) + 1);
  const buckets = new Array(cols * rows);
  const cx = (x) => (x <= 0 ? 0 : x >= W ? cols - 1 : Math.min(cols - 1, Math.floor(x / cell)));
  const cy = (y) => (y <= 0 ? 0 : y >= H ? rows - 1 : Math.min(rows - 1, Math.floor(y / cell)));
  for (let i = 0; i < n; i++) {
    const k = cy(islands[i].y) * cols + cx(islands[i].x);
    (buckets[k] || (buckets[k] = [])).push(i);
  }
  return { cell, cols, rows, buckets, cx, cy, n };
}

function grid(world) {
  let g = world.spatialIndex;
  if (!g || g.n !== world.islands.length) { g = build(world); world.spatialIndex = g; }
  return g;
}

/** Call fn(island) for every island whose center is within `radius` of (x,y). Order unspecified
 *  (callers here are commutative — newest-wins intel notes). Exact: same set as a full-scan filter. */
export function eachIslandInRange(world, x, y, radius, fn) {
  const g = grid(world), islands = world.islands, r2 = radius * radius;
  const c0 = g.cx(x - radius), c1 = g.cx(x + radius), r0 = g.cy(y - radius), r1 = g.cy(y + radius);
  for (let ry = r0; ry <= r1; ry++) {
    const rowBase = ry * g.cols;
    for (let rx = c0; rx <= c1; rx++) {
      const b = g.buckets[rowBase + rx];
      if (!b) continue;
      for (let j = 0; j < b.length; j++) {
        const isl = islands[b[j]];
        const dx = isl.x - x, dy = isl.y - y;
        if (dx * dx + dy * dy <= r2) fn(isl);
      }
    }
  }
}

/** Nearest island to (x,y) satisfying `pred` (or any island if pred is null). Exact; on an exact
 *  distance tie it returns the one earliest in world.islands order — matching the linear-scan
 *  first-min (`d < bestD`) the callers used. Expanding square rings with an admissible cutoff:
 *  an island first reachable at ring r is at least (r-1)·cell away, so once a candidate is held we
 *  stop as soon as that lower bound can't beat it. Returns the island or null. */
export function nearestIsland(world, x, y, pred = null) {
  const g = grid(world), islands = world.islands;
  const bx = g.cx(x), by = g.cy(y);
  let best = -1, bestD2 = Infinity;
  const maxRing = g.cols + g.rows;
  for (let ring = 0; ring <= maxRing; ring++) {
    if (best >= 0) { const lb = (ring - 1) * g.cell; if (lb > 0 && lb * lb > bestD2) break; }
    const x0 = bx - ring, x1 = bx + ring, y0 = by - ring, y1 = by + ring;
    for (let ry = y0; ry <= y1; ry++) {
      if (ry < 0 || ry >= g.rows) continue;
      const border = (ry === y0 || ry === y1);
      const rowBase = ry * g.cols;
      for (let rx = x0; rx <= x1; rx++) {
        if (rx < 0 || rx >= g.cols) continue;
        if (!border && rx !== x0 && rx !== x1) continue; // only the ring's outline
        const b = g.buckets[rowBase + rx];
        if (!b) continue;
        for (let j = 0; j < b.length; j++) {
          const idx = b[j], isl = islands[idx];
          if (pred && !pred(isl)) continue;
          const dx = isl.x - x, dy = isl.y - y, d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && (best < 0 || idx < best))) { bestD2 = d2; best = idx; }
        }
      }
    }
  }
  return best >= 0 ? islands[best] : null;
}

// ── Dynamic ship grid ─────────────────────────────────────────────────────────────────────────
// Ships MOVE every substep, so — unlike the island grid — this is NOT cached: the consuming SIM
// system builds it once at its start over the ship SUBSET it will query. That subset does not move
// during the system that queries it (merchants are moved only by `ship`, pirates only by `piracy`,
// privateers only by `antipiracy`), so the snapshot stays exact for that whole pass, and a vessel
// sunk mid-pass simply keeps its slot (preds skip `_sunk`, exactly as the old scans did). Buckets
// are a sparse Map → arrays of INDICES into the passed `ships` array, giving a deterministic
// lowest-index tie-break that matches the old linear first-min/first-max scans. PURE.

export function buildShipGrid(world, ships) {
  const W = world.mapW || 1, H = world.mapH || 1;
  const cell = Math.max(1, Math.sqrt((W * H) / Math.max(1, ships.length))); // ~1 ship per cell
  const cols = Math.max(1, Math.ceil(W / cell) + 1);
  const rows = Math.max(1, Math.ceil(H / cell) + 1);
  const buckets = new Map();
  const cx = (x) => (x <= 0 ? 0 : x >= W ? cols - 1 : Math.min(cols - 1, Math.floor(x / cell)));
  const cy = (y) => (y <= 0 ? 0 : y >= H ? rows - 1 : Math.min(rows - 1, Math.floor(y / cell)));
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    const k = cy(s.y) * cols + cx(s.x);
    const b = buckets.get(k); if (b) b.push(i); else buckets.set(k, [i]);
  }
  return { ships, cell, cols, rows, buckets, cx, cy };
}

/** True if any grid ship satisfying pred lies strictly within `radius` of (x,y). (strict `<` to
 *  match the callers' `dist < RANGE`). */
export function anyShipInRange(g, x, y, radius, pred = null) {
  const ships = g.ships, r2 = radius * radius;
  const c0 = g.cx(x - radius), c1 = g.cx(x + radius), r0 = g.cy(y - radius), r1 = g.cy(y + radius);
  for (let ry = r0; ry <= r1; ry++) {
    const rb = ry * g.cols;
    for (let rx = c0; rx <= c1; rx++) {
      const b = g.buckets.get(rb + rx); if (!b) continue;
      for (let j = 0; j < b.length; j++) {
        const s = ships[b[j]]; if (pred && !pred(s)) continue;
        const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy < r2) return true;
      }
    }
  }
  return false;
}

/** Count grid ships satisfying pred strictly within `radius` of (x,y). */
export function countShipsInRange(g, x, y, radius, pred = null) {
  const ships = g.ships, r2 = radius * radius; let n = 0;
  const c0 = g.cx(x - radius), c1 = g.cx(x + radius), r0 = g.cy(y - radius), r1 = g.cy(y + radius);
  for (let ry = r0; ry <= r1; ry++) {
    const rb = ry * g.cols;
    for (let rx = c0; rx <= c1; rx++) {
      const b = g.buckets.get(rb + rx); if (!b) continue;
      for (let j = 0; j < b.length; j++) {
        const s = ships[b[j]]; if (pred && !pred(s)) continue;
        const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy < r2) n++;
      }
    }
  }
  return n;
}

/** Visit every grid ship within `radius` (inclusive) of (x,y) as fn(ship) — for SCORED selection
 *  where the caller keeps its own exact test + scoring (e.g. a pirate's best prey). Inclusive `<=`
 *  so the caller's own `d > RANGE → skip` reproduces the old bound exactly. */
export function eachShipInRange(g, x, y, radius, fn) {
  const ships = g.ships, r2 = radius * radius;
  const c0 = g.cx(x - radius), c1 = g.cx(x + radius), r0 = g.cy(y - radius), r1 = g.cy(y + radius);
  for (let ry = r0; ry <= r1; ry++) {
    const rb = ry * g.cols;
    for (let rx = c0; rx <= c1; rx++) {
      const b = g.buckets.get(rb + rx); if (!b) continue;
      for (let j = 0; j < b.length; j++) {
        const s = ships[b[j]];
        const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy <= r2) fn(s);
      }
    }
  }
}

/** Nearest grid ship satisfying pred, within `maxRange` (Infinity = uncapped). Exact; the `<=`
 *  range boundary and the lowest-index tie-break match the old linear first-min scans. Expanding
 *  square rings with an admissible cutoff. */
export function nearestShip(g, x, y, pred = null, maxRange = Infinity) {
  const ships = g.ships;
  const bx = g.cx(x), by = g.cy(y);
  const capD2 = maxRange === Infinity ? Infinity : maxRange * maxRange;
  let best = -1, bestD2 = Infinity;
  const maxRing = g.cols + g.rows;
  for (let ring = 0; ring <= maxRing; ring++) {
    const lb = (ring - 1) * g.cell, lb2 = lb > 0 ? lb * lb : 0;
    if (best >= 0) { if (lb2 > bestD2) break; }
    else if (capD2 !== Infinity && lb2 > capD2) break; // nothing in range can remain
    const x0 = bx - ring, x1 = bx + ring, y0 = by - ring, y1 = by + ring;
    for (let ry = y0; ry <= y1; ry++) {
      if (ry < 0 || ry >= g.rows) continue;
      const border = (ry === y0 || ry === y1), rb = ry * g.cols;
      for (let rx = x0; rx <= x1; rx++) {
        if (rx < 0 || rx >= g.cols) continue;
        if (!border && rx !== x0 && rx !== x1) continue; // only the ring's outline
        const b = g.buckets.get(rb + rx); if (!b) continue;
        for (let j = 0; j < b.length; j++) {
          const idx = b[j], s = ships[idx];
          if (pred && !pred(s)) continue;
          const dx = s.x - x, dy = s.y - y, d2 = dx * dx + dy * dy;
          if (d2 > capD2) continue;
          if (best < 0 || d2 < bestD2 || (d2 === bestD2 && idx < best)) { bestD2 = d2; best = idx; }
        }
      }
    }
  }
  return best >= 0 ? ships[best] : null;
}
