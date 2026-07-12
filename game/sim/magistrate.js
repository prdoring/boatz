// Island governance — the land-side mirror of the captain/crew system. Every island is run by
// a named MAGISTRATE (a portrait, experience, and a governing personality) and has a LOYALTY
// level. Loyalty eases toward a steady state set by the island's PROSPERITY (civ) and the
// magistrate's competence; it's dragged down by hardship (famine, plague, blight, overcrowding)
// and lifted by "circuses" (comfort goods on hand — the island analog of the crew's grog). If
// loyalty stays in the gutter too long the island ERUPTS: it goes aflame for ~a day with ALL
// production and income halted, then a dice roll weighted by the magistrate's EXPERIENCE and
// FIRMNESS decides whether he crushes the revolt or is OVERTHROWN (a fresh novice takes over,
// and the turmoil scars the island's civ and treasury). Either way loyalty resets — but the
// hardship that caused it doesn't, so it must actually be fixed. Experience shapes it all:
// steady loyalty, how long the streets stay calm, and the odds of holding power. PURE.
//
// Traits (each 0..1): firmness — rule by fear (delays revolt, but breeds resentment);
//                     generosity — largesse (a happier populace);
//                     integrity — the opposite of graft (corruption drags loyalty down).

import { streamFloat } from './rng.js';
import { foodDays } from './island.js';
import { logEvent } from './events.js';
import { clamp } from './resources.js';

const SUR = [
  'Ashcombe', 'Pennywise', 'Harrow', 'Thistlewood', 'Grimsby', 'Whitlock', 'Crowe', 'Fairweather',
  'Blackstock', 'Hargrave', 'Stoneleigh', 'Verity', 'Underhill', 'Loxley', 'Pembroke', 'Rookwood',
  'Cordwainer', 'Dabney', 'Fenwick', 'Marchbanks', 'Ravenscroft', 'Sable', 'Thorncastle', 'Wexford',
];
const TITLE = ['Magistrate', 'Governor', 'Warden', 'Steward', 'Prefect'];

// Rank tiers by lifetime XP (low → high). The last whose threshold is met wins.
const RANKS = [
  [0, 'Steward'], [100, 'Reeve'], [280, 'Magistrate'], [600, 'Governor'], [1200, 'Consul'], [2400, 'Lord-Governor'],
];

function pick(list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; }
function trait(world) { return (streamFloat(world, 'mag') + streamFloat(world, 'mag')) / 2; } // triangular → moderates common

/** One-word governing style from the most pronounced trait (else "Even-handed"). */
export function magPersonality(traits) {
  const items = [['firmness', traits.firmness], ['generosity', traits.generosity], ['integrity', traits.integrity]];
  let key = null, dev = 0.14, sign = 0;
  for (const [k, v] of items) { const d = Math.abs(v - 0.5); if (d > dev) { dev = d; key = k; sign = v >= 0.5 ? 1 : -1; } }
  if (!key) return 'Even-handed';
  return { firmness: sign > 0 ? 'Iron-fisted' : 'Lenient', generosity: sign > 0 ? 'Generous' : 'Miserly', integrity: sign > 0 ? 'Just' : 'Corrupt' }[key];
}

/** A fresh magistrate: seeded name/title, portrait, traits, and zero experience. */
export function makeMagistrate(world) {
  const name = `${pick(TITLE, streamFloat(world, 'mag'))} ${pick(SUR, streamFloat(world, 'mag'))}`;
  const traits = { firmness: trait(world), generosity: trait(world), integrity: trait(world) };
  const portrait = Math.floor(streamFloat(world, 'mag') * 0x7fffffff) >>> 0;
  return { name, xp: 0, traits, personality: magPersonality(traits), portrait };
}

export function magSkill(mag, rules) { return mag ? 1 - Math.exp(-(mag.xp || 0) / rules.MAG_XP_SCALE) : 0; }

export function magRank(mag) {
  const xp = (mag && mag.xp) || 0;
  let label = RANKS[0][1];
  for (const [min, name] of RANKS) if (xp >= min) label = name;
  return label;
}

/** The loyalty an island trends toward, given its prosperity + who governs it. */
function steadyLoyalty(isl, rules) {
  const m = isl.magistrate, tr = m.traits;
  const s = rules.LOYALTY_STEADY_BASE
    + isl.civ * rules.LOYALTY_CIV_WEIGHT
    + magSkill(m, rules) * rules.LOYALTY_SKILL_WEIGHT
    + tr.generosity * rules.LOYALTY_GEN_WEIGHT
    - tr.firmness * rules.LOYALTY_FIRM_RESENT;
  return clamp(s, 0.05, 0.95);
}

