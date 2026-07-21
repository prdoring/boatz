// The PIRATE LORD (pirateLord.js + havens.js) — Phase 6, the dark mirror of the magistrate. A fallen
// port's magistrate is cast out and a Pirate Lord seizes it; the den KEEPS its war works while civilian
// works ROT; redemption clears the lord (its fenced hoard scatters — a SINK) and grants reconstruction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { mutateWorkshops } from '/game/sim/island.js';
import { upkeep } from '/game/sim/upkeep.js';
import { havens, assaultHaven } from '/game/sim/havens.js';

test('a failing port FALLS: its magistrate is cast out and a Pirate Lord seizes the den (with a handover)', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.lawlessness = 1; isl.civ = 0.1; isl.population = 500;   // wholly failing
  isl._havenPressure = t.HAVEN_FALL_DAYS;                      // already on the brink
  assert.ok(isl.magistrate, 'starts under a lawful magistrate');
  w.simTime += t.SIM_DAY_SECONDS;
  havens(w, t.SIM_STEP);
  assert.equal(isl.haven, true, 'the port fell to a haven');
  assert.ok(isl.pirateLord && isl.pirateLord.name, 'a named Pirate Lord seized it');
  assert.ok(isl.pirateLord.agenda && isl.pirateLord.agenda.kind, 'the lord holds a war agenda');
  assert.equal(isl.magistrate, null, 'the lawful magistrate is gone');
  const ev = w.events.find((e) => e.kind === 'haven' && e.islandId === isl.id);
  assert.ok(ev && ev.data && ev.data.regime && ev.data.regime.cause === 'piratefall', 'the fall carries a piratefall handover marker');
});

test('under the black flag, CIVILIAN works rot while WAR works (Weapons/Ships) are kept', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  mutateWorkshops(w, isl, [{ good: 'Clothing', condition: 1 }, { good: 'Weapons', condition: 1 }, { good: 'Food', condition: 1 }]);
  isl.haven = true; isl.magistrate = null;
  isl.pirateLord = { name: 'X', traits: { cruelty: 0.5, cunning: 0.5, avarice: 0 }, agenda: { kind: 'plunder' }, hoard: 0, xp: 0 };
  isl.population = 400; isl.gold = t.GOLD_MAX_PER_POP * 400;   // flush → its war works stay funded
  const cloth = isl.workshops.find((s) => s.good === 'Clothing');
  const weap = isl.workshops.find((s) => s.good === 'Weapons');
  for (let d = 0; d < 30; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.ok(cloth.condition < 0.2, `the civilian Clothing works rotted (${cloth.condition.toFixed(2)})`);
  assert.ok(weap.condition > 0.6, `the WAR Weapons works were kept (${weap.condition.toFixed(2)})`);
});

test('redemption clears the Pirate Lord (its hoard scatters — a SINK) and grants reconstruction', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.haven = true; isl.havenStrength = 0.05; isl.magistrate = null;
  isl.pirateLord = { name: 'Redhand', traits: { cruelty: 0.5, cunning: 0.5, avarice: 1 }, agenda: { kind: 'hoard' }, hoard: 9999, voiceSeed: 1, portrait: 1, xp: 0 };
  mutateWorkshops(w, isl, [{ good: 'Weapons', condition: 0 }]);
  const gold0 = isl.gold;
  const striker = { name: 'Hunter', hull: 1, rig: 1, id: 'h1' };
  assaultHaven(w, striker, isl); // batters the last of its grip → redemption
  assert.equal(isl.haven, false, 'the haven was redeemed');
  assert.ok(isl.magistrate && isl.magistrate.name, 'a lawful magistrate retook the port');
  assert.equal(isl.pirateLord, null, 'the Pirate Lord is gone');
  assert.ok(isl.gold <= gold0 + 100, 'the fenced hoard scattered — it was NOT banked into the treasury');
  assert.ok(isl.workshops[0].condition >= 0.4, 'the reconstruction grant restored the works');
});
