// Wind — a drifting global vector that speeds ships with it and slows them against it, with
// a captain-skill discount on the headwind (tacking know-how).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { windMult, upwindness, wind as windSystem } from '/game/sim/wind.js';
import { stepWorld } from '/game/sim/world.js';

test('buildWorld seeds a wind vector', () => {
  const w = makeWorld();
  assert.ok(w.wind && typeof w.wind.dir === 'number' && typeof w.wind.str === 'number');
  assert.ok(w.wind.str > 0 && w.wind.str <= 1);
});

test('windMult: tailwind speeds up, headwind slows, floored so it never stalls', () => {
  const w = makeWorld();
  w.wind = { dir: 0, str: 1, tDir: 0, tStr: 1, nextShift: 1e12 };
  const tail = windMult(w, 0, 0);        // heading with the wind
  const head = windMult(w, Math.PI, 0);  // heading into the wind
  const cross = windMult(w, Math.PI / 2, 0);
  assert.ok(tail > 1, 'tailwind faster than base');
  assert.ok(head < 1, 'headwind slower than base');
  assert.ok(tail > cross && cross > head, 'monotonic across the wind angle');
  assert.ok(head >= w.rules.WIND_MULT_MIN - 1e-9, 'never below the floor');
});

test('a skilled captain sheds much of the headwind penalty (and never loses on it)', () => {
  const w = makeWorld();
  w.wind = { dir: 0, str: 1, tDir: 0, tStr: 1, nextShift: 1e12 };
  const novice = windMult(w, Math.PI, 0);
  const veteran = windMult(w, Math.PI, 0.9);
  assert.ok(veteran > novice, 'skill softens the headwind');
});

test('upwindness is +1 dead upwind and −1 dead downwind (scaled by strength)', () => {
  const w = makeWorld();
  w.wind = { dir: 0, str: 1, tDir: 0, tStr: 1, nextShift: 1e12 };
  assert.ok(Math.abs(upwindness(w, Math.PI) - 1) < 1e-9, 'sailing into the wind → +1');
  assert.ok(Math.abs(upwindness(w, 0) + 1) < 1e-9, 'sailing with the wind → −1');
});

test('the wind stays bounded and drifts as the sim runs', () => {
  const w = makeWorld();
  let min = 9, max = 0, moved = false;
  const d0 = w.wind.dir;
  for (let i = 0; i < 4000; i++) {
    windSystem(w, 0.05);
    w.simTime += 0.05;
    min = Math.min(min, w.wind.str); max = Math.max(max, w.wind.str);
    if (Math.abs(w.wind.dir - d0) > 0.05) moved = true;
  }
  assert.ok(min >= 0 && max <= 1.0001, `strength bounded, got [${min},${max}]`);
  assert.ok(moved, 'direction actually drifts over time');
});

test('wind evolution is deterministic for a given seed', () => {
  const a = makeWorld(), b = makeWorld();
  for (let i = 0; i < 500; i++) { stepWorld(a, 0.5); stepWorld(b, 0.5); }
  assert.ok(Math.abs(a.wind.dir - b.wind.dir) < 1e-9, 'same seed → same wind direction');
  assert.ok(Math.abs(a.wind.str - b.wind.str) < 1e-9, 'same seed → same wind strength');
});
