// Island development — a wealthy port invests surplus gold into a new hull from a shipyard.
// A real gold SINK + fleet growth (fixes the fleet that otherwise only dwindles) that stays
// economic (the hull is a Ship the yard built, bought and paid for) and self-limits (fleet caps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { development } from '/game/sim/development.js';

function aDayLater(w) { w.simTime += w.rules.SIM_DAY_SECONDS + 1; }

test('a flush port commissions a new hull from a shipyard — fleet grows, gold is spent', () => {
  const w = makeWorld();
  const t = w.rules;
  const buyer = w.islands[0];
  const yard = w.islands[1];
  buyer.gold = t.DEVELOP_SHIP_GOLD + 4000;
  buyer.stock.Ships = 0;
  yard.stock.Ships = 2;                 // a yard with hulls to sell
  buyer.rep[yard.id] = 0.1; yard.rep[buyer.id] = 0.1; // not embargoed
  const fleet0 = w.ships.length, owned0 = w.ships.filter((s) => s.homeId === buyer.id).length;
  const gold0 = buyer.gold, yardShips0 = yard.stock.Ships;

  aDayLater(w);
  development(w, t.SIM_STEP);

  assert.equal(w.ships.length, fleet0 + 1, 'a new ship joined the fleet');
  assert.equal(w.ships.filter((s) => s.homeId === buyer.id).length, owned0 + 1, 'it flies the buyer’s flag');
  assert.ok(buyer.gold < gold0, 'the buyer paid for it (a gold sink)');
  assert.equal(yard.stock.Ships, yardShips0 - 1, 'a hull was consumed from the yard');
  const built = w.ships[w.ships.length - 1];
  assert.ok(built.cargo.Gold === 0, 'the new hull sails with no working capital (no gold minting)');
});

test('a poor port cannot develop; a maxed-out fleet does not overbuild', () => {
  const w = makeWorld();
  const t = w.rules;
  const poor = w.islands[0];
  poor.gold = t.DEVELOP_SHIP_GOLD - 1; // just under the bar
  w.islands[1].stock.Ships = 5;
  const n0 = w.ships.length;
  aDayLater(w); development(w, t.SIM_STEP);
  assert.equal(w.ships.length, n0, 'too poor to invest → no ship built');

  // Now rich, but its fleet is already at the per-island cap.
  poor.gold = t.DEVELOP_SHIP_GOLD + 5000;
  const owned = w.ships.filter((s) => s.homeId === poor.id).length;
  for (let i = owned; i < t.MAX_SHIPS_PER_ISLAND; i++) w.ships.push({ ...w.ships[0], id: 'x' + i, homeId: poor.id });
  const n1 = w.ships.length;
  aDayLater(w); development(w, t.SIM_STEP);
  assert.equal(w.ships.filter((s) => s.homeId === poor.id).length <= t.MAX_SHIPS_PER_ISLAND, true, 'never exceeds the per-island fleet cap');
});

test('development is throttled to once per sim-day per port (cooldown)', () => {
  const w = makeWorld();
  const t = w.rules;
  const buyer = w.islands[0];
  buyer.gold = t.DEVELOP_SHIP_GOLD + 20000;
  w.islands[1].stock.Ships = 9;
  buyer.rep[w.islands[1].id] = 0.1; w.islands[1].rep[buyer.id] = 0.1;
  aDayLater(w); development(w, t.SIM_STEP);
  const after1 = w.ships.filter((s) => s.homeId === buyer.id).length;
  aDayLater(w); development(w, t.SIM_STEP); // next day, but still within the per-island cooldown
  const after2 = w.ships.filter((s) => s.homeId === buyer.id).length;
  assert.equal(after2, after1, 'the cooldown prevents a same-port build spree');
});
