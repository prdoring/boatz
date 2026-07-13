// Island avoidance (navigation.js): a hull steers AROUND a landmass in its path instead of sailing
// through it. Local + greedy (nearest blocker only) — it handles the common "one island in the way"
// case cleanly; it is NOT global pathfinding (dense clusters can still clip — that's a deferred seam).
// The destination island is exempt (a ship must enter it to dock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { steerAroundIslands, islandLandRadius } from '/game/sim/navigation.js';
import { moveToward } from '/game/sim/ship.js';

/** Replace the sea with a handful of hand-placed islands (forces the spatial grid to rebuild). */
function withIslands(w, islands) {
  w.islands = islands;
  w.spatialIndex = null;
}
const isl = (id, x, y, k = 120) => ({ id, name: id, x, y, k });

test('islandLandRadius mirrors the client formula — equals ISLAND_RADIUS at the reference size, clamped and monotonic', () => {
  const w = makeWorld();
  const t = w.rules;
  // At k === ISLAND_RADIUS_K the scale is exactly 1, so the land radius is exactly ISLAND_RADIUS.
  assert.equal(islandLandRadius({ k: t.ISLAND_RADIUS_K }, t), t.ISLAND_RADIUS);
  // Bigger island => bigger (or clamped-equal) radius; never outside the clamp band.
  const small = islandLandRadius({ k: 40 }, t), big = islandLandRadius({ k: 400 }, t);
  assert.ok(big >= small, 'radius is monotonic in island size');
  assert.ok(small >= t.ISLAND_RADIUS * 0.4 && big <= t.ISLAND_RADIUS * 1.85, 'radius stays inside the clamp band');
});

test('a clear route is not deflected — the aim is the target itself (docking/arrival stays exact)', () => {
  const w = makeWorld();
  const t = w.rules;
  const R = islandLandRadius(isl('B'), t) + t.SHIP_ISLAND_CLEARANCE;
  // Blocker sits ahead but well off the ray (perp offset > avoid radius) — the route clears its land.
  withIslands(w, [isl('B', 2000 + (R + 12), 1800)]);
  const ship = { x: 2000, y: 1500 };
  const aim = steerAroundIslands(w, ship, 2000, 2400); // due north; blocker is off to the east
  assert.equal(aim.deflected, false);
  assert.equal(aim.x, 2000);
  assert.equal(aim.y, 2400);
});

test('an island squarely in the path deflects the aim to a point clear of its land, on the target’s side', () => {
  const w = makeWorld();
  const t = w.rules;
  const B = isl('B', 2225, 1500);
  const Rland = islandLandRadius(B, t);
  withIslands(w, [B]);
  const ship = { x: 2000, y: 1500 };
  const aim = steerAroundIslands(w, ship, 2900, 1520); // target beyond B, nudged north
  assert.equal(aim.deflected, true, 'the blocker deflected the aim');
  const clear = Math.hypot(aim.x - B.x, aim.y - B.y);
  assert.ok(clear >= Rland, `the aim sits outside the drawn land (${clear.toFixed(1)} >= ${Rland.toFixed(1)})`);
  assert.ok(aim.y > B.y, 'it rounds on the side the target is on (north)');
});

test('the destination island is exempt — a hull heading in to dock is not steered away from it', () => {
  const w = makeWorld();
  // The only island IS the destination (target sits on its land): must stay enterable.
  withIslands(w, [isl('D', 2400, 1500)]);
  const ship = { x: 2000, y: 1500 };
  const aim = steerAroundIslands(w, ship, 2400, 1500);
  assert.equal(aim.deflected, false, 'a ship may sail into the island it is docking at');
  assert.equal(aim.x, 2400);
  assert.equal(aim.y, 1500);
});

test('sailing the real mover past a lone island: the hull rounds it, never enters the land, and reaches its target', () => {
  const w = makeWorld();
  const t = w.rules;
  const B = isl('B', 2300, 1500);
  const Rland = islandLandRadius(B, t);
  withIslands(w, [B]); // open-water target beyond a blocker dead on the rhumb line
  const ship = { x: 2000, y: 1500, heading: 0 };
  const T = { x: 2600, y: 1512 };
  const speed = t.SHIP_SPEED, h = t.SIM_STEP;
  let minClear = Infinity, arrived = false;
  for (let i = 0; i < 600; i++) {
    const aim = steerAroundIslands(w, ship, T.x, T.y);
    const hit = moveToward(ship, aim.x, aim.y, speed, h);
    minClear = Math.min(minClear, Math.hypot(ship.x - B.x, ship.y - B.y));
    if (hit && !aim.deflected) { arrived = true; break; } // reached the REAL target, not a way-round point
  }
  assert.ok(minClear >= Rland, `the hull never crossed the shore (closest ${minClear.toFixed(1)} >= land ${Rland.toFixed(1)})`);
  assert.ok(arrived, 'and it still made its destination');
  assert.ok(Math.hypot(ship.x - T.x, ship.y - T.y) < 1e-6, 'ending exactly on the target');
});

test('feature disabled (SHIP_ISLAND_CLEARANCE = null) is a straight pass-through — no deflection', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, SHIP_ISLAND_CLEARANCE: null };
  withIslands(w, [isl('B', 2300, 1500)]);
  const aim = steerAroundIslands(w, { x: 2000, y: 1500 }, 2600, 1500);
  assert.equal(aim.deflected, false);
  assert.equal(aim.x, 2600);
  assert.equal(aim.y, 1500);
});
