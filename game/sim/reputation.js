// Inter-island reputation. Every island holds a pairwise opinion of every other,
// `island.rep[otherId]` in [-1, 1] (0 = neutral), seeded just above/below neutral. It is
// the diplomatic layer under trade:
//   • Trading with a port builds MUTUAL rapport (both like each other a little more).
//   • Every third party then nudges its opinion of you TOWARD how it feels about that
//     port — so a partner's friends become your friends and a partner's enemies become
//     your enemies. One symmetric rule ⇒ emergent trade blocs (this generalises the
//     "you lose reputation for trading with islands others dislike" rule the user asked
//     for, and adds the positive mirror image).
//   • Reputation shifts the price a host quotes YOU (friends get a discount / a better
//     bid; rivals get gouged) and biases who ships choose to trade with (queries.js).
//   • Grudges fade: a gentle daily decay pulls every opinion back toward neutral.
// PURE. Serialisable (plain numbers on the island). Future: proximity affinity, embargoes
// below a hostility threshold, alliances/wars.

import { streamFloat } from './rng.js';
import { logEventThrottled } from './events.js';

const clampRep = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/** Seed each ordered pair just above/below neutral (deterministic per world seed). */
export function initReputation(world, spread) {
  for (const a of world.islands) {
    a.rep = {};
    for (const b of world.islands) {
      if (a === b) continue;
      a.rep[b.id] = (streamFloat(world, 'rep') - 0.5) * 2 * spread;
    }
  }
  world._repDay = -1;
}

/** Record a completed trade between a visiting ship's home `homeId` and the `host` port. */
export function recordTrade(world, host, homeId, volume) {
  if (homeId === host.id) return;
  const t = world.rules;
  const home = world.islandsById.get(homeId);
  if (!home || !host.rep || !home.rep) return;
  const g = t.REP_TRADE_GAIN * Math.min(1, volume / t.REP_VOLUME_NORM);
  if (g <= 0) return;

  // Direct rapport (mutual).
  host.rep[homeId] = clampRep((host.rep[homeId] || 0) + g);
  home.rep[host.id] = clampRep((home.rep[host.id] || 0) + g);

  // Association: each third party shifts its opinion of the home toward its opinion of
  // the host it just dealt with (friend-of-my-friend / enemy-of-my-partner → blocs).
  const assoc = t.REP_ASSOC * g;
  for (const c of world.islands) {
    if (c === host || c.id === homeId || !c.rep) continue;
    const cHost = c.rep[host.id] || 0;
    if (cHost > -1e-3 && cHost < 1e-3) continue;
    c.rep[homeId] = clampRep((c.rep[homeId] || 0) + assoc * cHost);
  }
}

/**
 * Price multiplier a `host` quotes to trader `homeId` for one deal.
 *   isBuy=true  → host SELLS to the ship (ask): friends get a discount (<1), rivals pay more.
 *   isBuy=false → host BUYS from the ship (bid): friends get paid more (>1), rivals get less.
 */
export function repPriceMult(host, homeId, swing, isBuy) {
  const r = host && host.rep ? (host.rep[homeId] || 0) : 0;
  return isBuy ? (1 - swing * r) : (1 + swing * r);
}

/** SIM system (once per sim-day): grudges fade toward neutral, and producers of the SAME
 *  primary resource drift apart — they compete for the same customers, so without active
 *  trade between them their relationship sours. This is the source of NEGATIVE reputation
 *  (trade only ever adds positive rapport), so allies AND rivals both emerge. */
export function reputation(world) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  if (day === world._repDay) return;
  world._repDay = day;
  const keep = 1 - t.REP_DECAY_PER_DAY;
  const comp = t.REP_COMPETITION_PER_DAY || 0;
  for (const a of world.islands) {
    if (!a.rep) continue;
    for (const b of world.islands) {
      if (a === b) continue;
      let v = (a.rep[b.id] || 0) * keep;
      if (comp && a.primary === b.primary) v -= comp; // rival producers of the same good
      a.rep[b.id] = clampRep(v);
    }
  }

  // News: a pair's MUTUAL regard crossing into alliance / rivalry territory is a diplomatic
  // headline. HYSTERESIS (enter at ±threshold, fall back to neutral only below ±exit) stops a
  // pair hovering at the boundary from spamming the ticker. Deduped per unordered pair; only
  // the ENTER transitions are logged.
  if (!world._blocState) world._blocState = {};
  const A = t.REP_ALLY_THRESHOLD, R = t.REP_RIVAL_THRESHOLD, X = t.REP_BLOC_EXIT;
  const isl = world.islands;
  for (let i = 0; i < isl.length; i++) {
    const a = isl[i];
    if (!a.rep) continue;
    for (let j = i + 1; j < isl.length; j++) {
      const b = isl[j];
      if (!b.rep) continue;
      const m = ((a.rep[b.id] || 0) + (b.rep[a.id] || 0)) / 2;
      const key = a.id + '|' + b.id;
      const prev = world._blocState[key] || 'neutral';
      let state = prev;
      if (prev === 'ally') { if (m < X) state = m <= -R ? 'rival' : 'neutral'; }
      else if (prev === 'rival') { if (m > -X) state = m >= A ? 'ally' : 'neutral'; }
      else { if (m >= A) state = 'ally'; else if (m <= -R) state = 'rival'; }
      if (state === prev) continue;
      world._blocState[key] = state;
      if (state === 'ally') logEventThrottled(world, 'ally', 1.5 * t.SIM_DAY_SECONDS, `${a.name} & ${b.name} forge an alliance`, { islandId: a.id });
      else if (state === 'rival') logEventThrottled(world, 'rival', 2 * t.SIM_DAY_SECONDS, `${a.name} & ${b.name} fall into rivalry`, { islandId: a.id });
    }
  }
}
