// Ship types — sloop / brig / galleon: distinct capacity, speed, gun capacity, combat, and upkeep,
// so a port's choice of hull is a real trade-off (volume vs speed vs fight vs cost). These tests
// pin the per-hull stats and the context-driven build choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { createShip, chooseShipType } from '/game/sim/ship.js';
import { combatStrength } from '/game/sim/piracy.js';

test('each hull class carries its own capacity and speed', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const sloop = createShip(1, home, w.rules, 'sloop');
  const brig = createShip(2, home, w.rules, 'brig');
  const galleon = createShip(3, home, w.rules, 'galleon');
  assert.ok(sloop.capacity < brig.capacity && brig.capacity < galleon.capacity, 'capacity grows sloop→galleon');
  assert.ok(sloop.speed > brig.speed && brig.speed > galleon.speed, 'speed falls sloop→galleon (big is slow)');
  assert.equal(sloop.type, 'sloop');
  assert.equal(galleon.type, 'galleon');
});

test('a galleon can out-gun a sloop — hull gun capacity caps the fight contribution', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const sloop = createShip(1, home, w.rules, 'sloop');
  const galleon = createShip(2, home, w.rules, 'galleon');
  // Load both to the gunwales (same crew/captain) — the galleon mounts far more guns.
  sloop.cargo.Weapons = 200; galleon.cargo.Weapons = 200;
  sloop.morale = galleon.morale = 0.6;
  sloop.captain = galleon.captain = { xp: 100 };
  assert.ok(combatStrength(w, galleon) > combatStrength(w, sloop), 'the galleon fights harder fully armed');
});

test('a threatened port builds a fighting brig; a rich one builds a galleon; a poor one a sloop', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  const T = w.rules.SHIP_TYPES;
  isl.gold = 0; isl.danger = 0;
  assert.equal(chooseShipType(w, isl), 'sloop', 'a poor, safe port runs a cheap sloop');
  isl.gold = T.galleon.minTreasury + 500; isl.danger = 0;
  assert.equal(chooseShipType(w, isl), 'galleon', 'a wealthy hub hauls volume in a galleon');
  isl.gold = T.brig.minTreasury + 50; isl.danger = 0.7;
  assert.equal(chooseShipType(w, isl), 'brig', 'a threatened port arms with a brig');
});
