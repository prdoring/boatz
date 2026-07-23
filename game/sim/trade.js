// Dispatch (assign a voyage to each idle NPC ship) + conserved per-stop settlement.
// PURE. Gold/goods/people move only through the `transfer` primitive here and in
// ship.js, so conservation of *transfers* holds by construction (the deliberate gold
// source/sink lives only in upkeep.js).

import { transfer, cargoUnits, GOLD, PEOPLE } from './resources.js';
import { bidAsk } from './pricing.js';
import { planVoyage } from './goals.js';
import { buildPartnerIndex, clearPartnerIndex } from './queries.js';
import { recordTrade, repPriceMult, tradeBarred, bumpRep, tariffMult } from './reputation.js';
import { logEvent, logEventThrottled } from './events.js';
import { contractPayout } from './contracts.js';
import { fleetBelievedByHome } from './voyages.js';
import { computeFleetByHome } from './fleet.js';

/**
 * Set island.wantsShip via hysteresis: a port wealthy enough to buy a ship AND keep a
 * reserve, with room in its fleet, sustained over the hysteresis window. Deliberately
 * NOT gated on "fleet busy" — the old rule required all ships busy, which could never
 * coincide with the idle ship needed to go fetch the new one (so nobody ever bought).
 * Fleet size is then bounded on the paying side by upkeep (a big fleet drains gold below
 * the buy threshold) plus the per-island / global hard caps.
 */
