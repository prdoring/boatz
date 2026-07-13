// Imperfect price knowledge — the information layer. An island does NOT see other
// islands' live prices; it holds BELIEFS: the last-heard mid for each good at each other
// island, tagged with the sim-day it was heard. Beliefs are refreshed only when a ship
// carries fresh observations — a ship OBSERVES a port's live prices firsthand when it
// docks, and GOSSIPS (merges price books) with every port it visits and with its home on
// return. So price information spreads epidemically along trade routes and lags reality on
// remote/seldom-visited islands. Trade DECISIONS run on beliefs (see queries.js), which is
// what makes information friction — stale prices, rumor, reconnaissance — shape who trades
// with whom. Availability/production stays common knowledge (you know who mines iron); only
// PRICE is imperfectly known, which keeps routing to real producers and the economy stable.
//
// A "price book" is { [islandId]: { [good]: { mid, day } } }. Islands keep one on
// `island.beliefs`; ships keep one on `ship.knows`. Both round-trip through serialize.js
// for free (they live on the island/ship objects). PURE.

export function currentDay(world) {
  return Math.floor(world.simTime / world.rules.SIM_DAY_SECONDS);
}

/** Believed mid price for `good` at island `otherId`, as seen from `island`, on `day`.
 *  Unknown → the base-price prior. A known belief decays toward that prior as it ages
 *  (growing uncertainty), fully reverting after BELIEF_STALE_DAYS — so old rumor gently
 *  becomes "I only know the going rate," never a confidently-wrong stale number. */
export function beliefMid(world, island, otherId, good, day) {
  const base = world.rules.PRICE_BASE[good];
  const per = island.beliefs && island.beliefs[otherId];
  const b = per && per[good];
  if (!b) return base;
  const stale = world.rules.BELIEF_STALE_DAYS || 30;
  const w = Math.min(1, Math.max(0, (day - b.day) / stale)); // 0 fresh … 1 forgotten
  return b.mid * (1 - w) + base * w;
}

/** Age (in days) of the freshest thing `island` knows about `otherId`'s prices; a large
 *  number if it knows nothing. Drives scout target selection (visit the least-known ports). */
export function intelAge(island, otherId, day) {
  const per = island.beliefs && island.beliefs[otherId];
  if (!per) return 1e6;
  let newest = -1e9;
  for (const g in per) if (per[g].day > newest) newest = per[g].day;
  return newest <= -1e9 ? 1e6 : day - newest;
}

/** Write an observation into a price book, newest-wins. */
function record(book, islandId, good, mid, day) {
  let per = book[islandId];
  if (!per) per = book[islandId] = {};
  const cur = per[good];
  if (!cur || day >= cur.day) per[good] = { mid, day };
}

/** The sim-day of the freshest good in a subject's price sub-book. */
function freshestDay(per) {
  let d = -1e9;
  for (const g in per) if (per[g].day > d) d = per[g].day;
  return d;
}

/** Drop price beliefs past the forget horizon, and — the SCALING guard — if a book still holds more
 *  than BELIEF_MAX_SUBJECTS ports, keep only the freshest. Mirrors intel.js.prune (the fact book was
 *  already bounded this way). DYNAMICS-SAFE for the forget pass: a belief older than BELIEF_STALE_DAYS
 *  has already fully reverted to the base-price prior in beliefMid, so a fully-stale entry is
 *  behaviourally identical to "never heard of it" — dropping it changes no trade decision. The cap is
 *  the hard memory bound that lets an island reach ~1000 neighbours without remembering every market;
 *  it never bites below BELIEF_MAX_SUBJECTS ports (so small worlds are untouched). */
function prune(world, book, day) {
  const t = world.rules;
  const forget = t.BELIEF_FORGET_DAYS || 30;
  const cap = t.BELIEF_MAX_SUBJECTS || 64;
  let ids = Object.keys(book);
  for (const id of ids) if (day - freshestDay(book[id]) > forget) delete book[id];
  ids = Object.keys(book);
  if (ids.length > cap) {
    ids.sort((a, b) => freshestDay(book[b]) - freshestDay(book[a])); // freshest first
    for (const id of ids.slice(cap)) delete book[id];
  }
}

/** A ship docks at `port`: it OBSERVES the port's live prices firsthand, then hands the port
 *  its logbook — what it has seen on its OWN travels. The port thereby learns the prices at
 *  the islands THIS ship has actually visited (with the ages it saw them).
 *
 *  Deliberately FIRSTHAND, not full transitive gossip: an early build let the ship also slurp
 *  everything the port had ever heard and re-spread it, which saturated the whole 60-island
 *  map with fresh prices within ~10 days — information friction vanished and scouts never had
 *  anything stale to visit. Carrying only firsthand sightings keeps knowledge geographic: an
 *  island knows its trade neighbourhood well and the far side of the sea hazily, which is what
 *  gives reconnaissance (goals.js scout) and route disruption their bite. */
export function observeAndGossip(world, port, ship) {
  const day = currentDay(world);
  if (!ship.knows) ship.knows = {};
  if (!port.beliefs) port.beliefs = {};

  // 1) OBSERVE — the ship sees the port's own live prices with its own eyes (today).
  for (const good in port.price) record(ship.knows, port.id, good, port.price[good].mid, day);

  // 2) REPORT — the port adopts the ship's firsthand sightings of everywhere it has been
  //    (it already knows its own prices live, so skip itself). Newer sighting wins.
  for (const islId in ship.knows) {
    if (islId === port.id) continue;
    const per = ship.knows[islId];
    for (const good in per) record(port.beliefs, islId, good, per[good].mid, per[good].day);
  }
  prune(world, port.beliefs, day); // bound the port's price book (forget horizon + subject cap)
}

/** Compact per-island intel summary for the UI: how many other markets this island has any
 *  read on, and how many of those are fresh (younger than BELIEF_STALE_DAYS/2). */
export function intelSummary(world, island, day) {
  const stale = world.rules.BELIEF_STALE_DAYS || 30;
  let known = 0, fresh = 0;
  const b = island.beliefs || {};
  for (const id in b) {
    known++;
    if (intelAge(island, id, day) < stale / 2) fresh++;
  }
  return { known, fresh };
}
