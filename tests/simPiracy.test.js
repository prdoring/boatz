// Piracy — the black-flag antagonist. Combat is decided by captain skill, crew morale, and
// WEAPONS aboard (the offense/defense equation); pirates spawn only by CONVERSION of an existing
// crew (nothing appears for free), are capped as a fraction of the fleet (self-limiting), and can
// be sunk when they pick the wrong fight. These tests lock those invariants in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import {
  combatStrength, weaponsAboard, pirateCount, canTurnPirate, turnPirate, piracy,
} from '/game/sim/piracy.js';
import { GOLD } from '/game/sim/resources.js';

test('combat strength rises with guns, skill, morale — and a pirate fights harder', () => {
  const w = makeWorld();
  const a = w.ships[0], b = w.ships[1];
  a.cargo = { Gold: 0, People: 0, Weapons: 0 }; a.morale = 0.5;
  b.cargo = { Gold: 0, People: 0, Weapons: 10 }; b.morale = 0.5; b.captain = a.captain;
  assert.ok(combatStrength(w, b) > combatStrength(w, a), 'more guns → more strength');
  assert.equal(weaponsAboard(b), 10);

  const plain = { ...b, pirate: false }, rogue = { ...b, pirate: true };
  assert.ok(combatStrength(w, rogue) > combatStrength(w, plain), 'a pirate gets the ferocity bonus');
});

test('weapons contribution is capped by the hull class (a ship cannot stack infinite guns)', () => {
  const w = makeWorld();
  const s = w.ships[0];
  const cap = w.rules.SHIP_TYPES[s.type].weaponCap; // per-hull gun capacity
  s.cargo = { Gold: 0, People: 0, Weapons: cap }; s.morale = 0.5;
  const atCap = combatStrength(w, s);
  s.cargo.Weapons = cap * 4;
  assert.ok(Math.abs(combatStrength(w, s) - atCap) < 1e-9, 'guns past the hull cap add nothing');
});

test('turning pirate is a CONVERSION — no ship is created, the hull is reused under a new flag', () => {
  const w = makeWorld();
  const before = w.ships.length;
  const ship = w.ships[0];
  const id = ship.id, hull = ship.capacity, home = ship.homeId;
  ship.voyage = { reason: 'trade', stops: [], index: 0 };
  turnPirate(w, ship);
  assert.equal(w.ships.length, before, 'no new ship spawned — piracy adds nothing free to the fleet');
  assert.equal(ship.id, id, 'same hull');
  assert.equal(ship.capacity, hull, 'same capacity');
  assert.equal(ship.homeId, home, 'still remembers its home port');
  assert.equal(ship.pirate, true, 'flying the black flag');
  assert.equal(ship.voyage, null, 'abandoned its merchant voyage');
  assert.ok(ship.captain && ship.captain.name, 'sails under a fresh captain');
  assert.ok(pirateCount(w) >= 1);
});

test('piracy is self-limiting — the fleet-fraction cap blocks the next conversion', () => {
  const w = makeWorld();
  const cap = Math.max(1, w.ships.length * w.rules.PIRATE_MAX_FRAC);
  let guard = 0;
  while (canTurnPirate(w) && guard++ < 1000) {
    const victim = w.ships.find((s) => !s.pirate);
    if (!victim) break;
    turnPirate(w, victim);
  }
  assert.ok(!canTurnPirate(w), 'the seas refuse another pirate once the cap is reached');
  assert.ok(pirateCount(w) <= Math.ceil(cap), `pirates (${pirateCount(w)}) stay within the cap (${cap})`);
});

test('the world is seeded with a few rogues already at large (the early seas are not empty)', () => {
  const w = makeWorld();
  const pirates = w.ships.filter((s) => s.pirate);
  assert.equal(pirates.length, w.rules.START_PIRATES, 'START_PIRATES raiders sail from day one');
  for (const p of pirates) {
    assert.ok((p.cargo.Weapons || 0) > 0, 'a seeded rogue is armed for the fight');
    assert.ok((p.cargo.Food || 0) > 0, 'and victualled to hunt before it must raid');
  }
});

test('a fed pirate with no prey does NOT camp an island wharf — it stands off in the approaches', () => {
  const w = makeWorld();
  const isle = w.islands[0];
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed (won't raid) and not laden (won't fence)
  pirate._huntCd = 0; pirate._prey = null;
  pirate.x = isle.x; pirate.y = isle.y;               // sitting right on the wharf
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no merchant is under way → no prey at sea
  for (let i = 0; i < 60; i++) piracy(w, w.rules.SIM_STEP);
  const d = Math.hypot(pirate.x - isle.x, pirate.y - isle.y);
  assert.ok(d > w.rules.PIRATE_RAID_RANGE, `the pirate stood off the wharf (dist ${Math.round(d)}u) instead of camping it`);
});

test('a blockading pirate circles a port (never camps it) and stokes the fear of its waters', () => {
  const w = makeWorld();
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed (won't raid) + not laden (won't fence)
  pirate._huntCd = 0; pirate._prey = null;
  const isle = w.islands[0];
  pirate.x = isle.x + 120; pirate.y = isle.y;           // right off the wharf
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no prey at sea → it blockades
  for (const i of w.islands) i.danger = 0;
  const track = [];
  for (let i = 0; i < 80; i++) { piracy(w, w.rules.SIM_STEP); track.push({ x: pirate.x, y: pirate.y }); }
  // It KEEPS MOVING (circling), not sitting dead on a fixed mark.
  const moved = track.some((p) => Math.hypot(p.x - track[0].x, p.y - track[0].y) > 30);
  assert.ok(moved, 'the blockader circles rather than parking on one spot');
  // It stays out in the approaches, off the wharf (not camping the port).
  assert.ok(Math.hypot(pirate.x - isle.x, pirate.y - isle.y) > w.rules.PIRATE_RAID_RANGE, 'held off the wharf');
  // And a blockade makes these waters feared (which is what draws the privateers).
  assert.ok(w.islands.some((i) => (i.danger || 0) > 0), 'the blockade stoked danger, summoning the law');
});

test('a pirate that catches a merchant plunders its coin and cargo (weapons burn as a sink)', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  // Put the victim right on top of the pirate, inside combat range, so piracy() resolves a fight.
  turnPirate(w, pirate);
  pirate.x = 1000; pirate.y = 1000; pirate.morale = 1; pirate._huntCd = 0;
  pirate.cargo = { Gold: 0, People: 0, Weapons: 40 }; // heavily armed → very likely to win
  pirate.captain.xp = 5000; // a fearsome, skilled captain
  victim.x = 1000; victim.y = 1000; victim.state = 'outbound'; victim.pirate = false;
  victim.morale = 0.1; victim.cargo = { Gold: 500, People: 0, Food: 30, Weapons: 2 };
  victim.captain.xp = 0;
  const pirateWeaponsBefore = weaponsAboard(pirate);

  piracy(w, w.rules.SIM_STEP);

  const tookLoot = (pirate.cargo[GOLD] || 0) > 0 || (pirate.cargo.Food || 0) > 0;
  const victimStripped = (victim.cargo[GOLD] || 0) < 500 || !!victim._sunk;
  assert.ok(tookLoot, 'the pirate carried off coin and/or cargo');
  assert.ok(victimStripped, 'the merchant lost its coin (or went under)');
  assert.ok(weaponsAboard(pirate) < pirateWeaponsBefore, 'guns were spent in the fight (a weapons sink)');
});
