import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { population, computeCiv } from '/game/sim/population.js';

test('food is consumed at population * FOOD_PER_CAPITA per second', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.population = 100;
  isl.stock.Food = 1000;
  const before = isl.stock.Food;
  population(w, 1.0);
  const eaten = before - isl.stock.Food;
  // consumption + a little spoilage; consumption alone is pop*rate.
  assert.ok(eaten >= 100 * w.rules.FOOD_PER_CAPITA - 1e-9);
});

test('with no food, population declines but never below POP_FLOOR', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.population = 50;
  isl.stock.Food = 0;
  for (let i = 0; i < 5000; i++) population(w, 1.0);
  assert.ok(isl.population >= w.rules.POP_FLOOR - 1e-9);
  assert.ok(isl.population < 50, 'should have starved down');
});

test('with ample food, population grows toward K without overshoot', () => {
  const w = makeWorld();
  const isl = w.islands.find((i) => i.produces.includes('Food') && i.k > 120); // a roomy food producer
  isl.population = 50;
  for (let i = 0; i < 20000; i++) { isl.stock.Food = 5000; population(w, 1.0); }
  assert.ok(isl.population > 100, `only reached ${isl.population}`);
  assert.ok(isl.population <= isl.k + 1e-6, `overshot K: ${isl.population}`);
});

test('civ is in [0,1] and gold contribution saturates', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.population = 100;
  isl.gold = 1000;
  const c1 = computeCiv(isl, w.rules);
  isl.gold = 1_000_000;
  const c2 = computeCiv(isl, w.rules);
  assert.ok(c1 >= 0 && c1 <= 1 && c2 >= 0 && c2 <= 1);
  assert.ok(c2 > c1, 'more gold => higher civ');
  // Saturation: 1000x the gold must not 1000x the civ.
  assert.ok(c2 < c1 * 3, 'gold civ should saturate');
});
