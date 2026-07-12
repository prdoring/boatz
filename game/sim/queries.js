// Market / spatial query primitives. All partner search routes through here so a
// spatial index (world.spatialIndex) can replace the linear scan later with no
// dispatch edits. PURE.

import { bidAsk } from './pricing.js';
import { repPriceMult, isEmbargoed } from './reputation.js';
import { beliefMid, currentDay } from './beliefs.js';

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Islands other than `island` (linear scan today; spatial index is a drop-in later). */
export function nearbyIslands(world, island) {
  const out = [];
  for (const o of world.islands) if (o !== island) out.push(o);
  return out;
}

/**
 * Best trade partner for `good`.
 *  mode 'import' — island wants to BUY good: find a seller (has stock) minimizing
 *                  delivered ask + travel opportunity cost.
 *  mode 'export' — island wants to SELL good: find a buyer (has gold) maximizing
 *                  (partner bid - my ask - travel).
 * Returns { partner, unitPrice, dist, margin } or null. Travel cost is decision-only.
 */
export function findBestPartner(world, island, good, mode, travelMult = 1) {
  const t = world.rules;
  const spread = t.SPREAD;
  const swing = t.REP_PRICE_SWING || 0;
  const day = currentDay(world);
  let best = null, bestScore = -Infinity;
  for (const p of nearbyIslands(world, island)) {
    // An embargo (either side's deep hostility) shuts the port — it's simply not an option.
    if (isEmbargoed(p, island.id, t) || isEmbargoed(island, p.id, t)) continue;
    const d = dist(island, p);
    // Travel is a decision-only opportunity cost; a bold/adventurous captain discounts it
    // (travelMult < 1) and so ranges farther for a trade, a cautious one stays close to home.
    const travel = d * t.DISTANCE_GOLD_PER_UNIT * travelMult;
    // The partner's price is a BELIEF, not live truth — the island decides who to trade with
    // on the prices it has HEARD (stale rumor away from its routes). Availability (stock/gold/
    // demand) stays common knowledge, so ships still route to real producers with real surplus.
    const partnerMid = beliefMid(world, island, p.id, good, day);
    // Pirate-haunted waters are shunned: a feared port is a worse trade partner (this is what lets
    // piracy strangle a route — and motivates the port to pay for privateers to clear it).
    const peril = (p.danger || 0) * t.DANGER_ROUTE_WEIGHT;
    if (mode === 'import') {
      if ((p.stock[good] || 0) < 1) continue;
      // The ask WE'D actually pay reflects how `p` feels about us (friends discount).
      const ask = bidAsk(partnerMid, spread).ask * repPriceMult(p, island.id, swing, true);
      const score = -ask - travel - peril;
      if (score > bestScore) { bestScore = score; best = { partner: p, unitPrice: ask, dist: d, margin: 0 }; }
    } else {
      if ((p.gold || 0) < 1) continue;
      // Only sell to a partner with real demand (below its reserve ceiling), so
      // surplus flows to consumers/reserves instead of clogging a gold-rich island.
      if ((p.stock[good] || 0) >= p.targets[good] * t.RESERVE_RATIO) continue;
      // The bid WE'D actually receive reflects how `p` feels about us (friends pay more).
      const bid = bidAsk(partnerMid, spread).bid * repPriceMult(p, island.id, swing, false);
      const myAsk = bidAsk(island.price[good].mid, spread).ask; // an island knows its OWN price
      const margin = bid - myAsk;
      const score = margin - travel - peril;
      if (score > bestScore) { bestScore = score; best = { partner: p, unitPrice: bid, dist: d, margin }; }
    }
  }
  return best;
}

/** Nearest island satisfying a predicate (e.g. a shipyard with Ships stock). */
export function nearestWhere(world, island, pred) {
  let best = null, bestD = Infinity;
  for (const p of nearbyIslands(world, island)) {
    if (!pred(p)) continue;
    const d = dist(island, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
