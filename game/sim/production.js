// Production systems: base resources (primary + secondary, logistic taper) and
// goods (population-scaled, capped at 75% of a locally-produced input's rate so
// >=25% of every local raw survives as exportable surplus — which forces trade).
// PURE. Reads tuning from world.rules; no engine/config import.

import { clamp } from './resources.js';
import { effectiveRate, producesRaw, workshopStaffing } from './island.js';

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

/** Resolve a recipe input to a concrete resource: for anyOf, prefer a locally produced raw; else the
 *  highest-YIELD option the island actually holds (a premium raw like Meat is used before plain Grain —
 *  what gives Meat genuine import demand as "the good food-raw"); else the one it has most of. */
function resolveInput(island, input) {
  if (input.all) return input.all;
  const opts = input.anyOf;
  const yields = input.yield || null;
  let best = opts[0], bestStock = -1, localPick = null, held = null, heldY = -1;
  for (const res of opts) {
    if (producesRaw(island, res)) { localPick = localPick || res; }
    const s = island.stock[res] || 0;
    if (s > bestStock) { bestStock = s; best = res; }
    const y = yields && yields[res] ? yields[res] : 1;
    if (s > 1 && y > heldY) { heldY = y; held = res; }  // a premium raw on hand is preferred to a plainer one
  }
  return localPick || held || best;
}

/** Goods production for one island's recipes. Iterates the CANONICAL `island.workshops` (not the
 *  derived `produces`), so a workshop's operating condition scales its output directly. */
export function produceGoods(world, h) {
  const t = world.rules;
  const industrial = t.INDUSTRIAL_GOODS || [];
  for (const island of world.islands) {
    const staffing = workshopStaffing(island, t); // how much of its industry the population can crew
    for (const shop of island.workshops || []) {
      const out = shop.good;
      const recipe = world.economy._recipeByOut[out];
      if (!recipe) continue;

      // Desired output rate scales with population (more artisans).
      let rate = t.POP_GOODS_COEFF * island.population;
      // A mutable INDUSTRIAL workshop scales output by its 0..1 operating condition AND its staffing
      // (a squeezed or over-built port's manufacturing visibly falls; derelict/unstaffed → ~0).
      // Survival goods (Food/Ale) are NOT workshop-gated and always run at full rate. Labour gates
      // OUTPUT only — it never kills population.
      const isInd = industrial.includes(out);
      if (isInd) rate *= (shop.condition != null ? shop.condition : 1) * staffing;
      const potential = rate; // what the workshop COULD make before input limits — for the starvation flag

      // Cap by every input. Locally-produced inputs cap at 75% of their production
      // rate (guarantees raw surplus); imported inputs cap at a throughput of their
      // on-hand stock (so more output demands more imports). Also never exceed what
      // is on hand this step.
      const resolved = [];
      let yieldMult = 1; // a premium raw (e.g. Meat) yields MORE output per unit than a plain one
      for (const input of recipe.inputs) {
        const res = resolveInput(island, input);
        resolved.push([res, input.qty]);
        if (input.yield && input.yield[res]) yieldMult *= input.yield[res];
        const localRate = effectiveRate(island, res, t);
        const capByInput = localRate > 0
          ? (t.GOODS_MAX_INPUT_FRACTION * localRate) / input.qty
          : (t.INPUT_THROUGHPUT_RATE * (island.stock[res] || 0)) / input.qty;
        const capByStock = (island.stock[res] || 0) / input.qty / h;
        rate = Math.min(rate, capByInput, capByStock);
      }

      // INPUT-STARVATION flag (for the policy demolish trigger, v2 #9): a workshop that is crewed and
      // in good repair but whose INPUTS choke output to ~nothing is an undying money-pit — it bills
      // upkeep while making nothing. Flag it (potential = pre-input-cap rate) so policy.js can retire it.
      if (isInd) shop._starved = potential > 0.01 && rate < 0.1 * potential;

      // Don't overfill a full warehouse. Ships (a SPECIAL good) stockpile only a few
      // hulls — a shipyard builds to a small buffer and refills as they're bought,
      // instead of piling thousands of unsold ships up to the goods cap.
      const outCap = t.SPECIAL_GOODS.includes(out) ? t.SHIP_STOCK_CAP : t.GOODS_CAP;
      const outTaper = clamp(1 - island.stock[out] / outCap, 0, 1);
      rate = Math.max(0, rate) * outTaper;
      if (rate <= 0) continue;

      const made = rate * h;
      for (const [res, qty] of resolved) {
        island.stock[res] = Math.max(0, island.stock[res] - made * qty); // inputs consumed at raw rate...
      }
      island.stock[out] = clamp(island.stock[out] + made * yieldMult, 0, outCap); // ...output scaled by yield
    }
  }
}
