// Production systems: base resources (primary + secondary, logistic taper) and
// goods (population-scaled, capped at 75% of a locally-produced input's rate so
// >=25% of every local raw survives as exportable surplus — which forces trade).
// PURE. Reads tuning from world.rules; no engine/config import.

import { clamp } from './resources.js';
import { effectiveRate, producesRaw } from './island.js';

/** Base-resource production. dS = rate * (1 - S/Cap) * h ; secondary rate = 1/4 primary. */
export function produceBase(world, h) {
  const t = world.rules;
  const cap = t.STOCKPILE_CAP;
  for (const island of world.islands) {
    for (const res of [island.primary, island.secondary]) {
      const rate = effectiveRate(island, res, t);
      if (rate <= 0) continue;
      const taper = clamp(1 - island.stock[res] / cap, 0, 1);
      island.stock[res] = clamp(island.stock[res] + rate * taper * h, 0, cap);
    }
  }
}

/** Resolve a recipe input to a concrete resource: for anyOf, prefer a locally
 *  produced raw, else the one the island has most of. */
function resolveInput(island, input) {
  if (input.all) return input.all;
  const opts = input.anyOf;
  let best = opts[0], bestStock = -1, localPick = null;
  for (const res of opts) {
    if (producesRaw(island, res)) { localPick = localPick || res; }
    const s = island.stock[res] || 0;
    if (s > bestStock) { bestStock = s; best = res; }
  }
  return localPick || best;
}

/** Goods production for one island's recipes. */
export function produceGoods(world, h) {
  const t = world.rules;
  for (const island of world.islands) {
    for (const out of island.produces) {
      const recipe = world.economy._recipeByOut[out];
      if (!recipe) continue;

      // Desired output rate scales with population (more artisans).
      let rate = t.POP_GOODS_COEFF * island.population;

      // Cap by every input. Locally-produced inputs cap at 75% of their production
      // rate (guarantees raw surplus); imported inputs cap at a throughput of their
      // on-hand stock (so more output demands more imports). Also never exceed what
      // is on hand this step.
      const resolved = [];
      for (const input of recipe.inputs) {
        const res = resolveInput(island, input);
        resolved.push([res, input.qty]);
        const localRate = effectiveRate(island, res, t);
        const capByInput = localRate > 0
          ? (t.GOODS_MAX_INPUT_FRACTION * localRate) / input.qty
          : (t.INPUT_THROUGHPUT_RATE * (island.stock[res] || 0)) / input.qty;
        const capByStock = (island.stock[res] || 0) / input.qty / h;
        rate = Math.min(rate, capByInput, capByStock);
      }

      // Don't overfill a full warehouse. Ships (a SPECIAL good) stockpile only a few
      // hulls — a shipyard builds to a small buffer and refills as they're bought,
      // instead of piling thousands of unsold ships up to the goods cap.
      const outCap = t.SPECIAL_GOODS.includes(out) ? t.SHIP_STOCK_CAP : t.GOODS_CAP;
      const outTaper = clamp(1 - island.stock[out] / outCap, 0, 1);
      rate = Math.max(0, rate) * outTaper;
      if (rate <= 0) continue;

      const made = rate * h;
      for (const [res, qty] of resolved) {
        island.stock[res] = Math.max(0, island.stock[res] - made * qty);
      }
      island.stock[out] = clamp(island.stock[out] + made, 0, outCap);
    }
  }
}
