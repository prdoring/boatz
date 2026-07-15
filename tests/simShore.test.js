// Shore batteries — an island fires back at hostile shipping in its waters. A lawful port shells pirates
// with its armoury (spending powder — a Weapons sink); a pirate haven shells besieging privateers with its
// entrenchment. Guns scale with the garrison; a lingering raider can be worn down and sunk. These lock the
// hostility rules (who fires at whom), the range gate, the powder sink, and the sink roll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { shoreBatteries } from '/game/sim/shore.js';
import { turnPirate, weaponsAboard } from '/game/sim/piracy.js';

test('a lawful port’s SHORE BATTERIES wear down a pirate in its roads (guns burned, powder spent) but spare distant ships', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PORT_CANNON_SINK: 0 }; // isolate the burn/powder from the sink roll
  const isl = w.islands[0]; isl.haven = false;
  isl.stock = { ...(isl.stock || {}), Weapons: 50 };            // a well-found armoury
  const near = w.ships[0], far = w.ships[1];
  turnPirate(w, near); turnPirate(w, far);
  near.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 };
  far.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 };
  near.x = isl.x + 150; near.y = isl.y;                         // inside PORT_CANNON_RANGE
  far.x = isl.x + w.rules.PORT_CANNON_RANGE + 600; far.y = isl.y; // well outside it
  w.ships = [near, far];
  const armouryBefore = isl.stock.Weapons;

  for (let i = 0; i < 800; i++) { shoreBatteries(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
  assert.ok(weaponsAboard(near) < 20, 'the near raider lost guns to shore fire');
  assert.equal(weaponsAboard(far), 20, 'the distant ship was out of range and untouched');
  assert.ok(isl.stock.Weapons < armouryBefore, 'the port burned powder returning fire (a Weapons sink)');
  assert.ok(!near._sunk, 'with the sink roll disabled, fire only wore the raider down');
});

test('a lawful port with an EMPTY armoury cannot fire (self-limiting — no guns, no batteries)', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PORT_CANNON_SINK: 5 }; // a sure hit IF it could fire
  const isl = w.islands[0]; isl.haven = false;
  isl.stock = { ...(isl.stock || {}), Weapons: 0 };             // disarmed → silent
  const pirate = w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 };
  pirate.x = isl.x + 150; pirate.y = isl.y;
  w.ships = [pirate];
  for (let i = 0; i < 400; i++) { shoreBatteries(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
  assert.ok(!pirate._sunk && weaponsAboard(pirate) === 20, 'an unarmed port never fired a shot');
});

test('a well-found port SINKS a raider that lingers, and claims its bounty', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PORT_CANNON_SINK: 5 }; // guaranteed hit at a full garrison
  const isl = w.islands[0]; isl.haven = false;
  isl.stock = { ...(isl.stock || {}), Weapons: 50 };
  const pirate = w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 };
  pirate.x = isl.x + 200; pirate.y = isl.y;
  w.ships = [pirate];
  shoreBatteries(w, w.rules.SIM_STEP);
  assert.ok(pirate._sunk, 'the shore battery sank the pirate standing off the port');
});

test('a pirate HAVEN turns its guns on a besieging privateer — but never on its own raiders', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PORT_CANNON_SINK: 5 };
  const den = w.islands[0]; den.haven = true; den.havenStrength = 0.85; // a strong den → strong guns
  const priv = w.ships[0], rogue = w.ships[1];
  priv.pirate = false; priv.privateer = true;
  priv.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 6 };
  priv.x = den.x + 200; priv.y = den.y;                       // a besieger, in range
  turnPirate(w, rogue);                                       // one of the den's own — a friend
  rogue.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 6 };
  rogue.x = den.x + 150; rogue.y = den.y;                     // also in range, but must be spared
  w.ships = [priv, rogue];
  shoreBatteries(w, w.rules.SIM_STEP);
  assert.ok(priv._sunk, 'the haven’s batteries sank the besieging privateer');
  assert.ok(!rogue._sunk, 'the haven did not fire on its own pirates');
});
