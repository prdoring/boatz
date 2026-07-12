// Voyage planner. Instead of a single-partner errand, an idle ship gets a VOYAGE: a
// hold loaded with a diversified basket of the home's surpluses, an ordered route of
// stops (multi-hop) where it sells/buys/drops-migrants, then home. This is what makes
// ships carry several goods, visit multiple islands, do two-part (sell-here-buy-there)
// trades, and carry migrants — all in one trip. PURE.
//
// A voyage: { reason, stops: [{ islandId, sell:{good:qty}, buy:{good:qty}, people }], index }
//   sell    — goods loaded at home and SOLD to that stop (island buys at its bid).
//   buy     — goods BOUGHT from that stop (island sells at its ask) with carried gold.
//   people  — migrants delivered to that stop's population.
//   reason  — dominant purpose, for the UI (buyShip > migrate > food > trade).

import { foodDays } from './island.js';
import { findBestPartner, nearestWhere, nearbyIslands, dist } from './queries.js';
import { tradeables } from './resources.js';
import { bidAsk } from './pricing.js';
import { intelAge, currentDay } from './beliefs.js';
import { navProfile } from './captains.js';

function emptyStop(islandId) { return { islandId, sell: {}, buy: {}, people: 0 }; }

/** The home's biggest relative deficit good (for backhaul), skipping special goods. */
export function biggestDeficit(world, island) {
  const t = world.rules;
  let best = null, bestRatio = Infinity;
  for (const res of tradeables(world.economy)) {
    if (t.SPECIAL_GOODS.includes(res)) continue;
    const r = island.stock[res] / Math.max(island.targets[res], 1);
    if (r < t.IMPORT_RATIO && r < bestRatio) { bestRatio = r; best = res; }
  }
  return best;
}

/** Exportable surpluses (stock > ratio*target) with a profitable buyer, richest first. */
function collectExports(world, home, ratio, perGoodCap, travelMult = 1) {
  const t = world.rules;
  const out = [];
  for (const res of tradeables(world.economy)) {
    if (t.SPECIAL_GOODS.includes(res)) continue;
    if (home.stock[res] < ratio * home.targets[res]) continue;
    const excess = home.stock[res] - home.targets[res];
    if (excess < 1) continue;
    const sell = findBestPartner(world, home, res, 'export', travelMult);
    if (!sell || sell.margin <= 0) continue;
    out.push({ res, excess, sell, unit: sell.margin });
  }
  out.sort((a, b) => b.unit * Math.min(b.excess, perGoodCap) - a.unit * Math.min(a.excess, perGoodCap));
  return out;
}

