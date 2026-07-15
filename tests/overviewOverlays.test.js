// Pure math behind the map data-overlays (game/overlays.js) — normalisation, auto-ranging,
// aggregation, leaderboards, relational-edge extraction, and the cull helper. All canvas-free,
// so they run directly in Node with plain island/ship literals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAYS, overlayByKey, cycleOverlay, fmtValue,
  heatColor, neutralColor, clamp01,
  percentile, computeDomain, normalize, aggregate, leaderboard, troubleCounts,
  relationEdges, laneEdges, aidEdges, embargoEdges, huntEdges, segmentInBounds,
} from '/game/overlays.js';

// ─── registry integrity ──────────────────────────────────────────────────────
test('OVERLAYS: off is first; every scalar carries the fields the renderer/legend need', () => {
  assert.equal(OVERLAYS[0].key, 'off');
  assert.equal(OVERLAYS[0].kind, 'off');
  for (const o of OVERLAYS) {
    if (o.kind !== 'scalar') continue;
    assert.equal(typeof o.accessor, 'function', `${o.key} has accessor`);
    assert.equal(typeof o.vfmt, 'function', `${o.key} has vfmt`);
    assert.ok(o.label && o.icon && o.category, `${o.key} has label/icon/category`);
    assert.ok(o.domain === 'unit' || o.domain === 'auto' || Array.isArray(o.domain), `${o.key} domain valid`);
  }
});

test('overlayByKey falls back to off; fmtValue formats or dashes missing data', () => {
  assert.equal(overlayByKey('nope').key, 'off');
  const civ = overlayByKey('prosperity');
  assert.equal(fmtValue(civ, { civ: 0.42 }), '42%');
  assert.equal(fmtValue(civ, {}), '—'); // civ undefined → no data
});

test('cycleOverlay steps through scalars with off in the ring, both directions', () => {
  const first = cycleOverlay('off', 'scalar', 1);
  assert.equal(first, 'wealth'); // first scalar in the registry
  const back = cycleOverlay('off', 'scalar', -1);
  assert.equal(back, 'intel'); // last scalar (wraps backward past off)
  // a full forward loop returns to off
  let k = 'off', steps = 0;
  do { k = cycleOverlay(k, 'scalar', 1); steps++; } while (k !== 'off' && steps < 50);
  assert.equal(k, 'off');
  assert.equal(steps, OVERLAYS.filter((o) => o.kind === 'scalar').length + 1);
});

// ─── colour ──────────────────────────────────────────────────────────────────
test('heatColor anchors red→amber→green and clamps out-of-range t', () => {
  assert.match(heatColor(0), /^rgba\(200,60,50,/);
  assert.match(heatColor(1), /^rgba\(90,200,110,/);
  assert.equal(heatColor(-2), heatColor(0));
  assert.equal(heatColor(5), heatColor(1));
  assert.match(heatColor(0.5, 0.3), /,0\.3\)$/);
  assert.match(neutralColor(0.5), /^rgba\(122,140,150,0\.5\)$/);
});

// ─── percentile / domain / normalize ─────────────────────────────────────────
test('percentile interpolates; edge p-values hit the ends', () => {
  const s = [10, 20, 30, 40];
  assert.equal(percentile(s, 0.5), 25);
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile(s, 1), 40);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([], 0.5), 0);
});

