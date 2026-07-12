import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { midTarget, bidAsk, pricing } from '/game/sim/pricing.js';

test('midTarget is non-increasing in stock and clamped', () => {
  const w = makeWorld();
  const t = w.rules;
  const base = 10, target = 250;
  let prev = Infinity;
  for (let stock = 0; stock <= 3000; stock += 100) {
    const m = midTarget(stock, target, base, t);
    assert.ok(m <= prev + 1e-9, `not monotone at ${stock}`);
    assert.ok(m >= base * t.PRICE_MIN_MULT - 1e-9 && m <= base * t.PRICE_MAX_MULT + 1e-9, `unclamped ${m}`);
    prev = m;
  }
});

test('bid is always below ask', () => {
  const { bid, ask } = bidAsk(10, 0.1);
  assert.ok(bid < ask);
});

test('EMA price move per step never overshoots the rate limit', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  // Force a large gap between mid and target, then step pricing once.
  const res = isl.primary;
  const before = isl.price[res].mid;
  isl.stock[res] = 0; // scarce => target mid jumps up
  pricing(w, t.SIM_STEP);
  const move = Math.abs(isl.price[res].mid - before);
  assert.ok(move <= t.PRICE_SMOOTH_RATE * before * t.SIM_STEP + 1e-9, `move ${move}`);
});
