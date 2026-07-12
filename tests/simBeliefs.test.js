// The information layer: imperfect, ship-carried price beliefs + scout voyages. Islands do
// not see others' live prices; they learn firsthand when their ships dock, beliefs age back
// toward the base-price prior, and an idle ship with a poorly-known neighbour goes scouting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { beliefMid, intelAge, observeAndGossip, intelSummary } from '/game/sim/beliefs.js';
import { planVoyage } from '/game/sim/goals.js';

test('an unknown market is valued at the base-price prior', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  // a has never heard b's Iron price → falls back to the economy base price, not b's live mid.
  b.price.Iron.mid = 99; // move b's live price far from base
  const believed = beliefMid(w, a, b.id, 'Iron', 0);
  assert.equal(believed, w.rules.PRICE_BASE.Iron);
  assert.notEqual(believed, 99);
});

test('docking teaches the port the ships firsthand sightings (not third-hand rumour)', () => {
  const w = makeWorld();
  const port = w.islands[0];
  const seen = w.islands[1];
  const ship = w.ships.find((s) => s.homeId !== port.id) || w.ships[0];
  // The ship has firsthand knowledge of `seen` (as if it docked there earlier), aged to today.
  ship.knows = { [seen.id]: { Iron: { mid: 42, day: 0 } } };
  w.simTime = 0;

  observeAndGossip(w, port, ship);

  // Port now believes seen's Iron price from the ship's log …
  assert.equal(beliefMid(w, port, seen.id, 'Iron', 0), 42);
  // … and the ship recorded the port's OWN live prices firsthand.
  assert.ok(ship.knows[port.id], 'ship logged the port it visited');
  assert.equal(ship.knows[port.id].Iron.mid, port.price.Iron.mid);
});

test('a belief decays back toward the base prior as it ages', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  const base = w.rules.PRICE_BASE.Iron;
  a.beliefs = { [b.id]: { Iron: { mid: base + 40, day: 0 } } };
  const stale = w.rules.BELIEF_STALE_DAYS;

  const fresh = beliefMid(w, a, b.id, 'Iron', 0);         // just heard
  const half = beliefMid(w, a, b.id, 'Iron', stale / 2);  // half-forgotten
  const gone = beliefMid(w, a, b.id, 'Iron', stale);      // fully forgotten

  assert.equal(fresh, base + 40);
  assert.ok(half > base && half < base + 40, 'a half-aged belief sits between memory and prior');
  assert.equal(gone, base, 'a fully-aged belief reverts to the base prior');
});

test('intelAge reports a huge age for an unheard-of island and shrinks after a sighting', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  assert.ok(intelAge(a, b.id, 10) > 1000, 'never heard of it → effectively infinite age');
  a.beliefs = { [b.id]: { Iron: { mid: 5, day: 7 } } };
  assert.equal(intelAge(a, b.id, 10), 3);
});

test('an idle ship with a poorly-known neighbour plans a scout voyage', () => {
  const w = makeWorld();
  // Pick a self-sufficient-looking island and strip any errand: no food need, no surplus,
  // no gold to shop/buy ships — so planning falls through to the scout branch.
  const home = w.islands[0];
  for (const r of w.economy._tradeables) home.stock[r] = home.targets[r]; // nothing to export, nothing lacking
  home.stock.Food = home.targets.Food * 3; // food-secure
  home.gold = 0;                            // can't buy ships or luxuries
  home.population = w.rules.POP_FLOOR;      // no migrants
  const ship = w.ships.find((s) => s.homeId === home.id);

  const v = planVoyage(w, home, ship);
  assert.ok(v, 'a voyage was planned');
  assert.equal(v.reason, 'scout');
  assert.ok(v.stops.length >= 1, 'scout visits at least one port');
  // A scout carries nothing — it goes to look, not to trade.
  for (const s of v.stops) {
    assert.equal(Object.keys(s.sell).length, 0);
    assert.equal(Object.keys(s.buy).length, 0);
    assert.equal(s.people, 0);
  }
});

test('intelSummary counts known vs fresh markets', () => {
  const w = makeWorld();
  const a = w.islands[0];
  const stale = w.rules.BELIEF_STALE_DAYS;
  a.beliefs = {
    x: { Iron: { mid: 5, day: 20 } },  // fresh at day 20
    y: { Iron: { mid: 5, day: 0 } },   // old at day 20 (age 20 ≥ stale/2)
  };
  const s = intelSummary(w, a, 20);
  assert.equal(s.known, 2);
  assert.equal(s.fresh, 1);
});
