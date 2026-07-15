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

test('a baseline of rogues is kept at large — a fresh raider sails in when the seas fall quiet', () => {
  const w = makeWorld();
  w.ships = w.ships.filter((s) => !s.pirate); // clear the seas of the seeded rogues
  w._rogueCd = 0; w._havenDay = -1;           // reset the cooldown + force the daily check
  assert.equal(w.ships.filter((s) => s.pirate).length, 0, 'seas start empty of pirates');
  havens(w, w.rules.SIM_STEP);
  const raised = w.ships.filter((s) => s.pirate);
  assert.ok(raised.length >= 1, 'a rogue sailed in to keep the seas from going empty');
  assert.ok((raised[0].cargo.Weapons || 0) > 0, 'and it is armed');
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
  // A blow lands at most ONCE PER DAY, so breaking a den takes a hunter holding station for days.
  for (let d = 0; d < 15 && isl.haven; d++) { assaultHaven(w, striker, isl); w.simTime += w.rules.SIM_DAY_SECONDS; }
  assert.ok(!isl.haven, 'sustained day-after-day bombardment broke the haven');
  assert.ok(isl.magistrate, 'a lawful magistrate retook the port');
  assert.ok(isl.magistrate.ambition, 'the new regime governs toward an agenda again');
  assert.ok(isl.lawlessness < 1, 'order is (partly) restored');
});

test('a haven can be battered only ONCE PER DAY BY EACH STRIKER — no instant redemption from tick-spam', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, HAVEN_ASSAULT_RISK: 0 };
  const isl = w.islands[0];
  makeFailing(w, isl);
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 2);
  assert.ok(isl.haven, 'a haven to besiege');
  const striker = { id: 'p2', name: 'HMS Vigil', privateer: true, x: isl.x, y: isl.y, cargo: {}, captain: { name: 'Y', xp: 0 }, morale: 0.9 };
  const before = isl.havenStrength;
  // Fifty assaults from ONE hunter in the SAME day (as the per-substep loop would): only the first lands.
  for (let i = 0; i < 50; i++) assaultHaven(w, striker, isl);
  assert.ok(isl.haven, 'the haven is NOT redeemed by same-day tick-spam');
  assert.ok(Math.abs(isl.havenStrength - (before - w.rules.HAVEN_SUPPRESS_PER_HIT)) < 1e-9, 'exactly one blow landed from that ship all day');
});

test('a COMBINED siege bites harder — each besieger lands its OWN blow per day (not one for the whole den)', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, HAVEN_ASSAULT_RISK: 0 }; // deterministic (no striker sinks)
  const isl = w.islands[0];
  makeFailing(w, isl);
  runHavens(w, w.rules.HAVEN_FALL_DAYS + 2);
  assert.ok(isl.haven, 'a haven to besiege');
  const before = isl.havenStrength;
  const mk = (id) => ({ id, name: id, privateer: true, x: isl.x, y: isl.y, cargo: {}, captain: { name: id, xp: 0 }, morale: 0.9 });
  const a = mk('privA'), b = mk('privB'), c = mk('privC');
  // Three hunters on station, same day → three blows land (the old per-HAVEN cap let a whole squadron do
  // no more than a single ship). 3·0.11 = 0.33 < START 0.85, so the den survives — we measure the damage.
  assaultHaven(w, a, isl); assaultHaven(w, b, isl); assaultHaven(w, c, isl);
  assert.ok(isl.haven, 'three blows dented but did not yet break the den');
  assert.ok(Math.abs((before - isl.havenStrength) - 3 * w.rules.HAVEN_SUPPRESS_PER_HIT) < 1e-9, 'three besiegers → three hits in a day');
  // A second salvo the SAME day from the same ships adds nothing (the per-striker daily throttle still holds).
  assaultHaven(w, a, isl); assaultHaven(w, b, isl);
  assert.ok(Math.abs((before - isl.havenStrength) - 3 * w.rules.HAVEN_SUPPRESS_PER_HIT) < 1e-9, 'no extra blows from the same ships the same day');
});
