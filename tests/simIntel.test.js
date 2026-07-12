// Information travels only by sea (intel.js): beyond price, an island learns another port's
// danger, haven status, and food distress ONLY from ships that dock carrying the news. These
// tests lock the "islands are omniscient about NOTHING" invariant: unheard facts aren't known,
// sightings propagate firsthand, and knowledge decays with age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import {
  observeFacts, sightAtSea, believedDanger, believedHaven, believedFoodDays, believedCiv, factSummary,
} from '/game/sim/intel.js';
import { findBestPartner } from '/game/sim/queries.js';

test('an island knows nothing of a port it has had no word from', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  b.danger = 1; b.haven = true; // b is live-dangerous and fallen…
  // …but a has heard nothing, so as far as a is concerned it's a safe, normal port.
  assert.equal(believedDanger(w, a, b.id, 0), 0, 'no sighting → no fear');
  assert.equal(believedHaven(w, a, b.id, 0), false, 'no sighting → not known to have fallen');
  assert.equal(believedFoodDays(w, a, b.id, 0), 999, 'no sighting → assume it is coping');
});

test('docking carries a ship’s firsthand sightings into the port (and the port’s facts into the ship)', () => {
  const w = makeWorld();
  w.simTime = 0;
  const port = w.islands[0];
  const seen = w.islands[1];
  const ship = w.ships.find((s) => s.homeId !== port.id) || w.ships[0];
  // The ship saw `seen` in trouble on its travels (firsthand, today).
  ship.intel = { [seen.id]: { day: 0, danger: 0.8, haven: false, foodDays: 1, lawless: 0.5 } };

  observeFacts(w, port, ship);

  // The port now believes what the ship reported about `seen` …
  assert.equal(believedDanger(w, port, seen.id, 0), 0.8, 'the port learned the danger from the ship');
  // … and the ship logged the port’s OWN live facts firsthand.
  assert.ok(ship.intel[port.id], 'the ship logged the port it visited');
  assert.equal(ship.intel[port.id].haven, !!port.haven);
});

test('a danger sighting decays to nil as it ages (old trouble is assumed cleared)', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  a.intel = { [b.id]: { day: 0, danger: 1, haven: false, foodDays: 5, lawless: 0 } };
  const stale = w.rules.INTEL_STALE_DAYS;

  assert.equal(believedDanger(w, a, b.id, 0), 1, 'just heard → full weight');
  const half = believedDanger(w, a, b.id, stale / 2);
  assert.ok(half > 0 && half < 1, 'half-aged → partly forgotten');
  assert.equal(believedDanger(w, a, b.id, stale), 0, 'fully aged → forgotten (assume the lane cleared)');
});

test('a haven sighting is trusted until it goes stale, then discounted (it may have been redeemed)', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  a.intel = { [b.id]: { day: 0, danger: 0, haven: true, foodDays: 5, lawless: 1 } };
  const forget = w.rules.INTEL_HAVEN_FORGET;

  assert.equal(believedHaven(w, a, b.id, 0), true, 'fresh word it fell → believed');
  assert.equal(believedHaven(w, a, b.id, forget), true, 'still within the trust horizon');
  assert.equal(believedHaven(w, a, b.id, forget + 1), false, 'old word is discounted (may be redeemed by now)');
});

test('a sailing ship sights the ports it passes firsthand, and misses the ones over the horizon', () => {
  const w = makeWorld();
  w.simTime = 0;
  const ship = w.ships[0];
  const near = w.islands[2];
  near.danger = 0.6;
  ship.x = near.x + 100; ship.y = near.y; // well within SIGHT_RANGE_AT_SEA
  ship.intel = {};

  sightAtSea(w, ship);

  assert.ok(ship.intel[near.id], 'a port close aboard is seen');
  assert.equal(ship.intel[near.id].danger, 0.6, 'and its live state is logged');
  const far = w.islands.find((i) => Math.hypot(i.x - ship.x, i.y - ship.y) > w.rules.SIGHT_RANGE_AT_SEA + 200);
  if (far) assert.ok(!ship.intel[far.id], 'a port over the horizon is not seen');
});

test('a port a ship reported fallen is not chosen as a trade partner', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const good = 'Wood';
  const [safe, fallen] = [w.islands[1], w.islands[2]];
  for (const p of [safe, fallen]) { p.stock[good] = 500; p.price[good].mid = home.price[good].mid; }
  // Word reached home that `fallen` raised the black flag.
  home.intel = { [fallen.id]: { day: 0, danger: 0, haven: true, foodDays: 5, lawless: 1 } };

  const pick = findBestPartner(w, home, good, 'import');
  assert.ok(pick, 'a partner was found');
  assert.notEqual(pick.partner.id, fallen.id, 'a port KNOWN to have fallen is shunned');
});

test('believed prosperity is the neutral prior when unheard, the reported civ when fresh, and blends back when stale', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  const prior = w.rules.INTEL_CIV_PRIOR;
  const stale = w.rules.INTEL_STALE_DAYS;
  // Unheard of → the neutral prior (migrants don't flock to a port nobody speaks of).
  assert.equal(believedCiv(w, a, b.id, 0), prior, 'no word → neutral prior');
  // Fresh word it is thriving → that reported prosperity.
  a.intel = { [b.id]: { day: 0, danger: 0, haven: false, foodDays: 5, civ: 0.9, lawless: 0 } };
  assert.equal(believedCiv(w, a, b.id, 0), 0.9, 'fresh word → the reported prosperity');
  // Stale word blends back toward the prior (yesterday's boom town may have foundered).
  const aged = believedCiv(w, a, b.id, stale);
  assert.ok(Math.abs(aged - prior) < 1e-9, 'fully aged → back to the neutral prior');
  const mid = believedCiv(w, a, b.id, stale / 2);
  assert.ok(mid > prior && mid < 0.9, 'half-aged → part way back to the prior');
});

test('docking carries reported PROSPERITY (civ) too, so migration follows heard-of prosperity', () => {
  const w = makeWorld();
  w.simTime = 0;
  const port = w.islands[0], seen = w.islands[1];
  const ship = w.ships.find((s) => s.homeId !== port.id) || w.ships[0];
  ship.intel = { [seen.id]: { day: 0, danger: 0, haven: false, foodDays: 8, civ: 0.75, lawless: 0.1 } };
  observeFacts(w, port, ship);
  assert.equal(believedCiv(w, port, seen.id, 0), 0.75, 'the port learned how prosperous `seen` is from the ship');
});

test('factSummary counts known vs fresh ports', () => {
  const w = makeWorld();
  const a = w.islands[0];
  const stale = w.rules.INTEL_STALE_DAYS;
  a.intel = {
    x: { day: 20, danger: 0, haven: false, foodDays: 5, lawless: 0 }, // fresh at day 20
    y: { day: 0, danger: 0, haven: false, foodDays: 5, lawless: 0 },  // old at day 20 (age 20 ≥ stale/2)
  };
  const s = factSummary(w, a, 20);
  assert.equal(s.known, 2);
  assert.equal(s.fresh, 1);
});
