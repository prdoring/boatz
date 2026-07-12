// Pirate havens — a failed island (lawlessness maxed, civilisation collapsed) falls to the black
// flag: it harbours pirates, and privateers can break it to redeem it back into a lawful port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { havens, havenCount, assaultHaven } from '/game/sim/havens.js';

function runHavens(w, days) {
  const steps = Math.round(days * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { havens(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}

/** Force an island into the fallen state (a wholly lawless, uncivilised, still-peopled port). */
function makeFailing(w, isl) {
  isl.lawlessness = 1;
  isl.civ = 0.05;
  isl.population = w.rules.POP_FLOOR * 5;
}

test('a wholly lawless, collapsed island falls to a pirate haven and its crews raise the black flag', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  makeFailing(w, isl);
  assert.ok(w.ships.some((s) => s.homeId === isl.id && !s.pirate), 'the port starts with honest ships');
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 2);
  assert.ok(isl.haven, 'the failing port fell to a haven');
  assert.equal(isl.magistrate, null, 'no lawful magistrate remains');
  assert.equal(havenCount(w), 1, 'it counts as a haven');
  assert.ok(w.ships.some((s) => s.pirate && s.homeId === isl.id), 'its own crews turned pirate to seed the haven');
});

test('a healthy island does NOT fall — the pressure has to be sustained', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.lawlessness = 0.2; isl.civ = 0.6; isl.population = 100; // orderly and prosperous
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 5);
  assert.ok(!isl.haven, 'an orderly port stays lawful');
});

test('a haven harbours its pirates — resupplying them and taking their fenced loot', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  makeFailing(w, isl);
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 2);
  assert.ok(isl.haven);
  isl.stock.Food = 200; const goldBefore = isl.gold || 0;
  // A hungry, plunder-laden pirate loitering in the haven's roads.
  const pir = { id: 'pTest', pirate: true, _sunk: false, x: isl.x, y: isl.y, capacity: 64,
    cargo: { Gold: 300, People: 0, Food: 0, Weapons: 6 } };
  w.ships.push(pir);
  havens(w, w.rules.SIM_STEP); // one proximity pass
  assert.ok((isl.gold || 0) > goldBefore, 'the haven took the pirate’s fenced coin');
  assert.ok((pir.cargo.Food || 0) > 0, 'the haven victualled the pirate crew');
  assert.ok((pir.cargo.Gold || 0) < 300, 'the pirate offloaded its plunder');
});

test('privateers break a haven and it is redeemed under a fresh lawful magistrate', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, HAVEN_ASSAULT_RISK: 0 }; // deterministic bombardment (no chance the striker sinks)
  const isl = w.islands[0];
  makeFailing(w, isl);
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 2);
  assert.ok(isl.haven, 'a haven to break');
  const striker = { id: 'privTest', name: 'HMS Resolute', privateer: true, x: isl.x, y: isl.y, cargo: {}, captain: { name: 'X', xp: 0 }, morale: 0.9 };
  for (let i = 0; i < 20 && isl.haven; i++) assaultHaven(w, striker, isl);
  assert.ok(!isl.haven, 'sustained bombardment broke the haven');
  assert.ok(isl.magistrate, 'a lawful magistrate retook the port');
  assert.ok(isl.magistrate.ambition, 'the new regime governs toward an agenda again');
  assert.ok(isl.lawlessness < 1, 'order is (partly) restored');
});
