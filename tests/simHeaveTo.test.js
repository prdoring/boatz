// Heave-to repair + timber predator — a crippled pirate/privateer with repair timber lies-to and
// jury-rigs (committed, catchable); a material-poor one hunts FOR the timber. Merchants don't heave-to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { maybeHeaveToRepair } from '/game/sim/repair.js';
import { turnPirate, piracy } from '/game/sim/piracy.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.3, greed: 0.3 }, ...over });
const boat = (over = {}) => ({ id: 's1', type: 'brig', hull: 1, rig: 1, hullSound: 1, rigSound: 1, morale: 0.6, capacity: 100, cargo: { Gold: 0, People: 0, Wood: 0, Fiber: 0 }, captain: cap(), ...over });

test('maybeHeaveToRepair: a crippled hull WITH timber heaves-to (committed), jury-rigs, and burns stores', () => {
  const w = makeWorld();
  const s = boat({ hull: 0.2, rig: 0.2, cargo: { Gold: 0, People: 0, Wood: 50, Fiber: 50 } });
  const hull0 = s.hull, wood0 = s.cargo.Wood;
  assert.equal(maybeHeaveToRepair(w, s, w.rules.SIM_DAY_SECONDS), true, 'it hove to');
  assert.equal(s._act.k, 'careen', 'tagged as careening');
  assert.ok(s._heaveUntil > w.simTime, 'and committed to it (latched)');
  assert.ok(s.hull > hull0, 'jury-rigged the hull up');
  assert.ok(s.cargo.Wood < wood0, 'consuming repair timber');
});

test('maybeHeaveToRepair: NO timber aboard → does not heave-to', () => {
  const w = makeWorld();
  const s = boat({ hull: 0.2, rig: 0.2, cargo: { Gold: 0, People: 0, Wood: 0, Fiber: 0 } });
  assert.equal(maybeHeaveToRepair(w, s, w.rules.SIM_DAY_SECONDS), false);
});

test('maybeHeaveToRepair: already at the jury-rig ceiling (nothing to gain) → does not heave-to', () => {
  const w = makeWorld();
  const s = boat({ hull: 0.95, rig: 0.95, cargo: { Gold: 0, People: 0, Wood: 50, Fiber: 50 } });
  assert.equal(maybeHeaveToRepair(w, s, w.rules.SIM_DAY_SECONDS), false, 'hull/rig already above REACH — no point lying-to');
});

test('a crippled, fed pirate with timber and no reachable dry-dock HEAVES TO instead of pressing on', () => {
  const w = makeWorld();
  const den = w.islands[0]; den.haven = true; den.havenStrength = 0.8;
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.hull = 0.25; pirate.rig = 0.5; pirate.hullSound = 0.55; pirate.rigSound = 0.75;
  pirate.captain.traits = { boldness: 0.5, wanderlust: 0.3, greed: 0.3 };
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Wood: 50, Fiber: 50 }; // fed (won't hunt for food) + timber aboard
  pirate._huntCd = 0; pirate._prey = null; pirate._heaveUntil = 0;
  pirate.x = den.x + 1600; pirate.y = den.y;  // beyond HAVEN_DEFEND_RANGE → not "near its den"
  w.ships = w.ships.filter((s) => s === pirate); // no prey, no hunters at sea
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  const hull0 = pirate.hull;
  piracy(w, w.rules.SIM_STEP);
  assert.equal(pirate._act && pirate._act.k, 'careen', 'it hove to and is making repairs');
  assert.ok(pirate.hull > hull0, 'and jury-rigged the hull up');
});

test('a STARVING crippled pirate does NOT careen — hunger comes first (it makes for food)', () => {
  const w = makeWorld();
  const den = w.islands[0]; den.haven = true; den.havenStrength = 0.8;
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.hull = 0.25; pirate.rig = 0.5;
  pirate.cargo = { Gold: 0, People: 0, Food: 0, Wood: 50, Fiber: 50 }; // STARVING, though it has timber
  pirate._huntCd = 0; pirate._prey = null; pirate._heaveUntil = 0;
  pirate.x = den.x + 1600; pirate.y = den.y;
  w.ships = w.ships.filter((s) => s === pirate);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  piracy(w, w.rules.SIM_STEP);
  assert.notEqual(pirate._act && pirate._act.k, 'careen', 'a starving crew does not lie-to repairing — it seeks food');
});

test('TIMBER PREDATOR: a crippled, timber-poor raider with no den prefers a Wood/Fiber prize', () => {
  const w = makeWorld();
  for (const i of w.islands) i.haven = false;                 // no den to run to → it must hunt for timber
  const pirate = w.ships[0], rich = w.ships[1], timber = w.ships[2];
  turnPirate(w, pirate);
  pirate.hull = 0.25; pirate.rig = 0.6;                        // crippled
  pirate.captain.traits = { boldness: 0.5, wanderlust: 0.1, greed: 0.3 };
  pirate.captain.xp = 5000;
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Wood: 0, Fiber: 0 }; // fed + NO repair timber → needsTimber
  pirate._huntCd = 0; pirate._prey = null; pirate._heaveUntil = 0;
  pirate.x = 5000; pirate.y = 5000;
  const place = (m, over) => Object.assign(m, { pirate: false, privateer: false, state: 'outbound', _sheltered: false }, over);
  place(rich, { x: 5300, y: 5000, cargo: { Gold: 800, People: 0, Wood: 0, Fiber: 0 } });     // fat but DRY
  place(timber, { x: 5320, y: 5000, cargo: { Gold: 50, People: 0, Wood: 60, Fiber: 60 } });  // lean but TIMBER
  w.ships = w.ships.filter((s) => s === pirate || s === rich || s === timber);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  piracy(w, w.rules.SIM_STEP);
  assert.equal(pirate._act && pirate._act.k, 'hunt', 'it hunts');
  assert.equal(pirate._act.id, timber.id, 'and chose the timber-laden hull over the fatter, drier prize');
});