export function planVoyage(world, home, ship) {
  const t = world.rules;
  const cap = ship.capacity;
  const perGoodCap = Math.max(1, cap * t.PER_GOOD_CAP_FRACTION);
  const stops = [];
  const stopFor = (id) => {
    let s = stops.find((x) => x.islandId === id);
    if (!s) { s = emptyStop(id); stops.push(s); }
    return s;
  };
  const roomForStop = (id) => stops.length < t.MAX_STOPS || stops.some((s) => s.islandId === id);

  const nav = navProfile(ship.captain, t); // the captain's personality shapes the choices below

  let capLeft = cap;
  let goldLeft = home.gold * t.GOLD_SPEND_FRACTION;
  let profit = 0;
  let foodBought = false, shipBought = false, peopleLoaded = false, shopped = false, scouting = false;

  // (1) SURVIVAL — import Food toward the target from the cheapest reachable seller. A
  //     starving port's priority is FOOD, so RESERVE most of the hold for it (up to 70%),
  //     even if it can't afford all of that yet — it earns the gold selling its cargo on the
  //     way (sell-stops are routed first). This is what stops a food run from arriving with a
  //     hold full of unsold exports and no room to buy the food it came for.
  if (foodDays(home, t) < t.SURVIVAL_DAYS) {
    const found = findBestPartner(world, home, 'Food', 'import', nav.travelMult);
    if (found && roomForStop(found.partner.id)) {
      const gap = Math.max(0, home.targets.Food - home.stock.Food);
      const reserve = Math.min(capLeft, gap, Math.round(cap * 0.7)); // hold space for food
      const afford = found.unitPrice > 0 ? goldLeft / found.unitPrice : 0;
      if (reserve >= 1) {
        stopFor(found.partner.id).buy.Food = reserve;
        capLeft -= reserve;
        goldLeft -= Math.min(reserve, afford) * found.unitPrice; // only commit gold we can actually spend now
        foodBought = true;
      }
    }
  }

  // (2) BUY SHIP — a wealthy port claims a shipyard stop BEFORE exports fill every slot.
  //     (A rich exporter is rich precisely because its voyages are full of sales, which
  //     would otherwise crowd the purchase out — the catch-22 that meant nobody ever bought.)
  if (home.wantsShip) {
    const owned = world.ships.filter((s) => s.homeId === home.id).length;
    const inflight = world.ships.filter((s) => s.homeId === home.id && s.voyage && s.voyage.reason === 'buyShip').length;
    if (owned + inflight < t.MAX_SHIPS_PER_ISLAND && world.ships.length + inflight < t.MAX_SHIPS_TOTAL) {
      const yard = nearestWhere(world, home, (p) => (p.stock.Ships || 0) >= 1);
      if (yard && roomForStop(yard.id)) {
        const ask = bidAsk(yard.price.Ships.mid, t.SPREAD).ask;
        if (goldLeft >= ask) { stopFor(yard.id).buy.Ships = 1; goldLeft -= ask; shipBought = true; }
      }
    }
  }

  // (3) EXPORTS — load a diversified basket (up to MAX_CARGO_KINDS goods), each routed
  //     to its best buyer. This fills the hold with multiple goods and multiple stops.
  const addExports = (ratio) => {
    let kinds = 0;
    for (const e of collectExports(world, home, ratio, perGoodCap, nav.travelMult)) {
      if (kinds >= t.MAX_CARGO_KINDS || capLeft < 1) break;
      if (stopFor && !roomForStop(e.sell.partner.id)) continue;
      const stop = stopFor(e.sell.partner.id);
      if (stop.sell[e.res]) continue;
      const qty = Math.min(e.excess, perGoodCap, capLeft);
      if (qty < 1) continue;
      stop.sell[e.res] = qty; capLeft -= qty; profit += e.unit * qty; kinds++;
    }
  };
  addExports(t.EXPORT_RATIO);

  // (3) MIGRATION — people leave for a reason and pick where by opportunity (push + pull):
  //   PUSH (must leave): famine (food-short) or overcrowding (pop near carrying capacity).
  //   PULL (where to): the most attractive reachable haven — higher civ, food-secure, room.
  //   A gentler TRICKLE also leaves a comfortable island when a MARKEDLY more prosperous
  //   neighbour beckons (opportunity/urbanisation) — but a healthy producer never bleeds
  //   its whole workforce to a hoarder, which would hollow out the islands that feed all.
  if (home.population > t.POP_FLOOR + t.MIGRATION_BATCH) {
    const foodShort = foodDays(home, t) < t.FOOD_SECURITY_DAYS;
    const crowded = home.population > 0.85 * home.k;
    let best = null, bestScore = -Infinity;
    for (const p of nearbyIslands(world, home)) {
      if (p.population >= 0.92 * p.k) continue;               // no room to take them
      if (foodDays(p, t) < t.FOOD_SECURITY_DAYS) continue;    // must at least be able to feed them
      const score = (p.civ - home.civ) * 3
        + (foodDays(p, t) - foodDays(home, t)) * 0.04
        - dist(home, p) * 0.0003;                             // travel is an opportunity cost
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && roomForStop(best.id)) {
      let batch = 0;
      if (foodShort) batch = t.MIGRATION_BATCH * 1.5;                       // flee famine
      else if (crowded) batch = t.MIGRATION_BATCH;                          // relieve crowding
      else if (bestScore >= t.MIGRATE_MIN_CIV_GAP) batch = t.MIGRATION_BATCH * 0.7; // seek opportunity
      const ppl = Math.min(batch, home.population - t.POP_FLOOR, capLeft);
      if (ppl >= 1) { stopFor(best.id).people = ppl; capLeft -= ppl; peopleLoaded = true; }
    }
  }

  // (5) BACKHAUL — buy the home's biggest deficit at a stop that sells it (two-part trade).
  const deficit = biggestDeficit(world, home);
  if (deficit && capLeft >= 1 && goldLeft > 0) {
    for (const s of stops) {
      const p = world.islandsById.get(s.islandId);
      if (!p || (p.stock[deficit] || 0) < 1 || s.buy[deficit]) continue;
      const ask = bidAsk(p.price[deficit].mid, t.SPREAD).ask;
      if (ask <= 0) continue;
      const room = Math.max(0, home.targets[deficit] - home.stock[deficit]);
      const qty = Math.min(perGoodCap, capLeft, goldLeft / ask, room);
      if (qty >= 1) { s.buy[deficit] = qty; goldLeft -= qty * ask; capLeft -= qty; break; }
    }
  }

  // (6) PROSPERITY — a cash-rich port develops a taste: it imports the comfort/luxury goods
  //     it lacks (and doesn't make itself), spending hoarded gold. That lifts its civ (via
  //     comfort reserves), turning it into a magnet for migrants, and recycles wealth to the
  //     islands that craft those goods. A poor port skips this and just survives + exports —
  //     so rich and poor islands visibly behave differently.
  if (goldLeft > t.PROSPERITY_GOLD && capLeft >= 1) {
    for (const good of ['LuxuryGoods', 'Ale', 'Clothing']) {
      if (capLeft < 1 || goldLeft <= 0) break;
      if ((home.stock[good] || 0) >= home.targets[good]) continue;
      if (home.produces.includes(good)) continue; // don't import what you make
      const found = findBestPartner(world, home, good, 'import', nav.travelMult);
      if (!found || !roomForStop(found.partner.id)) continue;
      const room = home.targets[good] - (home.stock[good] || 0);
      const qty = Math.min(perGoodCap * 0.6, capLeft, found.unitPrice > 0 ? goldLeft / found.unitPrice : 0, room);
      if (qty >= 1) {
        const st = stopFor(found.partner.id);
        st.buy[good] = (st.buy[good] || 0) + qty;
        goldLeft -= qty * found.unitPrice; capLeft -= qty; shopped = true;
      }
    }
  }

  // (7) SCOUT — no real errand (no food need, nothing worth exporting): rather than shuffle a
  //     marginal surplus around, send the ship to RECONNOITRE the ports whose prices the home
  //     knows least about (unknown first, then most stale), nearer preferred. It carries no
  //     cargo — it goes to look. This is how price information reaches islands off the beaten
  //     trade routes (a ship that only ever shuttles its two staples never learns what a far
  //     market pays), and it keeps otherwise-idle vessels useful. Fires BEFORE the desperate
  //     marginal-export fallback so recon actually beats a penny-shuffle.
  //     A WANDERER scouts sooner (lower staleness bar) and visits more ports; a HOMEBODY
  //     barely bothers — so exploration is a matter of the captain's temperament.
  if (stops.length === 0) {
    const day = currentDay(world);
    const cand = nearbyIslands(world, home)
      .map((p) => ({ p, age: intelAge(home, p.id, day) }))
      .filter((c) => c.age >= nav.scoutStale)
      .map((c) => ({ ...c, score: c.age - dist(home, c.p) * t.SCOUT_DIST_WEIGHT }))
      .sort((a, b) => b.score - a.score);
    for (const c of cand.slice(0, nav.scoutStops)) { if (roomForStop(c.p.id)) { stopFor(c.p.id); scouting = true; } }
  }

  // Last resort: keep the ship busy on the best surplus at a lower bar (no scout target left).
  if (stops.length === 0) addExports(1.0);
  if (stops.length === 0) return null;

  const reason = shipBought ? 'buyShip' : peopleLoaded ? 'migrate'
    : foodBought ? 'food' : scouting ? 'scout' : 'trade';
  // Don't shuttle for pennies: a pure-trade voyage must clear the profit floor (unless it's
  // also a luxury-shopping run). A GREEDY captain sets a higher bar (skips thin trades); an
  // easygoing one will take almost any positive run. Scout/errand voyages are exempt.
  if (reason === 'trade' && profit < t.MIN_TRADE_PROFIT * nav.profitMult && !shopped) return null;

  return { reason, stops: orderByPath(home, stops, world), index: 0 };
}

const sumVals = (o) => { let n = 0; for (const k in o) n += o[k]; return n; };

/** Order stops SELL-heavy first, BUY-heavy last (each a greedy nearest-neighbour walk), so
 *  a ship offloads its cargo and earns gold before it reaches a stop where it needs to buy
 *  (e.g. food) — which requires freed hold space and coin. */
function orderByPath(home, stops, world) {
  const netSeller = (s) => sumVals(s.sell) - sumVals(s.buy) - s.people >= 0;
  const sellStops = stops.filter(netSeller);
  const buyStops = stops.filter((s) => !netSeller(s));
  const ordered = [];
  let cx = home.x, cy = home.y;
  const walk = (group) => {
    const rem = group.slice();
    while (rem.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rem.length; i++) {
        const p = world.islandsById.get(rem[i].islandId);
        const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      const s = rem.splice(bi, 1)[0];
      const p = world.islandsById.get(s.islandId);
      cx = p.x; cy = p.y;
      ordered.push(s);
    }
  };
  walk(sellStops);
  walk(buyStops);
  return ordered;
}
