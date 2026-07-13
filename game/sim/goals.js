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

import { foodDays, producesRaw } from './island.js';
import { findBestPartner, nearestWhere, dist } from './queries.js';
import { tradeables } from './resources.js';
import { bidAsk } from './pricing.js';
import { intelAge, beliefMid, currentDay } from './beliefs.js';
import { believedFoodDays, believedHaven, believedCiv } from './intel.js';
import { navProfile } from './captains.js';
import { fleetAt } from './fleet.js';

function emptyStop(islandId) { return { islandId, sell: {}, buy: {}, people: 0 }; }

/** Whether `island` is a source of `res` — either a manufactured good it makes, or a raw it mines
 *  (raws live on primary/secondary, NOT in `produces`, which lists only finished goods). */
function makesRes(island, res) { return island.produces.includes(res) || producesRaw(island, res); }

const EMPTY = Object.freeze([]);

/** Islands that can SOURCE `res` (make the good or mine the raw). Production capability is fixed for
 *  the roster, so the per-good producer lists are built once and cached on the world (rebuilt only on
 *  an island-count change / after a load — never serialized). Lets soughtSupply weigh only real
 *  producers of a good instead of scanning all N islands per needed good. */
function producersOf(world, res) {
  let idx = world._producers;
  if (!idx || idx._n !== world.islands.length) {
    idx = new Map(); idx._n = world.islands.length;
    const goods = tradeables(world.economy);
    for (const p of world.islands) for (const g of goods) if (makesRes(p, g)) { const b = idx.get(g); if (b) b.push(p); else idx.set(g, [p]); }
    world._producers = idx;
  }
  return idx.get(res) || EMPTY;
}

/** Goods the home needs but whose cheapest KNOWN producer is DEAR (or that it knows no producer of
 *  at all) — the things it ought to shop around for. Returns { good: extraOverBase }, a positive
 *  value meaning a cheaper supplier is worth sending a ship to find. This is what lets a port react
 *  to a supplier quietly raising its prices: rather than stubbornly overpaying the one market it
 *  knows, it goes looking (scouts the UNKNOWN producers) for a better deal. Compared against KNOWN
 *  beliefs (not the optimistic base prior every unknown port carries), so it triggers precisely when
 *  the places the home has actually seen are expensive. */
export function soughtSupply(world, home) {
  const t = world.rules;
  const out = {};
  for (const res of tradeables(world.economy)) {
    if (t.SPECIAL_GOODS.includes(res)) continue;
    if (makesRes(home, res)) continue;                                          // it makes/mines this itself
    if ((home.stock[res] || 0) >= t.IMPORT_RATIO * home.targets[res]) continue; // not actually short
    const base = Math.max(1, t.PRICE_BASE[res] || 1);
    let bestKnown = Infinity, knownAny = false;
    for (const p of producersOf(world, res)) { // only real producers of `res`, not all N islands
      if (p === home) continue;
      const per = home.beliefs && home.beliefs[p.id];
      if (!per || !per[res]) continue;                                          // price here is unknown — a scout candidate, not a known quote
      knownAny = true;
      const ask = per[res].mid * (1 + t.SPREAD / 2);
      if (ask < bestKnown) bestKnown = ask;
    }
    // Only the "a supplier I KNOW has got expensive" case — that's the one normal routing can't
    // self-correct (it keeps paying the known price). Ports it knows NOTHING about already look cheap
    // at the base-price prior, so ordinary trade explores them on its own; no need to force a detour.
    if (knownAny && bestKnown / base >= t.SCOUT_PRICE_TRIGGER) out[res] = bestKnown / base - 1;
  }
  return out;
}

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

