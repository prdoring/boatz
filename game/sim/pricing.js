// Per-island, per-commodity pricing. Only `mid` is stored (bid/ask derived).
// midTarget is monotonically decreasing in stock and clamped; the EMA toward it
// is rate-limited and provably non-overshooting for any step h. PURE.

import { clamp, safeDiv, tradeables, basePrice } from './resources.js';

/** Derive the bid (island buys) / ask (island sells) around a mid, spread apart. */
export function bidAsk(mid, spread) {
  return { bid: mid * (1 - spread / 2), ask: mid * (1 + spread / 2) };
}

/** Target mid for a stock level: base * (target/stock)^elasticity, clamped. */
export function midTarget(stock, target, base, t) {
  const ratio = safeDiv(stock, Math.max(target, 1), 0);
  const mult = clamp(Math.pow(1 / Math.max(ratio, 1e-6), t.ELASTICITY), t.PRICE_MIN_MULT, t.PRICE_MAX_MULT);
  return clamp(base * mult, base * t.PRICE_MIN_MULT, base * t.PRICE_MAX_MULT);
}

export function pricing(world, h) {
  const t = world.rules;
  for (const island of world.islands) {
    for (const res of tradeables(world.economy)) {
      const tgt = midTarget(island.stock[res], island.targets[res], basePrice(t, res), t);
      const p = island.price[res];
      const maxStep = t.PRICE_SMOOTH_RATE * p.mid * h; // rate-limited => contractive, no overshoot
      p.mid += clamp(tgt - p.mid, -maxStep, maxStep);
    }
  }
}