/** SIM system: move every island's loyalty, run rebellions, and age magistrates. */
export function governance(world, h) {
  const t = world.rules;
  const dDay = h / t.SIM_DAY_SECONDS;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  const daily = day !== world._govDay;
  if (daily) world._govDay = day;

  for (const isl of world.islands) {
    const mag = isl.magistrate;
    if (!mag) continue;

    // Aflame: production/income are halted elsewhere; here the turmoil erodes civ until it burns out.
    if (isl.rebellion) {
      isl.civ = Math.max(0, isl.civ - t.REBEL_CIV_DRAIN * dDay);
      isl.loyalty = Math.min(isl.loyalty, 0.2);
      if (world.simTime >= isl.rebellion.until) resolveRebellion(world, isl);
      continue;
    }

    // LOYALTY drift toward the steady state, plus hardship drags and comfort boosts.
    const skill = magSkill(mag, t), tr = mag.traits;
    let dm = t.LOYALTY_RECOVER * (steadyLoyalty(isl, t) - isl.loyalty);
    if (foodDays(isl, t) < t.FAMINE_FOOD_DAYS) dm -= t.LOYALTY_FAMINE;
    if (isl.plague) dm -= t.LOYALTY_PLAGUE;
    if (isl.blight) dm -= t.LOYALTY_BLIGHT;
    if (isl.population > 0.9 * isl.k) dm -= t.LOYALTY_CROWD;
    if ((isl.stock.Ale || 0) + (isl.stock.LuxuryGoods || 0) > t.CIRCUS_MIN_STOCK) dm += t.LOYALTY_CIRCUS; // bread & circuses
    if (tr.integrity < 0.5) dm -= (0.5 - tr.integrity) * t.LOYALTY_GRAFT;                                 // corruption
    isl.loyalty = clamp((isl.loyalty != null ? isl.loyalty : t.LOYALTY_STEADY_BASE) + dm * dDay, 0, 1);

    // UNREST → REBELLION. Firmness (fear) and a seasoned hand hold the streets longer.
    if (isl.loyalty < t.REBEL_LOYALTY) isl.unrest = (isl.unrest || 0) + dDay;
    else isl.unrest = Math.max(0, (isl.unrest || 0) - dDay * 1.5);
    const grace = t.REBEL_GRACE_DAYS + skill * t.REBEL_GRACE_SKILL + tr.firmness * t.REBEL_GRACE_FIRM;
    if (isl.unrest >= grace && world.simTime >= (isl._rebelCd || 0)) {
      isl.rebellion = { until: world.simTime + t.REBELLION_DAYS * t.SIM_DAY_SECONDS };
      logEvent(world, 'rebellion', `Rebellion erupts on ${isl.name} — the streets are aflame`, { islandId: isl.id });
    }

    if (daily) mag.xp = (mag.xp || 0) + t.MAG_XP_PER_DAY; // experience for a day of order kept
  }
}

/** The fire burns out: the magistrate crushes the revolt, or the island casts him out. */
function resolveRebellion(world, isl) {
  const t = world.rules;
  const mag = isl.magistrate;
  const pQuell = Math.min(0.9, t.QUELL_BASE_MAG + magSkill(mag, t) * t.QUELL_SKILL_MAG + mag.traits.firmness * t.QUELL_FIRM_MAG);
  if (streamFloat(world, 'rebel') < pQuell) {
    logEvent(world, 'quellReb', `${mag.name} crushed the rebellion on ${isl.name}`, { islandId: isl.id });
  } else {
    logEvent(world, 'overthrow', `${isl.name} overthrew ${mag.name}`, { islandId: isl.id });
    isl.magistrate = makeMagistrate(world);          // a fresh regime takes over
    isl.civ *= (1 - t.OVERTHROW_CIV_HIT);            // the old order's works scattered
    isl.gold = Math.floor(isl.gold * (1 - t.OVERTHROW_GOLD_HIT)); // treasury looted
  }
  isl.loyalty = Math.max(isl.loyalty, 0.5); // order (of a sort) restored
  isl.unrest = 0;
  isl.rebellion = null;
  isl._rebelCd = world.simTime + t.REBEL_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
}

/** Whether the island's economy is frozen by revolt (read by production/upkeep). */
export function inRebellion(island) { return !!(island && island.rebellion); }
