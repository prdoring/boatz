// Headless draw-smoke for the world almanac (OverviewDashboard). The panel is hidden by default,
// so the browser smoke never renders it — this drives draw() over a Proxy canvas stub (every
// unknown method is a no-op; measureText/gradients return sane objects) for a scalar overlay, an
// edges overlay, and the off state, then exercises the click hit-tests (chip → setMetric, row →
// onPickIsland). Structural "does it throw / does it wire up?" coverage, not pixel checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverviewDashboard } from '/game/ui/OverviewDashboard.js';
import { OverlayModel } from '/game/overlayModel.js';
import { OVERLAYS, overlayByKey } from '/game/overlays.js';

// A Proxy stub: any method call is a no-op; measureText + gradients return real-enough objects.
function stubCtx() {
  const grad = { addColorStop() {} };
  const special = {
    measureText: () => ({ width: 12 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
  };
  return new Proxy({}, {
    get(t, p) { if (p in special) return special[p]; if (p in t) return t[p]; return () => {}; },
    set(t, p, v) { t[p] = v; return true; },
    has(t, p) { return p in t; },
  });
}

const ISLANDS = [
  { id: 'a', name: 'Ashport', x: 0, y: 0, k: 130, population: 100, gold: 4000, civ: 0.55, foodDays: 5.2, loyalty: 0.82, lawlessness: 0.18, grievance: 0.1, danger: 0.25, intel: { known: 6 }, allies: [{ id: 'b', v: 0.6 }] },
  { id: 'b', name: 'Goldreach', x: 500, y: 0, k: 200, population: 300, gold: 90000, civ: 0.9, foodDays: 12, loyalty: 0.95, lawlessness: 0.02, grievance: 0, danger: 0.05, intel: { known: 20 }, rebellion: true, allies: [{ id: 'a', v: 0.6 }] },
  { id: 'c', name: 'Barren Rock', x: 0, y: 500, k: 90, population: 0, gold: 0, civ: 0, foodDays: 0, loyalty: 1, lawlessness: 0, grievance: 0, danger: 0.7, intel: { known: 0 }, haven: { strength: 0.4 } },
];
const byId = new Map(ISLANDS.map((i) => [i.id, i]));

function makeDash(overKey, calls = {}) {
  const model = new OverlayModel();
  model.sync(ISLANDS, overlayByKey(overKey), {}, byId, 1000);
  const d = new OverviewDashboard({
    getModel: () => model,
    getSpec: () => overlayByKey(overKey),
    getSummary: () => ({ economy: { totalGold: 94000, shipCount: 12, people: 400, pirates: 3 }, season: { name: 'Summer' }, clock: { day: 42 }, islandCount: ISLANDS.length }),
    getRegistry: () => OVERLAYS,
    setMetric: (k) => { calls.metric = k; },
    onPickIsland: (id) => { calls.picked = id; },
    nameById: (id) => (byId.get(id) || {}).name || id,
  });
  d.visible = true;
  d.layout({ width: 1280, height: 720 });
  return { d, model, calls };
}

test('dashboard draws for a scalar overlay without throwing', () => {
  const { d } = makeDash('wealth');
  assert.doesNotThrow(() => d.draw(stubCtx()));
  assert.ok(d._chipRects.length > 0, 'picker chips laid out');
  assert.ok(d._rowRects.length > 0, 'leaderboard rows laid out');
});

test('dashboard draws for an edges overlay (legend, no leaderboard rows)', () => {
  const { d } = makeDash('alliances');
  assert.doesNotThrow(() => d.draw(stubCtx()));
  assert.ok(d._chipRects.length > 0, 'picker still present');
  assert.equal(d._rowRects.length, 0, 'no island rows for an edge overlay');
});

test('dashboard draws in the off state (picker + trouble, no distribution)', () => {
  const { d } = makeDash('off');
  assert.doesNotThrow(() => d.draw(stubCtx()));
});

test('clicking a picker chip switches the metric; a leaderboard row flies to that island', () => {
  const { d, calls } = makeDash('wealth');
  d.draw(stubCtx());
  const chip = d._chipRects.find((c) => c.key === 'danger');
  assert.ok(chip, 'a danger chip exists');
  assert.equal(d.onDown(chip.x + 2, chip.y + 2), true);
  assert.equal(calls.metric, 'danger');

  const row = d._rowRects[0];
  assert.equal(d.onDown(row.x + 4, row.y + 4), true);
  assert.ok(['a', 'b', 'c'].includes(calls.picked), 'a real island id was picked');
});

test('a click in empty panel space is swallowed but selects nothing', () => {
  const { d, calls } = makeDash('wealth');
  d.draw(stubCtx());
  // A point inside the panel rect but on no chip/row.
  const consumed = d.onDown(d.x + 4, d.y + 3);
  assert.equal(consumed, true, 'panel swallows the click (no world pick-through)');
  assert.equal(calls.picked, undefined);
  // A point outside the panel is not consumed.
  assert.equal(d.onDown(d.x + d.w + 50, d.y), false);
});
