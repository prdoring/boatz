// Market / spatial query primitives. All partner search routes through here so a
// spatial index (world.spatialIndex) can replace the linear scan later with no
// dispatch edits. PURE.

import { bidAsk } from './pricing.js';
import { repPriceMult, isEmbargoed } from './reputation.js';
import { beliefMid, currentDay } from './beliefs.js';
import { believedDanger, believedHaven, believedFestival } from './intel.js';
import { nearestIsland } from './grid.js';
import { tradeables } from './resources.js';

const EMPTY = Object.freeze([]);

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/** Islands other than `island` (linear scan today; spatial index is a drop-in later). */
export function nearbyIslands(world, island) {
  const out = [];
  for (const o of world.islands) if (o !== island) out.push(o);
  return out;
}

/** Build the per-good trade-candidate index for a dispatch pass: which islands can SELL each good
 *  (live stock ≥ 1) and which can BUY it (has gold AND real demand — stock below the reserve
 *  ceiling). These are exactly the live-availability gates findBestPartner applies per candidate;
 *  pre-bucketing them once (O(N·G)) lets each findBestPartner iterate only real candidates instead
 *  of all N islands. Each bucket is an ordered subsequence of world.islands, so the argmax + tie-
 *  break stay bit-identical. Valid only for the pass (dispatch mutates no stock/gold); cleared at
 *  pass end so any out-of-dispatch caller falls back to the full scan. */
export function buildPartnerIndex(world) {
  const reserve = world.rules.RESERVE_RATIO;
  const goods = tradeables(world.economy);
  const sellers = new Map(), buyers = new Map();
  for (const p of world.islands) {
    const hasGold = (p.gold || 0) >= 1;
    for (let gi = 0; gi < goods.length; gi++) {
      const good = goods[gi], q = p.stock[good] || 0;
      if (q >= 1) { const b = sellers.get(good); if (b) b.push(p); else sellers.set(good, [p]); }
      if (hasGold && q < (p.targets[good] || 0) * reserve) { const b = buyers.get(good); if (b) b.push(p); else buyers.set(good, [p]); }
    }
  }
  world._sellers = sellers;
  world._buyers = buyers;
}

/** Drop the dispatch-pass candidate index (see buildPartnerIndex). */
export function clearPartnerIndex(world) { world._sellers = null; world._buyers = null; }

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
  // Per-good candidate index (built for the dispatch pass): only islands that can actually SELL /
  // BUY this good — an ordered subsequence of world.islands, so the per-candidate belief/embargo/
  // danger/contract filters and the argmax below stay bit-identical to scanning every island. Out
  // of a dispatch pass (unit tests) the index is absent → scan world.islands inline (same result,
  // and no per-call array allocation). Self-exclusion is handled by the `p === island` skip.
  const index = mode === 'import' ? world._sellers : world._buyers;
  const list = index ? (index.get(good) || EMPTY) : world.islands;
  let best = null, bestScore = -Infinity;
  for (const p of list) {
    if (p === island) continue;
    // A pirate haven is no honest trade partner — but the island only shuns one it has HEARD has
    // fallen (intel.js). A ship dispatched to a port that fell after word last reached home sails
    // in unawares and finds no market (executeStop) — stale news gets you into trouble.
    if (believedHaven(world, island, p.id, day)) continue;
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
    // Pirate-haunted waters are shunned — but again only on BELIEVED danger (a sighting a ship
    // carried home), which decays as it ages. An island can't fear a raided lane it hasn't heard
    // about, so news of piracy (and of its clearing) travels by sea like everything else.
    const peril = believedDanger(world, island, p.id, day) * t.DANGER_ROUTE_WEIGHT;
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
      // A port with an open CONTRACT for this good is a draw — its reward makes the run worth more.
      const contractPull = (p.contract && p.contract.good === good && p.contract.reward > 0) ? t.CONTRACT_ROUTE_BONUS : 0;
      // A port holding a FESTIVAL we've HEARD of is a draw for luxuries/ale — feast-goers pay well, and
      // the rumour reached us by sea (believedFestival), so only ships with word of it divert.
      const festivalPull = ((good === 'LuxuryGoods' || good === 'Ale') && believedFestival(world, island, p.id, day)) ? (t.FESTIVAL_ROUTE_BONUS || 0) : 0;
      const score = margin - travel - peril + contractPull + festivalPull;
      if (score > bestScore) { bestScore = score; best = { partner: p, unitPrice: bid, dist: d, margin }; }
    }
  }
  return best;
}

/** Nearest island satisfying a predicate (e.g. a shipyard with Ships stock). Backed by the static
 *  island grid — an expanding-ring nearest that excludes `island` itself and keeps the same
 *  earliest-in-world.islands-order tie-break the old linear first-min (`d < bestD`) had. */
export function nearestWhere(world, island, pred) {
  return nearestIsland(world, island.x, island.y, (p) => p !== island && pred(p));
}