function updateShipDemand(world, island, liveIds) {
  const t = world.rules;
  // Plan around the fleet the port BELIEVES it has: ships afloat under its flag PLUS any lost at
  // sea it hasn't yet given up for missing (voyages.js). So it won't rush to replace a ship it
  // still expects home — a sunk vessel only frees a berth once it's presumed lost.
  const owned = fleetBelievedByHome(world, island, liveIds);
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
  const t = world.rules;
  // Per-home ship census (O(S)) — replaces the O(N·S) full-fleet scan that ship-demand did per
  // island, and the buy-ship gate's per-plan scan. Also track in-flight buy-ship voyages per home
  // so a wealthy port doesn't queue a second purchase in the same pass (recomputed live below as
  // voyages are assigned, exactly as the old per-plan filter did).
  computeFleetByHome(world);
  // Per-good SELL/BUY candidate index for this pass — every planVoyage's findBestPartner scans only
  // real candidates for the good, not all N islands (island stock/gold are frozen through dispatch).
  buildPartnerIndex(world);
  const liveIds = new Set();
  const inflight = new Map();
  for (const s of world.ships) {
    liveIds.add(s.id);
    if (s.voyage && s.voyage.reason === 'buyShip') inflight.set(s.homeId, (inflight.get(s.homeId) || 0) + 1);
  }
  const ctx = { inflight };
  for (const island of world.islands) { if (!island.haven) updateShipDemand(world, island, liveIds); }
  for (const ship of world.ships) {
    if (ship.state !== 'idle' || ship.voyage) continue;
    // Re-plan cooldown: a ship that just found NO viable voyage waits a short spell before scanning
    // again, instead of re-running the full O(N) planner every substep forever (the idle-churn
    // hotspot). A productive ship never hits this — a successful plan leaves the idle state at once,
    // and one just home has a long-lapsed cooldown, so it plans immediately.
    if (world.simTime < (ship._planCd || 0)) continue;
    const agent = world.agents[ship.ownerId];
    if (!agent || agent.kind !== 'npc') continue; // player ships are driven by intents
    const home = world.islandsById.get(ship.homeId);
    if (!home || home.haven) continue; // a pirate haven runs no honest trade
    const v = planVoyage(world, home, ship, ctx);
    if (v) { ship.voyage = v; if (v.reason === 'buyShip') inflight.set(home.id, (inflight.get(home.id) || 0) + 1); }
    else ship._planCd = world.simTime + t.SHIP_REPLAN_COOLDOWN; // nothing to do — recheck later, not every substep
  }
  clearPartnerIndex(world); // out-of-dispatch callers must fall back to a live scan
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
  let festiveVolume = 0; // Luxury/Ale sold to a port mid-FESTIVAL → extra goodwill (supplying the feast)

  // EMBARGO — a feud severs the trade line: the port turns the trader away, no goods or coin
  // change hands at any price. Refugees already aboard still land (people, not politics).
  if (tradeBarred(world, island.id, homeId, t)) {
    if (stop.people > 0 && (ship.cargo[PEOPLE] || 0) > 0) {
      transfer(ship.cargo, PEOPLE, island, 'population', Math.min(stop.people, ship.cargo[PEOPLE]));
    }
    return;
  }

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
    const reward = contractPayout(world, island, good, qty); // claim any open contract reward (from escrow)
    if (reward > 0) ship.cargo[GOLD] = (ship.cargo[GOLD] || 0) + reward;
    volume += qty;
    if (island.festival && (good === 'LuxuryGoods' || good === 'Ale')) festiveVolume += qty;
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
    if (stop.gift && stop.gift[good]) continue; // aid cargo is a gift for this port, not for sale
    const have = ship.cargo[good] || 0;
    if (have <= 0) continue;
    const bid = bidAsk(island.price[good].mid, t.SPREAD).bid * repPriceMult(island, homeId, swing, false);
    const room = Math.max(0, island.targets[good] * t.RESERVE_RATIO - (island.stock[good] || 0));
    const qty = Math.min(have, bid > 0 ? island.gold / bid : 0, room);
    if (qty <= 0) continue;
    transfer(ship.cargo, good, island.stock, good, qty);
    transfer(island, 'gold', ship.cargo, GOLD, qty * bid);
    const reward = contractPayout(world, island, good, qty); // an opportunistic drop can fill a contract too
    if (reward > 0) ship.cargo[GOLD] = (ship.cargo[GOLD] || 0) + reward;
    volume += qty;
    if (island.festival && (good === 'LuxuryGoods' || good === 'Ale')) festiveVolume += qty;
  }

  // BUY leg: island SELLS the requested goods to the ship at its ask (rep-adjusted; a
  // friendly port discounts, a rival gouges). Bounded by ship gold, stock, hold space.
  for (const good in stop.buy) {
    // EXPORT HOLD: a magistrate in distress withholds strategic goods (e.g. Food/Weapons) from FOREIGN
    // buyers — its own fleet (homeId === island.id) may still load them. TARIFF: a protectionist host
    // adds a duty to a foreigner's ask (composed alongside the reputation multiplier; fleet-mates exempt).
    if (homeId !== island.id && (island._holds || []).includes(good)) continue;
    const ask = bidAsk(island.price[good].mid, t.SPREAD).ask * repPriceMult(island, homeId, swing, true) * tariffMult(island, homeId);
    const stockAvail = island.stock[good] || 0;
    const affordable = ask > 0 ? (ship.cargo[GOLD] || 0) / ask : 0;
    const space = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
    const qty = Math.min(stop.buy[good], stockAvail, affordable, space);
    if (qty <= 0) continue;
    transfer(island.stock, good, ship.cargo, good, qty);
    transfer(ship.cargo, GOLD, island, 'gold', qty * ask);
    volume += qty;
  }

  // AID leg: a gift of food from an ally in its hour of need — no coin changes hands, and the
  // act of solidarity strongly warms the friendship (worth far more rapport than a plain sale).
  if (stop.gift) {
    let given = 0;
    for (const good in stop.gift) {
      const qty = Math.min(stop.gift[good], ship.cargo[good] || 0);
      if (qty > 0) given += transfer(ship.cargo, good, island.stock, good, qty);
    }
    if (given > 0.5) {
      bumpRep(world, island.id, homeId, t.REP_AID_GAIN);
      const from = world.islandsById.get(homeId);
      logEvent(world, 'aid', `${from ? from.name : 'An ally'} sent ${Math.round(given)} food as aid to famine-struck ${island.name} — a friend in need.`, { islandId: island.id });
    }
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
  // Supplying a port's FESTIVAL (its luxuries/ale) earns the trader extra goodwill beyond the plain sale —
  // so festivals build lasting blocs between splendor ports and their suppliers.
  if (festiveVolume > 0 && homeId !== island.id) {
    bumpRep(world, island.id, homeId, (t.REP_FESTIVAL_GAIN || 0) * Math.min(1, festiveVolume / (t.REP_VOLUME_NORM || 60)));
  }
}
