// Headless render-smoke for the ACTIVE data overlays. The browser smoke only loads the map
// with the overlay off, so this drives WorldRenderer.drawOverlay directly (through a no-op
// canvas stub, the worldRendererBerths pattern) across every scalar metric at both full-disc
// and LOD-dot zoom, and over awkward ports (0-population, missing stats) — the paths a live
// overlay actually hits. Pure "does it throw?" coverage; correctness of the math lives in
// overviewOverlays.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldRenderer } from '/game/WorldRenderer.js';
import { OVERLAYS, aggregate } from '/game/overlays.js';
import { OverlayModel } from '/game/overlayModel.js';

function fakeCtx() {
  const grad = { addColorStop() {} };
  return {
    save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    fillRect() {}, strokeRect() {}, moveTo() {}, lineTo() {}, fillText() {}, strokeText() {},
    setLineDash() {}, createRadialGradient() { return grad; }, measureText() { return { width: 10 }; },
  };
}
function renderer(zoom) {
  const camera = { getZoom: () => zoom, worldToScreen: (x, y) => ({ sx: x, sy: y }) };
  return new WorldRenderer(fakeCtx(), camera, { ships: {} }, {}, {});
}
const BOUNDS = { left: -1e6, right: 1e6, top: -1e6, bottom: 1e6 };
const scalars = OVERLAYS.filter((o) => o.kind === 'scalar');

// A realistic mix: a healthy port, a rich metropolis (outlier), a starving rock with 0 pop,
// and a half-formed island missing several stats (pre-econ-frame shape).
const ISLANDS = [
  { id: 'a', name: 'Ashport', x: 0, y: 0, k: 130, population: 100, gold: 4000, civ: 0.55, foodDays: 5.2, loyalty: 0.82, lawlessness: 0.18, grievance: 0.1, danger: 0.25, intel: { known: 6, fresh: 3 } },
  { id: 'b', name: 'Goldreach', x: 500, y: 0, k: 200, population: 300, gold: 90000, civ: 0.9, foodDays: 12, loyalty: 0.95, lawlessness: 0.02, grievance: 0, danger: 0.05, intel: { known: 20, fresh: 12 } },
  { id: 'c', name: 'Barren Rock', x: 0, y: 500, k: 90, population: 0, gold: 0, civ: 0, foodDays: 0, loyalty: 1, lawlessness: 0, grievance: 0, danger: 0.7, intel: { known: 0, fresh: 0 } },
  { id: 'd', name: 'Half Isle', x: 500, y: 500, k: 130, population: 40 }, // missing civ/gold/food/etc.
];

test('drawOverlay runs for every scalar metric at full-disc zoom', () => {
  const wr = renderer(1);
  for (const spec of scalars) {
    const stats = aggregate(ISLANDS, spec);
    assert.doesNotThrow(() => wr.drawOverlay(ISLANDS, BOUNDS, spec, stats, 1000), `${spec.key} full disc`);
  }
});

test('drawOverlay takes the LOD dot path when islands are tiny on screen', () => {
  const wr = renderer(0.05); // R = islandRadius*0.05 ≈ 3px < ISLE_LOD_MIN
  for (const spec of scalars) {
    const stats = aggregate(ISLANDS, spec);
    assert.doesNotThrow(() => wr.drawOverlay(ISLANDS, BOUNDS, spec, stats, 1000), `${spec.key} LOD dot`);
  }
});

test('drawOverlay no-ops safely with null stats or a non-scalar spec', () => {
  const wr = renderer(1);
  const spec = scalars[0];
  assert.doesNotThrow(() => wr.drawOverlay(ISLANDS, BOUNDS, spec, null, 1000));
  assert.doesNotThrow(() => wr.drawOverlay(ISLANDS, BOUNDS, OVERLAYS[0], { lo: 0, hi: 1 }, 1000)); // off
});

test('drawRelations runs for every edge kind and culls off-screen links', () => {
  const wr = renderer(1);
  const edges = [
    { ax: 0, ay: 0, bx: 400, by: 0, kind: 'ally', v: 0.8 },
    { ax: 0, ay: 0, bx: 0, by: 400, kind: 'rival', v: 0.3 },
    { ax: 0, ay: 0, bx: 400, by: 400, kind: 'lane', weight: 5 },
    { ax: 100, ay: 100, bx: 400, by: 0, kind: 'aid' },
    { ax: 0, ay: 0, bx: 200, by: 300, kind: 'embargo', v: 1 },
    { ax: 10, ay: 10, bx: 300, by: 50, kind: 'hunt' },
    { ax: 20, ay: 20, bx: 350, by: 80, kind: 'guard' },
  ];
  const tight = { left: -10, right: 500, top: -10, bottom: 500 };
  const offscreen = [{ ax: 9000, ay: 9000, bx: 9400, by: 9000, kind: 'ally', v: 1 }];
  assert.doesNotThrow(() => wr.drawRelations(edges, tight, OVERLAYS.find((o) => o.key === 'alliances'), 1000));
  assert.doesNotThrow(() => wr.drawRelations(offscreen, tight, OVERLAYS.find((o) => o.key === 'alliances'), 1000), 'off-screen culled, no draw');
  assert.doesNotThrow(() => wr.drawRelations([], tight, OVERLAYS.find((o) => o.key === 'lanes'), 1000), 'empty set is a no-op');
});

test('OverlayModel.sync populates stats + leaderboard for a scalar and clears for off', () => {
  const m = new OverlayModel();
  const wealth = OVERLAYS.find((o) => o.key === 'wealth');
  m.sync(ISLANDS, wealth, {}, new Map(ISLANDS.map((i) => [i.id, i])), 1000);
  assert.ok(m.stats && m.stats.count > 0, 'stats computed');
  assert.ok(m.stats.leaderboard && m.stats.leaderboard.rankById.size > 0, 'leaderboard computed');
  assert.ok(m.trouble && typeof m.trouble.starving === 'number', 'trouble tallied');
  // Switching to off on the next (non-throttled) call clears stats.
  m.sync(ISLANDS, OVERLAYS[0], {}, new Map(), 2000);
  assert.equal(m.stats, null);
});

test('OverlayModel.sync builds edges (not stats) for a relational overlay', () => {
  const m = new OverlayModel();
  const islands = [{ id: 'a', x: 0, y: 0, allies: [{ id: 'b', v: 0.6 }] }, { id: 'b', x: 100, y: 0 }];
  const byId = new Map(islands.map((i) => [i.id, i]));
  m.sync(islands, OVERLAYS.find((o) => o.key === 'alliances'), {}, byId, 1000);
  assert.ok(Array.isArray(m.edges) && m.edges.length === 1, 'one deduped ally edge');
  assert.equal(m.stats, null);
});
