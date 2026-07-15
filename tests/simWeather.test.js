// World dynamics — seasons (production swing + prevailing trade winds), and named storms that
// wander the map and sink ships caught inside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { weather, stormOver, prevailingWind, initWeather } from '/game/sim/weather.js';
import { ship } from '/game/sim/ship.js';

function runDays(w, days) {
  const steps = Math.round(days * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { weather(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}
const merchant = (w) => w.ships.find((s) => !s.pirate && !s.privateer);

test('the season turns after SEASON_DAYS and sets the prevailing wind', () => {
  const w = makeWorld();
  assert.equal(w.season.name, 'Spring', 'opens in Spring');
  const pv0 = prevailingWind(w);
  assert.ok(pv0 && typeof pv0.dir === 'number', 'Spring has a prevailing wind');
  runDays(w, w.rules.SEASON_DAYS + 1);
  assert.equal(w.season.name, 'Summer', 'advances to Summer after one season');
  assert.notEqual(prevailingWind(w).dir, pv0.dir, 'the trade winds shift with the season');
});

test('food staples swing hardest with the season (production multiplier)', () => {
  const w = makeWorld();
  const foodRaw = w.rules.FOOD_RAWS[0];
  const grainIsle = w.islands.find((i) => i.primary === foodRaw);
  assert.ok(grainIsle, 'there is a food-staple producer');
  // Spring boosts food staples above 1.
  assert.ok(grainIsle._prodMult > 1, `Spring lifts ${foodRaw} output (${grainIsle._prodMult})`);
  // Advance to Winter (idx 3) and check it dips below 1.
  runDays(w, w.rules.SEASON_DAYS * 3 + 1);
  assert.equal(w.season.name, 'Winter');
  assert.ok(grainIsle._prodMult < 1, 'a lean winter cuts staple output');
});

test('a ship caught in a storm can be lost with all hands', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  ship.x = 2000; ship.y = 2000; ship._sunk = false;
  // Drop a fierce, stationary storm right on top of it.
  w.storms = [{ id: 'st1', name: 'Testtempest', x: 2000, y: 2000, r: 500, life: 10, vx: 0, vy: 0 }];
  const over = stormOver(w, ship.x, ship.y);
  assert.ok(over && over.intensity > 0, 'the ship is inside the storm');
  assert.ok(over.name === 'Testtempest');
  // With a high per-day sink chance, a day of exposure should claim it.
  w.rules = { ...w.rules, STORM_SINK_PER_DAY: 50 };
  const n0 = w.ships.length;
  runDays(w, 1);
  assert.ok(w.ships.length < n0 && !w.ships.includes(ship), 'the ship foundered in the storm');
});

test('stormOver reports no storm on open water', () => {
  const w = makeWorld();
  w.storms = [{ id: 'st1', name: 'Faraway', x: 100, y: 100, r: 200, life: 5, vx: 0, vy: 0 }];
  assert.equal(stormOver(w, 3000, 3000), null, 'clear skies far from the storm');
});

// ─── Phase 4: storms BATTER condition, blow ships off course, and a captain jury-rigs his way home ───

test('a storm BATTERS a ship’s hull and rig — she usually limps out crippled, not simply vanishes', () => {
  const w = makeWorld();
  const s = merchant(w);
  s.x = 2000; s.y = 2000; s.hull = 1; s.rig = 1; s._sunk = false;
  s.captain.xp = { sea: 0, gun: 0, cmd: 0 }; // a green navigator takes the full battering
  w.storms = [{ id: 's', name: 'Batterer', x: 2000, y: 2000, r: 500, life: 30, vx: 0, vy: 0 }];
  w.rules = { ...w.rules, STORM_SINK_PER_DAY: 0, STORM_LOST_CHANCE: 0 }; // isolate the condition damage
  runDays(w, 0.5);
  assert.ok(w.ships.includes(s) && !s._sunk, 'she rode it out');
  assert.ok(s.hull < 1, 'but her hull was battered');
  assert.ok(s.rig < 1, 'and her rigging shredded');
});

test('SEAMANSHIP shelters a ship from a storm — a master mariner loses far less than a green hand', () => {
  const w = makeWorld();
  const crews = w.ships.filter((s) => !s.pirate && !s.privateer);
  const green = crews[0], master = crews[1];
  for (const s of [green, master]) { s.x = 2000; s.y = 2000; s.hull = 1; s.rig = 1; s._sunk = false; }
  green.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  master.captain.xp = { sea: 100000, gun: 0, cmd: 0 };
  w.storms = [{ id: 's', name: 'Howler', x: 2000, y: 2000, r: 700, life: 30, vx: 0, vy: 0 }];
  w.rules = { ...w.rules, STORM_SINK_PER_DAY: 0, STORM_LOST_CHANCE: 0 };
  runDays(w, 0.4);
  assert.ok(green.hull < master.hull, 'the green hand’s hull suffered more');
  assert.ok(green.rig < master.rig, 'and his rigging too');
});

test('a poor navigator is BLOWN OFF COURSE by a fierce storm (set adrift)', () => {
  const w = makeWorld();
  const s = merchant(w);
  s.x = 2000; s.y = 2000; s.hull = 1; s.rig = 1; s._sunk = false; s.adrift = null;
  s.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  w.storms = [{ id: 's', name: 'Wrecker', x: 2000, y: 2000, r: 600, life: 30, vx: 0, vy: 0 }];
  w.rules = { ...w.rules, STORM_SINK_PER_DAY: 0, STORM_LOST_CHANCE: 40 }; // a savage, disorienting blow
  runDays(w, 0.3);
  assert.ok(s.adrift && !s._sunk, 'she lost her bearings and is adrift');
});

test('an adrift ship regains her bearings on a good roll and resumes her voyage', () => {
  const w = makeWorld();
  w.simTime = 5 * w.rules.SIM_DAY_SECONDS; // a day boundary well past 0 so the daily fix-roll fires
  const s = merchant(w);
  const home = w.islandsById.get(s.homeId);
  const dest = w.islands.find((i) => i.id !== home.id && !i.haven);
  s.x = (home.x + dest.x) / 2; s.y = (home.y + dest.y) / 2;
  s.state = 'outbound'; s._sunk = false;
  s.voyage = { reason: 'trade', stops: [{ islandId: dest.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  s.adrift = { since: w.simTime };
  s.captain.xp = { sea: 50000, gun: 0, cmd: 0 };
  w.rules = { ...w.rules, LOST_RECOVER_BASE: 1, SINK_PER_1000: 0 }; // a certain fix; no incidental foundering
  ship(w, w.rules.SIM_STEP);
  assert.equal(s.adrift, null, 'she found her bearings');
  assert.ok(s.state === 'outbound' || s.state === 'inbound', 'and resumed a course');
});

test('an adrift, seamanlike captain JURY-RIGS from Wood/Fiber carried aboard (nurses the cripple home)', () => {
  const w = makeWorld();
  w.simTime = 3 * w.rules.SIM_DAY_SECONDS;
  const s = merchant(w);
  s.hull = 0.5; s.rig = 0.5; s._sunk = false;
  s.cargo = { Gold: 0, People: 0, Wood: 50, Fiber: 50 };
  s.captain.xp = { sea: 50000, gun: 0, cmd: 0 };
  s.state = 'outbound';
  s.voyage = { reason: 'trade', stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  s.adrift = { since: w.simTime };
  // Never recovers this step (stays adrift and keeps jury-rigging); no incidental foundering.
  w.rules = { ...w.rules, LOST_RECOVER_BASE: -10, SINK_PER_1000: 0, JURYRIG_PER_DAY: 5 };
  const hull0 = s.hull, rig0 = s.rig, wood0 = s.cargo.Wood;
  for (let i = 0; i < 60; i++) { ship(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
  assert.ok(s.adrift, 'still adrift (no fix rolled)');
  assert.ok(s.hull > hull0 && s.rig > rig0, 'she patched her hull and rig at sea');
  assert.ok(s.cargo.Wood < wood0, 'consuming carried timber');
});