export function planVoyage(world, home, ship, ctx = null) {
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
  const day = currentDay(world); // all cross-island reads below are on BELIEVED prices/facts, not live truth

  let capLeft = cap;
  let goldLeft = home.gold * t.GOLD_SPEND_FRACTION;
  let profit = 0;
  let foodBought = false, shipBought = false, peopleLoaded = false, shopped = false, scouting = false, aidSent = false;

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

  // (1b) AID CONVOY — reputation with teeth, the bright side: a food-secure port answers an
  //      ALLY'S famine with a GIFT of food (solidarity, not commerce — the recipient pays nothing;
  //      it strongly warms the friendship). Friends keep each other alive. Bounded by the donor's
  //      own food-security floor + a cooldown, so a port never beggars itself being generous, and
  //      only fires when the home isn't itself scrambling for food.
  if (!foodBought && foodDays(home, t) >= t.AID_DONOR_FOOD_DAYS && world.simTime >= (home._aidCd || 0)) {
    // An island answers a famine it has actually HEARD of: it sends aid on BELIEVED food distress
    // (intel a ship carried home), not omniscient live truth. A friend it's had no word from is
    // assumed to be coping — so relief follows the shipping lanes that also carry the bad news.
    let ally = null, allyFd = Infinity;
    for (const p of world.islands) {
      if (p === home) continue;
      if ((home.rep ? home.rep[p.id] || 0 : 0) < t.REP_ALLY_AID_MIN) continue; // a true friend
      const fd = believedFoodDays(world, home, p.id, day);
      if (fd >= t.SURVIVAL_DAYS) continue;                                      // believed to be in real trouble
      if (fd < allyFd) { ally = p; allyFd = fd; }                              // the most desperate one it knows of
    }
    if (ally && roomForStop(ally.id)) {
      const sparable = Math.max(0, home.stock.Food - home.targets.Food * 0.6);
      const give = Math.min(t.AID_FOOD_BATCH, capLeft, sparable);
      if (give >= 1) {
        stopFor(ally.id).gift = { Food: give };
        capLeft -= give;
        home._aidCd = world.simTime + t.AID_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
        aidSent = true;
      }
    }
  }

  // (2) BUY SHIP — a wealthy port claims a shipyard stop BEFORE exports fill every slot.
  //     (A rich exporter is rich precisely because its voyages are full of sales, which
  //     would otherwise crowd the purchase out — the catch-22 that meant nobody ever bought.)
  if (home.wantsShip) {
    // Owned + in-flight-purchase counts. In a real dispatch pass `ctx` carries the O(S) census +
    // the running in-flight tally (fresh as voyages are assigned this pass); a bare 3-arg call
    // (unit tests) falls back to the exact live scans.
    const owned = ctx ? fleetAt(world, home.id).total : world.ships.filter((s) => s.homeId === home.id).length;
    const inflight = ctx ? (ctx.inflight.get(home.id) || 0)
      : world.ships.filter((s) => s.homeId === home.id && s.voyage && s.voyage.reason === 'buyShip').length;
    if (owned + inflight < t.MAX_SHIPS_PER_ISLAND && world.ships.length + inflight < t.MAX_SHIPS_TOTAL) {
      const yard = nearestWhere(world, home, (p) => (p.stock.Ships || 0) >= 1 && !believedHaven(world, home, p.id, day));
      if (yard && roomForStop(yard.id)) {
        const ask = bidAsk(beliefMid(world, home, yard.id, 'Ships', day), t.SPREAD).ask; // the price the home BELIEVES the yard charges
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
  //   PUSH (must leave): famine (food-short) or overcrowding (pop near carrying capacity). The home
  //     knows its OWN plight live.
  //   PULL (where to): the most attractive reachable port — but chosen on what the home has HEARD
  //     (information travels by sea): believed PROSPERITY (civ) + believed FOOD security, from the
  //     intel ships have carried back. People flock to a port they've heard is thriving; a place
  //     nobody speaks of holds only the neutral pull of the unknown. Physical ROOM stays a live
  //     check (a berth is a berth — like stock availability, deliberately common knowledge).
  //   A gentler TRICKLE also leaves a comfortable island when a MARKEDLY more prosperous
  //   neighbour beckons (opportunity/urbanisation) — but a healthy producer never bleeds
  //   its whole workforce to a hoarder, which would hollow out the islands that feed all.
  if (home.population > t.POP_FLOOR + t.MIGRATION_BATCH) {
    const foodShort = foodDays(home, t) < t.FOOD_SECURITY_DAYS;
    const crowded = home.population > 0.85 * home.k;
    let best = null, bestScore = -Infinity;
    for (const p of world.islands) {
      if (p === home) continue;
      if (p.population >= 0.92 * p.k) continue;                         // no room to take them (live capacity)
      if (believedFoodDays(world, home, p.id, day) < t.FOOD_SECURITY_DAYS) continue; // heard to be able to feed them
      if (believedHaven(world, home, p.id, day)) continue;             // nobody emigrates to a known pirate den
      const score = (believedCiv(world, home, p.id, day) - home.civ) * 3
        + (believedFoodDays(world, home, p.id, day) - foodDays(home, t)) * 0.04
        - dist(home, p) * 0.0003;                                      // travel is an opportunity cost
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
      const ask = bidAsk(beliefMid(world, home, p.id, deficit, day), t.SPREAD).ask; // sized on the BELIEVED price

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

  // Goods the home is short of and doesn't make itself — the ports that PRODUCE these are its
  // potential suppliers, worth getting to know. `sought` is the sharper signal: goods whose
  // cheapest KNOWN source has got expensive (see soughtSupply) — the home actively wants a better deal.
  const needs = new Set();
  for (const res of tradeables(world.economy)) {
    if (t.SPECIAL_GOODS.includes(res) || makesRes(home, res)) continue;
    if ((home.stock[res] || 0) < t.IMPORT_RATIO * home.targets[res]) needs.add(res);
  }
  const sought = soughtSupply(world, home);
  const shopping = Object.keys(sought).length > 0;

  // (7) SCOUT — no committed errand (no food need, nothing worth exporting): rather than shuffle a
  //     marginal surplus around, send the ship to RECONNOITRE — PURPOSEFULLY. Candidates are the
  //     ports whose prices the home knows least (unknown/stale, nearer preferred), but a stale port
  //     that PRODUCES something the home is short of is worth checking first (a potential supplier),
  //     and one that makes a good the home is actively OVERPAYING for (sought) is worth most of all —
  //     that's the "go find a cheaper source when a supplier gets dear" behaviour. This only ever
  //     redirects otherwise-idle ships, so it never perturbs committed, profitable trade.
  //     A WANDERER scouts sooner (lower staleness bar) and visits more ports; a HOMEBODY barely
  //     bothers. When actively shopping, the staleness bar drops (a motivated buyer re-checks sooner).
  const addScoutStops = () => {
    const day = currentDay(world);
    const staleBar = shopping ? Math.min(nav.scoutStale, t.SCOUT_SEEK_STALE) : nav.scoutStale;
    // Single pass over the islands (world.islands order preserved into the stable sort) — same
    // candidates, ages and scores as the old map/filter/map chain, without its intermediate arrays.
    const cand = [];
    for (const p of world.islands) {
      if (p === home) continue;
      const age = intelAge(home, p.id, day);
      if (age < staleBar) continue;
      let supply = 0; // potential supplier of something the home lacks — and more so if it's overpaying for it
      for (const g in sought) if (makesRes(p, g)) supply += (1 + sought[g]) * t.SCOUT_SUPPLY_WEIGHT;
      for (const g of needs) if (!sought[g] && makesRes(p, g)) supply += t.SCOUT_SUPPLY_WEIGHT * 0.35;
      cand.push({ p, age, score: age + supply - dist(home, p) * t.SCOUT_DIST_WEIGHT });
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand.slice(0, nav.scoutStops)) { if (roomForStop(c.p.id)) { stopFor(c.p.id); scouting = true; } }
  };
  if (stops.length === 0) addScoutStops();

  // Last resort: keep the ship busy on the best surplus at a lower bar (no scout target left).
  if (stops.length === 0) addExports(1.0);
  if (stops.length === 0) return null;

  const reason = aidSent ? 'aid' : shipBought ? 'buyShip' : peopleLoaded ? 'migrate'
    : foodBought ? 'food' : scouting ? 'scout' : 'trade';
  // Don't shuttle for pennies: a pure-trade voyage must clear the profit floor (unless it's also a
  // luxury-shopping run). A GREEDY captain sets a higher bar (skips thin trades); an easygoing one
  // will take almost any positive run. Scout/errand voyages are exempt. BUT rather than let a ship
  // idle on a rejected penny-trade, spend the trip reconnoitring potential suppliers of what the
  // home lacks (especially anything it's overpaying for) — otherwise-idle capacity improving the
  // port's market knowledge instead of sitting at the quay.
  if (reason === 'trade' && profit < t.MIN_TRADE_PROFIT * nav.profitMult && !shopped) {
    if (needs.size > 0) { stops.length = 0; scouting = false; addScoutStops(); if (stops.length) return { reason: 'scout', stops: orderByPath(home, stops, world), index: 0 }; }
    return null;
  }

  return { reason, stops: orderByPath(home, stops, world), index: 0 };
}

const sumVals = (o) => { let n = 0; for (const k in o) n += o[k]; return n; };

/** Order stops SELL-heavy first, BUY-heavy last (each a greedy nearest-neighbour walk), so
 *  a ship offloads its cargo and earns gold before it reaches a stop where it needs to buy
 *  (e.g. food) — which requires freed hold space and coin. */
function orderByPath(home, stops, world) {
  const netSeller = (s) => sumVals(s.sell) + sumVals(s.gift || {}) - sumVals(s.buy) - s.people >= 0;
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