test('computeDomain: minmax, p5p95, empty, single, all-equal', () => {
  assert.deepEqual(computeDomain([5, 1, 9, 3], 'minmax'), { lo: 1, hi: 9 });
  assert.deepEqual(computeDomain([], 'p5p95'), { lo: 0, hi: 1 });
  assert.deepEqual(computeDomain([42], 'p5p95'), { lo: 42, hi: 42 });
  assert.deepEqual(computeDomain([5, 5, 5, 5], 'p5p95'), { lo: 5, hi: 5 }); // degenerate → min/max
  const d = computeDomain([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 'p5p95');
  assert.ok(d.lo >= 0 && d.hi < 100, 'p95 clamps the 100 outlier out of the top');
});

test('normalize clamps, halves a degenerate domain, and rejects non-finite', () => {
  assert.equal(normalize(5, 0, 10), 0.5);
  assert.equal(normalize(-3, 0, 10), 0);
  assert.equal(normalize(15, 0, 10), 1);
  assert.equal(normalize(5, 5, 5), 0.5); // hi<=lo
  assert.equal(normalize(null, 0, 10), null);
  assert.equal(normalize(NaN, 0, 10), null);
  assert.equal(clamp01(2), 1);
});

// ─── aggregate ────────────────────────────────────────────────────────────────
const spec = (over) => ({ accessor: (i) => (i.m == null ? null : i.m), domain: 'auto', skipEmpty: false, good: true, ...over });

test('aggregate: median/min/max/count over finite values, skipping nulls', () => {
  const islands = [{ m: 10 }, { m: 20 }, { m: 30 }, { m: 40 }, { m: null }, { foo: 1 }];
  const a = aggregate(islands, spec());
  assert.equal(a.count, 4);
  assert.equal(a.min, 10);
  assert.equal(a.max, 40);
  assert.equal(a.p50, 25);
  assert.equal(a.mean, 25);
});

test('aggregate: skipEmpty drops 0-population ports from the range', () => {
  const islands = [{ m: 100, population: 0 }, { m: 10, population: 5 }, { m: 20, population: 8 }];
  const a = aggregate(islands, spec({ skipEmpty: true }));
  assert.equal(a.count, 2);
  assert.equal(a.max, 20, 'the 0-pop metropolis is excluded');
});

test('aggregate: unit domain is fixed 0..1; empty set is safe', () => {
  const a = aggregate([{ m: 0.3 }, { m: 0.6 }], spec({ domain: 'unit' }));
  assert.equal(a.lo, 0);
  assert.equal(a.hi, 1);
  const empty = aggregate([], spec());
  assert.equal(empty.count, 0);
  assert.deepEqual({ lo: empty.lo, hi: empty.hi }, { lo: 0, hi: 1 });
});

// ─── leaderboard ──────────────────────────────────────────────────────────────
test('leaderboard orients by good, ranks all, and bottom is worst-first', () => {
  const islands = [
    { id: 'a', name: 'A', m: 5 }, { id: 'b', name: 'B', m: 9 },
    { id: 'c', name: 'C', m: 1 }, { id: 'd', name: 'D', m: 7 },
  ];
  const good = leaderboard(islands, spec(), 2);
  assert.deepEqual(good.top.map((r) => r.id), ['b', 'd'], 'highest first when good');
  assert.deepEqual(good.bottom.map((r) => r.id), ['c', 'a'], 'worst (lowest) first');
  assert.equal(good.rankById.get('b'), 1);
  assert.equal(good.rankById.get('c'), 4);
  assert.equal(good.count, 4);

  const bad = leaderboard(islands, spec({ good: false }), 2);
  assert.deepEqual(bad.top.map((r) => r.id), ['c', 'a'], 'lowest first when bad');
  assert.equal(bad.rankById.get('c'), 1);
});

test('leaderboard: n greater than the population is clamped', () => {
  const lb = leaderboard([{ id: 'a', name: 'A', m: 1 }], spec(), 8);
  assert.equal(lb.top.length, 1);
  assert.equal(lb.count, 1);
});

// ─── trouble counts ────────────────────────────────────────────────────────────
test('troubleCounts tallies world afflictions', () => {
  const islands = [
    { population: 10, foodDays: 0.5 },              // starving
    { population: 10, foodDays: 5, rebellion: true },
    { population: 10, foodDays: 5, haven: { strength: 0.4 } },
    { population: 10, foodDays: 5, lawlessness: 0.6 },
    { population: 10, foodDays: 5, blight: 'Grain', plague: true },
    { population: 0, foodDays: 0 },                 // 0-pop rock is NOT counted as starving
  ];
  const t = troubleCounts(islands);
  assert.equal(t.starving, 1);
  assert.equal(t.rebelling, 1);
  assert.equal(t.havens, 1);
  assert.equal(t.lawless, 1);
  assert.equal(t.blighted, 1);
  assert.equal(t.plagued, 1);
});

// ─── relational edges ───────────────────────────────────────────────────────────
test('relationEdges dedupes reciprocal pairs and skips missing partners', () => {
  const islands = [
    { id: 'a', x: 0, y: 0, allies: [{ id: 'b', v: 0.5 }], rivals: [{ id: 'z', v: -0.6 }] },
    { id: 'b', x: 10, y: 0, allies: [{ id: 'a', v: 0.4 }] },  // reciprocal ally of a
    { id: 'c', x: 0, y: 10, rivals: [{ id: 'a', v: -0.3 }] },
  ];
  const byId = { a: islands[0], b: islands[1], c: islands[2] };
  const edges = relationEdges(islands, byId);
  const ally = edges.filter((e) => e.kind === 'ally');
  const rival = edges.filter((e) => e.kind === 'rival');
  assert.equal(ally.length, 1, 'a↔b collapse to one ally edge');
  assert.equal(rival.length, 1, 'only a↔c survives; the missing z partner is skipped');
  assert.equal(ally[0].ax, 0); assert.equal(ally[0].bx, 10);
  assert.ok(ally[0].v > 0, 'edge carries |reputation|');
});

test('relationEdges works with a Map islandsById too', () => {
  const islands = [{ id: 'a', x: 0, y: 0, allies: [{ id: 'b', v: 0.5 }] }, { id: 'b', x: 5, y: 5 }];
  const byId = new Map(islands.map((i) => [i.id, i]));
  assert.equal(relationEdges(islands, byId).length, 1);
});

// ─── lane edges ─────────────────────────────────────────────────────────────────
test('laneEdges accumulates traffic weight per undirected leg and resolves positions', () => {
  const ships = {
    s1: { route: ['a', 'b', 'c'] },
    s2: { route: ['b', 'a'] },   // same a↔b leg, opposite direction
    s3: { route: ['a'] },        // too short — ignored
    s4: { route: ['a', 'z'] },   // z has no island — dropped at resolve
  };
  const byId = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 0 } };
  const edges = laneEdges(ships, byId);
  const ab = edges.find((e) => (e.a === 'a' && e.b === 'b'));
  const bc = edges.find((e) => (e.a === 'b' && e.b === 'c'));
  assert.equal(ab.weight, 2, 'a→b and b→a both count the same leg');
  assert.equal(bc.weight, 1);
  assert.ok(!edges.some((e) => e.a === 'a' && e.b === 'z'), 'unresolved island dropped');
});

