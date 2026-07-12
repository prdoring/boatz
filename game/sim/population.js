// Population + civilization system: food consumption, spoilage, rate-bounded
// starvation (floored), food-security-gated logistic growth, and the civ score.
// PURE. Reads world.rules; no engine/config import.

import { clamp, safeDiv } from './resources.js';
import { foodDays } from './island.js';

function reserveScore(stock, perCapTarget, pop) {
  return clamp(safeDiv(stock, Math.max(pop, 1) * perCapTarget), 0, 1);
}

/** Civilization score in [0,1]: saturating gold + per-capita luxury/ale/food reserves,
 *  dragged down by lawlessness (a crime-ridden port is a less civilised place to live). */
export function computeCiv(island, t) {
  const w = t.CIV_WEIGHTS;
  const goldScore = safeDiv(island.gold, island.gold + t.CIV_GOLD_K);
  const lux = reserveScore(island.stock.LuxuryGoods, t.LUX_PER_CAPITA, island.population);
  const ale = reserveScore(island.stock.Ale, t.ALE_PER_CAPITA, island.population);
  const foodTargetPerCap = t.FOOD_PER_CAPITA * t.SIM_DAY_SECONDS * t.FOOD_SECURITY_DAYS;
  const food = reserveScore(island.stock.Food, foodTargetPerCap, island.population);
  const base = w.GOLD * goldScore + w.LUX * lux + w.ALE * ale + w.FOOD * food;
  return clamp(base * (1 - (t.LAWLESS_CIV_DRAG || 0) * (island.lawlessness || 0)), 0, 1);
}

export function population(world, h) {
  const t = world.rules;
  for (const island of world.islands) {
    const need = island.population * t.FOOD_PER_CAPITA * h;
    const eaten = Math.min(need, island.stock.Food);
    island.stock.Food -= eaten;
    // Slow spoilage stops food being hoarded to infinity.
    island.stock.Food = Math.max(0, island.stock.Food - t.FOOD_SPOILAGE * island.stock.Food * h);

    // Comfort goods (ale/clothing/weapons/luxury) are consumed by the population
    // if on hand — a per-good demand sink (rates tuned to each good's supply) that
    // bounds stock and gives every island a reason to keep importing, so gold
    // circulates and single-good exporters can stay solvent.
    for (const good in t.COMFORT_CONSUMPTION) {
      const need = island.population * t.COMFORT_CONSUMPTION[good] * h;
      island.stock[good] = Math.max(0, island.stock[good] - Math.min(need, island.stock[good]));
    }

    const deficit = need - eaten;
    if (deficit > 1e-12) {
      // Rate-bounded starvation, floored — an island can always recover once fed.
      const frac = need > 0 ? deficit / need : 0;
      const deaths = t.STARVE_RATE * frac * island.population * h;
      island.population = Math.max(t.POP_FLOOR, island.population - deaths);
    } else {
      // Food-security-gated logistic growth: population approaches K from below and
      // stops before it can outrun food (the key anti-death-spiral mechanism). A lawless
      // port grows slower — people don't flock to (and drift away from) a den of crime.
      const secure = clamp((foodDays(island, t) - t.FOOD_SECURITY_DAYS) / t.FOOD_SECURITY_DAYS, 0, 1);
      const order = 1 - (t.LAWLESS_GROWTH_DRAG || 0) * (island.lawlessness || 0);
      const K = island.k;
      island.population += t.POP_GROWTH_RATE * island.population * (1 - island.population / K) * secure * Math.max(0, order) * h;
      if (island.population > K) island.population = K;
    }
    island.civ = computeCiv(island, t);
  }
}
