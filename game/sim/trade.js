// Dispatch (assign a voyage to each idle NPC ship) + conserved per-stop settlement.
// PURE. Gold/goods/people move only through the `transfer` primitive here and in
// ship.js, so conservation of *transfers* holds by construction (the deliberate gold
// source/sink lives only in upkeep.js).

import { transfer, cargoUnits, GOLD, PEOPLE } from './resources.js';
import { bidAsk } from './pricing.js';
import { planVoyage } from './goals.js';
import { recordTrade, repPriceMult } from './reputation.js';
import { logEventThrottled } from './events.js';

/**
 * Set island.wantsShip via hysteresis: a port wealthy enough to buy a ship AND keep a
 * reserve, with room in its fleet, sustained over the hysteresis window. Deliberately
 * NOT gated on "fleet busy" — the old rule required all ships busy, which could never
 * coincide with the idle ship needed to go fetch the new one (so nobody ever bought).
 * Fleet size is then bounded on the paying side by upkeep (a big fleet drains gold below
 * the buy threshold) plus the per-island / global hard caps.
 */
function updateShipDemand(world, island) {
  const t = world.rules;
  const owned = world.ships.filter((s) => s.homeId === island.id).length;
  const pressure = owned > 0
    && owned < t.MAX_SHIPS_PER_ISLAND
    && world.ships.length < t.MAX_SHIPS_TOTAL
    && island.gold > t.SHIP_GOLD_PRICE * t.SHIP_BUY_GOLD_MULT;
  if (pressure) {
    if (island._shipBusySince < 0) island._shipBusySince = world.simTime;
    island.wantsShip = world.simTime - island._shipBusySince >= t.SHIP_DEMAND_HYSTERESIS;
  } else {
    island._shipBusySince = -1;
    island.wantsShip = false;
  }
}

/** Assign a voyage to each idle, un-tasked NPC ship at its home island. */
export function dispatch(world) {
  for (const island of world.islands) updateShipDemand(world, island);
  for (const ship of world.ships) {
    if (ship.state !== 'idle' || ship.voyage) continue;
    const agent = world.agents[ship.ownerId];
    if (!agent || agent.kind !== 'npc') continue; // player ships are driven by intents
    const home = world.islandsById.get(ship.homeId);
    if (!home) continue;
    const v = planVoyage(world, home, ship);
    if (v) ship.voyage = v;
  }
}

/**
 * Settle one voyage stop at the island, at its LIVE prices. For each leg the qty is
 * computed FIRST (min of cargo/room/bank/stock/space), then payment = qty*price, and
 * both sides apply from that single scalar via `transfer` — so gold and every good are
 * conserved.
 */
export function executeStop(world, island, ship, stop) {
  const t = world.rules;
  const swing = t.REP_PRICE_SWING;
  const homeId = ship.homeId;
  let volume = 0; // goods moved this stop → drives the reputation gained

  // SELL leg: island BUYS the carried goods at its bid, but only up to its demand
  // (target*RESERVE - stock), so surplus reaches consumers/reserves and no warehouse
  // fills past what it can use. Bid is nudged by how the island feels about the ship's
  // home (friends get a better price). Unsold cargo stays aboard and continues the voyage.
  for (const good in stop.sell) {
    const bid = bidAsk(island.price[good].mid, t.SPREAD).bid * repPriceMult(island, homeId, swing, false);
    const have = ship.cargo[good] || 0;
    const affordable = bid > 0 ? island.gold / bid : 0;
    const room = Math.max(0, island.targets[good] * t.RESERVE_RATIO - (island.stock[good] || 0));
    const qty = Math.min(stop.sell[good], have, affordable, room);
    if (qty <= 0) continue;
    transfer(ship.cargo, good, island.stock, good, qty);
    transfer(island, 'gold', ship.cargo, GOLD, qty * bid);
    volume += qty;
  }

  // OPPORTUNISTIC OFFLOAD: sell any OTHER carried surplus this port actually wants (below
  // its reserve ceiling + solvent) — not just the goods planned for this stop. This frees
  // the hold and earns gold BEFORE the buy leg, so a ship stops hauling unsellable cargo in
  // circles and always has room for what it came to buy (e.g. food). Goods the voyage is
  // deliberately carrying HOME (in some stop's buy list) are kept, not dumped.
  const carryHome = new Set();
  if (ship.voyage) for (const st of ship.voyage.stops) for (const g in st.buy) carryHome.add(g);
  for (const good in ship.cargo) {
    // Never opportunistically dump coin, migrants, ships, planned trade goods, or the ship's own
    // defensive Weapons (guns are for fighting, not offloading — planned Weapons exports still sell).
    if (good === GOLD || good === PEOPLE || good === 'Ships' || good === 'Weapons' || carryHome.has(good) || stop.sell[good]) continue;
    const have = ship.cargo[good] || 0;
    if (have <= 0) continue;
    const bid = bidAsk(island.price[good].mid, t.SPREAD).bid * repPriceMult(island, homeId, swing, false);
    const room = Math.max(0, island.targets[good] * t.RESERVE_RATIO - (island.stock[good] || 0));
    const qty = Math.min(have, bid > 0 ? island.gold / bid : 0, room);
    if (qty <= 0) continue;
    transfer(ship.cargo, good, island.stock, good, qty);
    transfer(island, 'gold', ship.cargo, GOLD, qty * bid);
    volume += qty;
  }

  // BUY leg: island SELLS the requested goods to the ship at its ask (rep-adjusted; a
  // friendly port discounts, a rival gouges). Bounded by ship gold, stock, hold space.
  for (const good in stop.buy) {
    const ask = bidAsk(island.price[good].mid, t.SPREAD).ask * repPriceMult(island, homeId, swing, true);
    const stockAvail = island.stock[good] || 0;
    const affordable = ask > 0 ? (ship.cargo[GOLD] || 0) / ask : 0;
    const space = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
    const qty = Math.min(stop.buy[good], stockAvail, affordable, space);
    if (qty <= 0) continue;
    transfer(island.stock, good, ship.cargo, good, qty);
    transfer(ship.cargo, GOLD, island, 'gold', qty * ask);
    volume += qty;
  }

  // PEOPLE leg: deliver the migrants routed to this stop.
  if (stop.people > 0 && (ship.cargo[PEOPLE] || 0) > 0) {
    const moved = transfer(ship.cargo, PEOPLE, island, 'population', Math.min(stop.people, ship.cargo[PEOPLE]));
    if (moved >= t.MIGRATE_NEWS_MIN) {
      const from = world.islandsById.get(homeId);
      logEventThrottled(world, 'migrate', 0.4 * t.SIM_DAY_SECONDS, `${Math.round(moved)} settlers from ${from ? from.name : 'afar'} land at ${island.name}`, { islandId: island.id });
    }
  }

  // A completed trade builds diplomacy (and shifts every third party's view — blocs).
  if (volume > 0) recordTrade(world, island, homeId, volume);
}
