import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, capOfRes } from './helpers/simWorld.js';
import { produceBase, produceGoods } from '/game/sim/production.js';
import { stepWorld } from '/game/sim/world.js';
import { effectiveRate } from '/game/sim/island.js';

test('secondary base resource produces at 1/4 the primary rate', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.stock[isl.primary] = 0;
  isl.stock[isl.secondary] = 0;
  produceBase(w, 0.05);
  const ratio = isl.stock[isl.secondary] / isl.stock[isl.primary];
  assert.ok(Math.abs(ratio - w.rules.SECONDARY_FRACTION) < 1e-9, `ratio ${ratio}`);
});

test('base production respects the Euler stability bound R*h/Cap <= 1', () => {
  const w = makeWorld();
  const bound = (w.rules.BASE_PRODUCTION_RATE * w.rules.SIM_STEP) / w.rules.STOCKPILE_CAP;
  assert.ok(bound <= 1, `bound ${bound}`);
});

test('no stockpile ever exceeds its cap over a long run', () => {
  const w = makeWorld();
  for (let i = 0; i < 3000; i++) stepWorld(w, 1.0);
  for (const isl of w.islands) {
    for (const r in isl.stock) {
      assert.ok(isl.stock[r] <= capOfRes(w, r) * (1 + 1e-6), `${isl.name}/${r}=${isl.stock[r]}`);
    }
  }
});

test('goods production keeps >=25% of a locally produced raw as surplus', () => {
  const w = makeWorld();
  // A ranch: Meat(primary) -> Food, so the Meat input rate is capped at 75% of production.
  const isl = w.islands.find((i) => i.primary === 'Meat' && i.produces.includes('Food'));
  const meatRate = effectiveRate(isl, 'Meat', w.rules);
  // Give it plenty of meat, then run one goods step and check consumption <= 75% of rate.
  isl.stock.Meat = 500;
  const before = isl.stock.Meat;
  produceGoods(w, 1.0);
  const consumed = before - isl.stock.Meat;
  assert.ok(consumed <= w.rules.GOODS_MAX_INPUT_FRACTION * meatRate + 1e-6,
    `consumed ${consumed} > 75% of ${meatRate}`);
});