test('aidEdges links aid-errand ships to the port they relieve, skipping others', () => {
  const ships = {
    s1: { reason: 'aid', destId: 'b', x: 5, y: 5, homeId: 'a' },
    s2: { reason: 'trade', destId: 'b', x: 1, y: 1, homeId: 'a' }, // not an aid errand
    s3: { reason: 'aid', destId: 'zz', x: 2, y: 2, homeId: 'a' },  // destination island missing
    s4: { reason: 'aid', destId: 'b', homeId: 'a' },               // no live position
  };
  const byId = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  const edges = aidEdges(ships, byId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'aid');
  assert.deepEqual([edges[0].ax, edges[0].ay, edges[0].bx, edges[0].by], [5, 5, 10, 0]);
});

test('embargoEdges builds deduped severed-trade edges, skipping missing partners', () => {
  const islands = [
    { id: 'a', x: 0, y: 0, embargoes: ['b', 'zz'] },
    { id: 'b', x: 10, y: 0, embargoes: ['a'] }, // reciprocal → collapses to one edge
    { id: 'c', x: 0, y: 10 },                    // no embargoes
  ];
  const byId = { a: islands[0], b: islands[1], c: islands[2] };
  const edges = embargoEdges(islands, byId);
  assert.equal(edges.length, 1, 'a↔b collapse; the missing zz partner is skipped');
  assert.equal(edges[0].kind, 'embargo');
});

test('huntEdges links pirates to prey/sieges and privateers to quarry/guarded ports', () => {
  const ships = {
    p1: { pirate: true, x: 0, y: 0, prey: 'm1', siege: 'i1' }, // hunting a ship + besieging a port
    m1: { x: 50, y: 0 },
    v1: { privateer: true, x: 10, y: 10, prey: 'p1' },         // chasing a pirate
    v2: { privateer: true, x: 20, y: 20, guard: 'i1' },        // patrolling a port
    m2: { x: 5, y: 5 },                                        // plain merchant → no edges
  };
  const byId = { i1: { x: 100, y: 100 } };
  const edges = huntEdges(ships, byId);
  assert.equal(edges.filter((e) => e.kind === 'hunt').length, 2, 'pirate→prey + pirate→siege');
  assert.equal(edges.filter((e) => e.kind === 'guard').length, 2, 'privateer→pirate + privateer→port');
});

// ─── cull helper ─────────────────────────────────────────────────────────────────
test('segmentInBounds: inside, crossing, and fully-outside', () => {
  const b = { left: 0, right: 100, top: 0, bottom: 100 };
  assert.equal(segmentInBounds(10, 10, 90, 90, b), true, 'inside');
  assert.equal(segmentInBounds(-50, 50, 50, 50, b), true, 'crossing the left edge');
  assert.equal(segmentInBounds(200, 200, 300, 300, b), false, 'fully outside');
  assert.equal(segmentInBounds(-50, -50, -10, -10, b), false, 'outside to the top-left');
});
