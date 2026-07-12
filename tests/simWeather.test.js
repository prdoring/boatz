// World dynamics — seasons (production swing + prevailing trade winds), and named storms that
// wander the map and sink ships caught inside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { weather, stormOver, prevailingWind, initWeather } from '/game/sim/weather.js';

function runDays(w, days) {
  const steps = Math.round(days * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { weather(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}

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
