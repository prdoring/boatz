// Island factory + derived quantities. PURE (no engine/config import).

import { newStock, tradeables, targetFor, basePrice, safeDiv } from './resources.js';

/** Build an island from a roster spec + the economy definition. */
export function createIsland(spec, economy, tuning) {
  const island = {
    id: spec.id,
    name: spec.name,
    x: spec.x,
    y: spec.y,
    ownerId: 'npc',
    type: spec.type,
    color: spec.color,
    primary: spec.primary,
    secondary: spec.secondary,
    k: spec.k,
    produces: spec.produces.slice(),
    stock: newStock(economy),
    gold: tuning.START_ISLAND_GOLD,
    population: tuning.START_POP,
    civ: 0,
    targets: {},
    price: {},
    beliefs: {},    // { otherId: { good: { mid, day } } } — imperfect knowledge of others' prices (beliefs.js)
    blight: null,   // { res, until } — a production shock on a resource (see events.js)
    plague: null,   // { until }      — population/production shock, spreads via ships
    wantsShip: false,
    grievance: 0,       // accumulated resentment from rebellions crushed by force (magistrate.js)
    _shipBusySince: -1, // simTime since which every ship has been busy (for ship-buy hysteresis)
    _runs: 0,           // completed trade runs by this island's ships (metric)
  };
  // Seed a little starting stock of the primary raw so early trade has something to move.
  island.stock[spec.primary] = tuning.STOCKPILE_CAP * 0.15;
  for (const res of tradeables(economy)) {
    island.targets[res] = targetFor(tuning, res);
    island.price[res] = { mid: basePrice(tuning, res) };
  }
  return island;
}

/** Food consumed per sim-second by this island's population. */
export function foodConsumptionRate(island, tuning) {
  return island.population * tuning.FOOD_PER_CAPITA;
}

/** How many sim-days of Food the island has on hand at current consumption. */
export function foodDays(island, tuning) {
  const perDay = foodConsumptionRate(island, tuning) * tuning.SIM_DAY_SECONDS;
  return safeDiv(island.stock.Food, perDay, 999);
}

/** Whether the island is producing a given base resource (primary or secondary). */
export function producesRaw(island, res) {
  return island.primary === res || island.secondary === res;
}

/**
 * Effective per-sim-second production rate of a base resource at this island.
 * The single injection point for future buildings/tech modifiers (returns the
 * base rate today). 0 for a resource the island does not produce.
 */
export function effectiveRate(island, res, tuning) {
  if (island.rebellion) return 0; // the island is aflame — nothing is produced during a revolt
  let rate;
  if (island.primary === res) rate = tuning.BASE_PRODUCTION_RATE;
  else if (island.secondary === res) rate = tuning.BASE_PRODUCTION_RATE * tuning.SECONDARY_FRACTION;
  else return 0;
  // Event modifiers: blight cripples the afflicted resource; plague slows all labour.
  if (island.blight && island.blight.res === res) rate *= tuning.BLIGHT_SEVERITY;
  if (island.plague) rate *= tuning.PLAGUE_PROD_PENALTY;
  // Seasonal swing (weather.js sets _prodMult): a bumper autumn, a lean winter.
  if (island._prodMult) rate *= island._prodMult;
  return rate;
}
