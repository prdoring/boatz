// The Phase-4 snapshot projections that feed the almanac + the gated overlays: the enriched
// `economy` summary and the per-island fleet/havenPressure/unrest/embargoes fields. Builds a real
// sim world (helpers/simWorld) and asserts snapshotEconomy emits them with the right shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { snapshotEconomy, snapshotShipsCold } from '/game/sim/snapshot.js';

test('economy summary carries the almanac aggregates', () => {
  const e = snapshotEconomy(makeWorld()).economy;
  for (const k of ['totalGold', 'shipCount', 'people', 'pirates', 'privateers', 'havens']) {
    assert.equal(typeof e[k], 'number', `${k} is a number`);
    assert.ok(e[k] >= 0, `${k} is non-negative`);
  }
  assert.ok(e.pirates + e.privateers <= e.shipCount, 'faction hulls are a subset of the fleet');
});

test('per-island overlay fields are projected with the right shapes', () => {
  const snap = snapshotEconomy(makeWorld());
  assert.ok(snap.islands.length > 0);
  for (const isl of snap.islands) {
    assert.ok(isl.fleet && typeof isl.fleet.total === 'number', 'fleet census {total,...}');
    assert.equal(typeof isl.havenPressure, 'number');
    assert.equal(typeof isl.unrest, 'number');
    assert.ok(Array.isArray(isl.embargoes), 'embargoes is a list');
  }
});

test('per-home fleet census covers every ship exactly once', () => {
  const snap = snapshotEconomy(makeWorld());
  const sum = snap.islands.reduce((n, i) => n + i.fleet.total, 0);
  assert.equal(sum, snap.economy.shipCount, 'sum of home fleets == total ships');
});

test('cold ship projection carries the hunt-link fields (prey/siege/guard)', () => {
  const cold = snapshotShipsCold(makeWorld());
  const ids = Object.keys(cold);
  assert.ok(ids.length > 0, 'ships present');
  for (const id of ids) {
    const s = cold[id];
    assert.ok('prey' in s && 'siege' in s && 'guard' in s, `${id} exposes prey/siege/guard`);
  }
});
