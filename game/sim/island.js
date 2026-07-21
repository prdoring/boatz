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
    // WORKSHOPS are the CANONICAL industry list — one per good the island makes, each a 0..1
    // operating condition (default 1 = new). `produces` below is the DERIVED capability cache
    // (rebuilt from workshops on any change; kept because ~a dozen readers key off it). Seeded in
    // `produces` order so t=0 is byte-identical to the old model. Mutate ONLY via mutateWorkshops().
    workshops: spec.produces.map((g) => ({ good: g, condition: 1 })),
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
    tax: 0,             // 0..TAX_MAX income-tax rate the magistrate sets (policy.js) — funds ambition, breeds unrest
    tariff: 0,          // 0..TARIFF_MAX duty the host levies on foreign traders (policy.js → trade.js)
    development: 0,     // infrastructure levels bought by the magistrate (+1 workshop slot each; slotCap reads it)
    _holds: [],         // goods withheld from export in distress (policy.js → trade.js/goals.js); plain array (JSON-safe)
    _approval: 0,       // signed, decaying memory of recent policy that biases the loyalty attractor (magistrate.js)
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

/** THE single mutator for `island.workshops` (the canonical industry list). Rebuilds the derived
 *  `produces` capability cache and marks the world's per-good producer index dirty (goals.js
 *  producersOf) so every reader that keys off `produces` — routing, intel, contracts, snapshot/UI —
 *  stays consistent. EVERY workshop change (magistrate policy build/switch/demolish, a haven's fall /
 *  civilian→war conversion, redemption, roster seeding) MUST route through here; nothing else may
 *  assign `island.workshops`. `next` is the new [{good,condition}] array (order is preserved into
 *  `produces`). PURE (mutates the passed island + a world dirty flag; no RNG). */
export function mutateWorkshops(world, island, next) {
  island.workshops = next;
  island.produces = next.map((w) => w.good);
  if (world) world._producersDirty = true; // coalesced: goals.js flushProducers rebuilds once at pass end
}

/** Fraction (0..1) of an island's INDUSTRIAL workshops it can crew from its population. The labour
 *  pool is WORKFORCE_FRAC of the population, and each workshop demands LABOR_PER_WORKSHOP hands; a port
 *  over-built for its population (or shrunk by famine/plague) can't staff them all, so its output and
 *  workshop condition fall. Food/Ale are NOT industrial → not counted (they don't draw on the pool).
 *  Returns 1 when the island has no industrial workshops. PURE. */
export function workshopStaffing(island, tuning) {
  const industrial = tuning.INDUSTRIAL_GOODS || [];
  let n = 0;
  for (const s of island.workshops || []) if (industrial.includes(s.good)) n++;
  if (n === 0) return 1;
  const labor = island.population * (tuning.WORKFORCE_FRAC || 0.5);
  return Math.min(1, labor / ((tuning.LABOR_PER_WORKSHOP || 10) * n));
}

/** How many INDUSTRIAL workshop SLOTS this island can hold: a population-tiered base plus any
 *  `development` the magistrate has bought, capped at MAX_SLOTS, and floored by however many industrial
 *  workshops it already runs (so a shrinking port never shows "negative" room). PURE. */
export function slotCap(island, tuning) {
  const tiers = tuning.SLOT_POP_TIERS || [];
  let bonus = 0;
  for (const th of tiers) if (island.population >= th) bonus++;
  const cap = Math.min(tuning.MAX_SLOTS || 6, (tuning.SLOT_BASE || 2) + bonus + (island.development || 0));
  const industrial = tuning.INDUSTRIAL_GOODS || [];
  let have = 0;
  for (const s of island.workshops || []) if (industrial.includes(s.good)) have++;
  return Math.max(have, cap);
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
