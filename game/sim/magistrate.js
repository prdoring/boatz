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
import { foodDays, slotCap } from './island.js';
import { logEvent, logEventThrottled } from './events.js';
import { voiceSeedFrom, regimeData } from './captains.js';
import { GIVEN, SURNAME, composeUniqueName } from './names.js';
import { clamp, safeDiv, tradeables, targetFor } from './resources.js';

// Magistrates read as "Title Given Surname" ("Governor Isabel Hargrave") — the given + family names
// come from the shared person-name pools (names.js), the title from this official set. A big sea of
// distinct rulers, deduped against sitting magistrates (see makeMagistrate).
const TITLE = ['Magistrate', 'Governor', 'Warden', 'Steward', 'Prefect', 'Bailiff', 'Castellan', 'Provost', 'Chancellor', 'Intendant', 'Seneschal', 'Alderman'];

// Rank tiers by lifetime XP (low → high). The last whose threshold is met wins.
const RANKS = [
  [0, 'Steward'], [100, 'Reeve'], [280, 'Magistrate'], [600, 'Governor'], [1200, 'Consul'], [2400, 'Lord-Governor'],
];

function pick(list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; }
function trait(world) { return (streamFloat(world, 'mag') + streamFloat(world, 'mag')) / 2; } // triangular → moderates common
/** Pick one phrasing from a pool for a chronicle beat — from a DEDICATED cosmetic 'narrate' stream, so it
 *  never perturbs the 'mag'/'rebel' streams that generate rulers (keeps the golden seed reproducible). */
function pickText(world, arr) { return arr[Math.min(arr.length - 1, Math.floor(streamFloat(world, 'narrate') * arr.length))]; }

/** Names of the magistrates currently in office — the set a fresh magistrate prefers to dodge. */
function livingMagistrateNames(world) {
  const set = new Set();
  const islands = world && world.islands;
  if (islands) for (const i of islands) if (i.magistrate && i.magistrate.name) set.add(i.magistrate.name);
  return set;
}

/** One-word governing style from the most pronounced trait (else "Even-handed"). */
export function magPersonality(traits) {
  const items = [['firmness', traits.firmness], ['generosity', traits.generosity], ['integrity', traits.integrity]];
  let key = null, dev = 0.14, sign = 0;
  for (const [k, v] of items) { const d = Math.abs(v - 0.5); if (d > dev) { dev = d; key = k; sign = v >= 0.5 ? 1 : -1; } }
  if (!key) return 'Even-handed';
  return { firmness: sign > 0 ? 'Iron-fisted' : 'Lenient', generosity: sign > 0 ? 'Generous' : 'Miserly', integrity: sign > 0 ? 'Just' : 'Corrupt' }[key];
}

// ─── Ambitions ──────────────────────────────────────────────────────────────
// A magistrate governs toward an ECONOMIC AGENDA, not just survival. The ambition
// reshapes what the island considers "enough" of each good (retarget, below), which
// naturally drives its imports/exports beyond subsistence, and carries a success
// signal that lifts loyalty when it prospers or erodes it when the mayor chases glory
// while the port suffers — feeding the existing loyalty→rebellion→overthrow cycle. A
// new regime rolls a fresh agenda, so an island's economic character shifts over time.
const AMBITION_META = {
  grow:     { label: 'Growth',   verb: 'grow' },       // people & plenty: import food + comforts, swell the population
  industry: { label: 'Industry', verb: 'industrialize' }, // import raw inputs, become a manufacturing exporter
  wealth:   { label: 'Wealth',   verb: 'enrich' },     // hoard coin: import little, sell hard (risks neglecting civ)
  fortify:  { label: 'Defense',  verb: 'fortify' },    // stockpile guns & iron against pirates and rivals
  splendor: { label: 'Splendor', verb: 'beautify' },   // import luxuries & grog to raise civilization
  order:    { label: 'Order',    verb: 'pacify' },      // a law-and-order drive: drive down lawlessness
};

export function ambitionLabel(mag) {
  const a = mag && mag.ambition;
  return a && AMBITION_META[a.kind] ? AMBITION_META[a.kind].label : '';
}

/** Pick an agenda suited to the island's nature (seeded, weighted). */
function chooseAmbition(world, island) {
  const kinds = world.rules.AMBITIONS || ['grow'];
  const w = {};
  for (const k of kinds) w[k] = 1;
  if (island) {
    const has = new Set([island.primary, island.secondary]);
    if (island.type === 'shipyard' || (has.has('Iron') && has.has('Wood'))) { w.fortify = (w.fortify || 0) + 2; w.industry = (w.industry || 0) + 2; }
    if (has.has('PreciousMetal')) { w.splendor = (w.splendor || 0) + 2; w.wealth = (w.wealth || 0) + 2; }
    if ((island.produces || []).length >= 2) w.industry = (w.industry || 0) + 1;
    if ((island.k || 0) >= 180) w.grow = (w.grow || 0) + 2; // a big island wants to fill its capacity
    if ((island.lawlessness || 0) > 0.4) w.order = (w.order || 0) + 3; // a troubled port cries out for order
  }
  const total = kinds.reduce((a, k) => a + (w[k] || 0), 0);
  let r = streamFloat(world, 'mag') * total;
  for (const k of kinds) { r -= (w[k] || 0); if (r <= 0) return k; }
  return kinds[0];
}

/** A fresh magistrate: seeded name/title, portrait, traits, experience, and an economic agenda. The
 *  name prefers one no sitting magistrate already bears; `taken` (optional) is a caller-owned set to
 *  avoid + extend for batch naming at genesis, else it's derived from the magistrates in office. */
export function makeMagistrate(world, island = null, taken) {
  const avoid = taken || livingMagistrateNames(world);
  const name = composeUniqueName(
    () => `${pick(TITLE, streamFloat(world, 'mag'))} ${pick(GIVEN, streamFloat(world, 'mag'))} ${pick(SURNAME, streamFloat(world, 'mag'))}`,
    avoid,
  );
  const traits = { firmness: trait(world), generosity: trait(world), integrity: trait(world) };
  const portrait = Math.floor(streamFloat(world, 'mag') * 0x7fffffff) >>> 0;
  const ambition = { kind: chooseAmbition(world, island), progress: 0.35, milestone: false };
  return { name, xp: 0, traits, personality: magPersonality(traits), portrait, voiceSeed: voiceSeedFrom(portrait), ambition, hoard: 0 };
}

/** The raw resources that feed the goods this island manufactures (industry's import focus). */
function inputRawsFor(island, economy) {
  const raws = new Set();
  const byOut = economy._recipeByOut || {};
  for (const out of island.produces || []) {
    const recipe = byOut[out] || economy.recipes.find((r) => r.out === out);
    if (!recipe) continue;
    for (const inp of recipe.inputs) {
      if (inp.all) raws.add(inp.all);
      else if (inp.anyOf) for (const r of inp.anyOf) raws.add(r);
    }
  }
  return raws;
}

/** Reshape the island's stock targets to reflect its magistrate's ambition. Called whenever a
 *  magistrate takes office (install / overthrow). Food is never biased below its base — no agenda
 *  is allowed to starve the island. Every other target scales, driving the port's trade demand. */
export function retarget(island, economy, tuning) {
  const amb = island.magistrate && island.magistrate.ambition;
  const bias = (amb && tuning.AMBITION_BIAS && tuning.AMBITION_BIAS[amb.kind]) || {};
  const inputs = amb && amb.kind === 'industry' ? inputRawsFor(island, economy) : null;
  for (const res of tradeables(economy)) {
    let mult = bias[res] != null ? bias[res] : 1;
    if (inputs && inputs.has(res)) mult = tuning.AMBITION_INDUSTRY_INPUT_MULT;
    let target = targetFor(tuning, res) * mult;
    if (res === 'Food') target = Math.max(target, targetFor(tuning, res)); // survival floor
    island.targets[res] = target;
  }
}

/** Seat a fresh magistrate on an island and re-target its economy to the new agenda. `taken`
 *  (optional) threads a shared avoid-set through world genesis so the whole first cast dedupes. */
export function installMagistrate(world, island, taken) {
  island.magistrate = makeMagistrate(world, island, taken);
  island.magistrate._installedDay = Math.floor(world.simTime / world.rules.SIM_DAY_SECONDS); // for the first-year beat
  retarget(island, world.economy, world.rules);
  return island.magistrate;
}

/** How well the sitting agenda is going, in ~[-1, +1] (drives progress + the loyalty coupling). */
function ambitionSignal(world, isl) {
  const t = world.rules;
  const kind = isl.magistrate.ambition.kind;
  const ratio = (good) => safeDiv(isl.stock[good] || 0, Math.max(1, isl.targets[good] || 1), 0);
  switch (kind) {
    case 'grow':     return clamp(isl.population / Math.max(1, isl.k) - 0.5, -0.5, 0.5) * 2;
    case 'industry': {
      // Industry now succeeds by RAISING WORKS, not by hoarding output. Score the count + condition of
      // the island's INDUSTRIAL workshops against its slot capacity (a port that builds more/healthier
      // workshops — a shipyard's Ships INCLUDED — is progressing). Fixes #13: the old stock-ratio
      // average pinned a pure shipyard at -1 forever (it makes only the SPECIAL good Ships → n=0).
      const industrial = t.INDUSTRIAL_GOODS || [];
      const cap = slotCap(isl, t);
      let health = 0;
      for (const wsp of isl.workshops || []) if (industrial.includes(wsp.good)) health += (wsp.condition != null ? wsp.condition : 1);
      return clamp(safeDiv(health, cap, 0) * 2 - 1, -1, 1); // all slots full + in good repair → +1
    }
    case 'wealth': {
      // Treasury-RELATIVE, not an absolute 2000g against a hoard cap that may be far lower for a small
      // port (#29): score gold as a fraction of THIS port's own cap, so "getting rich" is reachable at
      // any size. Half-cap → neutral, at-cap → +1.
      const cap = (t.GOLD_MAX_PER_POP || 40) * isl.population;
      return clamp(safeDiv(isl.gold, cap, 0) * 2 - 1, -1, 1);
    }
    case 'fortify':  return clamp(ratio('Weapons') - 0.6, -1, 1);
    case 'splendor': return clamp(isl.civ - 0.5, -0.5, 0.5) * 2;
    case 'order':    return clamp(0.5 - (isl.lawlessness || 0), -0.5, 0.5) * 2;
    default:         return 0;
  }
}

/** The lawlessness an island trends toward: hardship raises it, capable/honest/firm rule holds it.
 *  A populace nursing GRIEVANCE (ruled by force through past revolts) is more lawless — resentment
 *  breeds crime, so a ruler who only ever crushes dissent slowly pushes his port toward the black flag. */
function steadyLawlessness(isl, t) {
  const m = isl.magistrate;
  let s = t.LAWLESS_BASE
    + (1 - (isl.civ || 0)) * t.LAWLESS_POVERTY
    + (isl.danger || 0) * t.LAWLESS_DANGER
    + (isl.grievance || 0) * t.LAWLESS_GRIEVANCE
    + (isl.tax || 0) * (t.LAWLESS_TAX || 0); // heavy taxation breeds unrest — closes the tax→gold→civ back-door
  if (foodDays(isl, t) < t.FAMINE_FOOD_DAYS) s += t.LAWLESS_FAMINE;
  if (m) {
    s -= magSkill(m, t) * t.LAWLESS_ORDER_SKILL;
    s -= (m.traits.integrity - 0.5) * t.LAWLESS_INTEGRITY; // graft breeds crime; honesty curbs it
    s -= m.traits.firmness * t.LAWLESS_FIRM;               // an iron fist suppresses disorder (at loyalty's cost)
    if (m.ambition && m.ambition.kind === 'order') s -= t.LAWLESS_ORDER_AMBITION; // a mayor actively keeping the peace
  }
  return clamp(s, 0, 1);
}

export function magSkill(mag, rules) { return mag ? 1 - Math.exp(-(mag.xp || 0) / rules.MAG_XP_SCALE) : 0; }

export function magRank(mag) {
  const xp = (mag && mag.xp) || 0;
  let label = RANKS[0][1];
  for (const [min, name] of RANKS) if (xp >= min) label = name;
  return label;
}

/** Why a populace rose up — for the chronicle's "why". */
function rebelCause(isl, rules) {
  if (foodDays(isl, rules) < rules.FAMINE_FOOD_DAYS) return 'famine in the streets';
  if (isl.plague) return 'plague and death';
  if (isl.blight) return 'a blighted, failing economy';
  const mag = isl.magistrate;
  if (mag && mag.exposed) return 'years of brazen graft';
  if (mag && mag.traits.integrity < 0.4) return "the magistrate's corruption";
  if ((isl.tax || 0) >= (rules.TAX_MAX || 0.4) * 0.75) return 'crushing taxes';
  if (isl.civ < 0.3) return 'grinding poverty';
  return 'years of hard misrule';
}

/** The loyalty an island trends toward, given its prosperity + who governs it. */
function steadyLoyalty(isl, rules) {
  const m = isl.magistrate, tr = m.traits;
  const s = rules.LOYALTY_STEADY_BASE
    + isl.civ * rules.LOYALTY_CIV_WEIGHT
    + magSkill(m, rules) * rules.LOYALTY_SKILL_WEIGHT
    + tr.generosity * rules.LOYALTY_GEN_WEIGHT
    - tr.firmness * rules.LOYALTY_FIRM_RESENT
    - (isl.lawlessness || 0) * rules.LAWLESS_LOYALTY_DRAG   // a lawless port trusts its ruler less
    + (isl._approval || 0) * (rules.APPROVAL_LOYALTY_W || 0); // the populace's decaying memory of recent policy
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

    // LAWLESSNESS drifts toward its hardship/governance-set steady state (civil order, distinct
    // from political loyalty). It drags civ + growth (population.js) and is the metric a pirate
    // haven grows from. A day's drift eases it toward where the island's fortunes put it.
    isl.lawlessness = clamp((isl.lawlessness || 0) + (steadyLawlessness(isl, t) - (isl.lawlessness || 0)) * t.LAWLESS_RECOVER * dDay, 0, 1);

    // GRIEVANCE heals slowly as the wounds of past suppression fade — faster on a prosperous, content
    // port (a well-fed people forgets), barely at all on a poor one still nursing its resentment.
    if ((isl.grievance || 0) > 0) {
      const heal = t.GRIEVANCE_HEAL_PER_DAY + (isl.civ || 0) * t.GRIEVANCE_HEAL_CIV;
      isl.grievance = Math.max(0, isl.grievance - heal * dDay);
    }

    // AMBITION — the magistrate governs toward an agenda. Track its progress; a thriving agenda
    // buoys his standing, and pressing on with grand designs while the port starves erodes it.
    let ambitionDm = 0;
    if (daily && mag.ambition) {
      const sig = ambitionSignal(world, isl);
      mag.ambition.progress = clamp((mag.ambition.progress != null ? mag.ambition.progress : 0.35) + sig * t.AMBITION_PROGRESS_RATE, 0, 1);
      ambitionDm = (mag.ambition.progress - 0.5) * t.AMBITION_LOYALTY_BONUS; // results judged by the people
      const ruin = foodDays(isl, t) < t.FOOD_SECURITY_DAYS || isl.gold < 40;
      if (ruin) {
        ambitionDm -= t.AMBITION_OVERREACH_PENALTY; // overreach: chasing glory while the port suffers
        logEventThrottled(world, 'overreach', t.SIM_DAY_SECONDS * 3, `${mag.name} presses on with grand designs for ${isl.name} while the port suffers — discontent festers.`, { islandId: isl.id });
      } else if (mag.ambition.progress >= t.AMBITION_MILESTONE && !mag.ambition.milestone) {
        mag.ambition.milestone = true;
        const verb = (AMBITION_META[mag.ambition.kind] || {}).verb || 'better';
        logEvent(world, 'ambition', `${isl.name} flourishes — ${mag.name}'s drive to ${verb} the port bears fruit.`, { islandId: isl.id });
      } else if (mag.ambition.progress < t.AMBITION_MILESTONE - 0.2) {
        mag.ambition.milestone = false;
      }
    }

    // POPULACE MEMORY + a CORRUPTION SCANDAL (daily). The people's memory of recent policy fades toward
    // 0 (so in normal operation _approval decays out and no limit-cycle forms); and a hoard grown fat
    // enough to be NOTICED breaks as a public scandal — a one-time blow to approval + an `exposed` latch
    // (surfaced in the UI, and it makes an overthrow pay off). The steady graft→loyalty drag rides the
    // existing integrity penalty below; this is the moment it becomes PUBLIC.
    if (daily) {
      isl._approval = (isl._approval || 0) * (1 - (t.APPROVAL_DECAY || 0));
      if ((mag.hoard || 0) > (t.HOARD_EXPOSE || Infinity) && !mag.exposed) {
        mag.exposed = true;
        isl._approval = clamp((isl._approval || 0) + (t.APPROVAL_HOARD_EXPOSED || 0), -1, 1);
        logEvent(world, 'corruption', pickText(world, [
          `${isl.name}'s streets seethed as word spread that ${mag.name} had bled the treasury into a private hoard.`,
          `A leaked ledger laid ${mag.name}'s skimming bare, and ${isl.name}'s taverns boiled with talk of years of stolen coin.`,
          `${mag.name}'s hidden hoard was the talk of every tavern in ${isl.name}; the port's temper turned ugly.`,
        ]), { islandId: isl.id });
      }
    }

    // LOYALTY drift toward the steady state, plus hardship drags and comfort boosts.
    const skill = magSkill(mag, t), tr = mag.traits;
    let dm = t.LOYALTY_RECOVER * (steadyLoyalty(isl, t) - isl.loyalty) + ambitionDm;
    if (foodDays(isl, t) < t.FAMINE_FOOD_DAYS) dm -= t.LOYALTY_FAMINE;
    if (isl.plague) dm -= t.LOYALTY_PLAGUE;
    if (isl.blight) dm -= t.LOYALTY_BLIGHT;
    if (isl.population > 0.9 * isl.k) dm -= t.LOYALTY_CROWD;
    if ((isl.stock.Ale || 0) + (isl.stock.LuxuryGoods || 0) > t.CIRCUS_MIN_STOCK) dm += t.LOYALTY_CIRCUS; // bread & circuses
    if (tr.integrity < 0.5) dm -= (0.5 - tr.integrity) * t.LOYALTY_GRAFT;                                 // corruption
    isl.loyalty = clamp((isl.loyalty != null ? isl.loyalty : t.LOYALTY_STEADY_BASE) + dm * dDay, 0, 1);

    // UNREST → REBELLION. Firmness (fear) and a seasoned hand hold the streets longer; a populace
    // already embittered by past bloody suppression (grievance) rises again the sooner.
    if (isl.loyalty < t.REBEL_LOYALTY) isl.unrest = (isl.unrest || 0) + dDay;
    else isl.unrest = Math.max(0, (isl.unrest || 0) - dDay * 1.5);
    const grace = Math.max(0.4, t.REBEL_GRACE_DAYS + skill * t.REBEL_GRACE_SKILL + tr.firmness * t.REBEL_GRACE_FIRM
      - (isl.grievance || 0) * t.REBEL_GRACE_GRIEVANCE);
    if (isl.unrest >= grace && world.simTime >= (isl._rebelCd || 0)) {
      isl.rebellion = { until: world.simTime + t.REBELLION_DAYS * t.SIM_DAY_SECONDS };
      logEvent(world, 'rebellion', `Rebellion erupts on ${isl.name} — ${rebelCause(isl, t)} drove the people to rise; the port is aflame.`, { islandId: isl.id });
    }

    // A magistrate who has held the port in good order through a first full year — a governance beat
    // (tier:'log'). A rebelling island has already `continue`d above, so this only fires on a calm port.
    if (daily && !mag._firstYear && mag._installedDay != null && (isl.loyalty || 0) > 0.5
        && day - mag._installedDay >= t.FIRST_YEAR_DAYS) {
      mag._firstYear = true;
      logEvent(world, 'neworder', `${mag.name} has held ${isl.name} in good order through a first full year.`, { islandId: isl.id, tier: 'log' });
    }

    if (daily) mag.xp = (mag.xp || 0) + t.MAG_XP_PER_DAY; // experience for a day of order kept
  }
}

/** The fire burns out: the magistrate crushes the revolt, or the island casts him out. Crushing it
 *  is never free: a populace put down by force nurses ever-deeper GRIEVANCE, so each revolt a ruler
 *  survives makes the NEXT one come sooner (grace), harder to crush (pQuell), and the port more
 *  lawless — the tyrant slowly digging his own grave, and the port's road toward the black flag. An
 *  overthrow, by contrast, vents most of that resentment: the hated ruler is finally gone. */
function resolveRebellion(world, isl) {
  const t = world.rules;
  const mag = isl.magistrate;
  const pQuell = Math.min(0.9, t.QUELL_BASE_MAG + magSkill(mag, t) * t.QUELL_SKILL_MAG + mag.traits.firmness * t.QUELL_FIRM_MAG
    - (isl.grievance || 0) * t.QUELL_GRIEVANCE_MAG);
  if (streamFloat(world, 'rebel') < pQuell) {
    isl.grievance = clamp((isl.grievance || 0) + t.GRIEVANCE_PER_QUELL, 0, 1); // put down by force → resentment festers
    logEvent(world, 'quellReb', `${mag.name} crushed the rebellion on ${isl.name} and clung to power — but the grievances deepen.`, { islandId: isl.id });
  } else {
    const hoard = mag.hoard || 0;
    const corrupt = !!mag.exposed || mag.traits.integrity < 0.4 || hoard > (t.HOARD_EXPOSE || Infinity) * 0.5;
    const cause = corrupt ? 'graft' : 'overthrow';                  // a distinct handover cause for a toppled grafter
    const from = { name: mag.name, voiceSeed: mag.voiceSeed, rank: magRank(mag) }; // capture the cast-out ruler before installMagistrate overwrites isl.magistrate
    // The deposed grafter's self-justifying last words land as the reign's final beat, in their own hand.
    if (corrupt) logEvent(world, 'corruption', pickText(world, [
      `${mag.name} was dragged from office, still protesting that every coin had been spent for ${isl.name}'s own good.`,
      `${mag.name} was hauled from the counting-house, still swearing the hoard had been for ${isl.name} all along.`,
      `${mag.name} went to the cells cursing the mob, clutching the ledger and insisting the coin had been owed to the office.`,
    ]), { islandId: isl.id, tier: 'log' });
    const newMag = installMagistrate(world, isl);     // a fresh regime takes over, with a fresh agenda + re-targeted economy
    const verb = ((AMBITION_META[newMag.ambition.kind] || {}).verb) || 'rebuild';
    logEvent(world, 'overthrow', pickText(world, [
      `${isl.name} rose up and cast out ${mag.name}; ${newMag.name} seizes the ruined port with a mind to ${verb} it.`,
      `The streets of ${isl.name} turned on ${mag.name} at last; ${newMag.name} takes the seal, vowing to ${verb} what's left.`,
      `${mag.name} is gone, torn down by ${isl.name}'s own people; ${newMag.name} inherits the wreckage and a plan to ${verb} it.`,
    ]), { islandId: isl.id, data: regimeData(from, { name: newMag.name, voiceSeed: newMag.voiceSeed, rank: magRank(newMag) }, cause) });
    isl.civ *= (1 - t.OVERTHROW_CIV_HIT);            // the old order's works scattered
    isl.gold = Math.floor(isl.gold * (1 - t.OVERTHROW_GOLD_HIT)); // treasury looted
    // The people SEIZE the tyrant's hidden hoard — so toppling a CORRUPT hoarder returns wealth (offsetting
    // the looting), while toppling an honest-but-failed ruler is pure loss. WHO you overthrow matters.
    if (hoard > 0) {
      const seized = Math.floor(hoard * (t.HOARD_RECOVERY || 0));
      isl.gold += seized;
      if (seized > 50) {
        const g = seized.toLocaleString('en-US');
        logEvent(world, 'graftseized', pickText(world, [
          `${isl.name}'s people seized ${g} g from ${from.name}'s hidden hoard.`,
          `The mob broke into ${from.name}'s strong-room and hauled ${g} g of skimmed coin back to ${isl.name}'s treasury.`,
          `${g} g of ${from.name}'s stolen hoard was recovered and poured back into ${isl.name}'s coffers.`,
        ]), { islandId: isl.id, data: { hoard: seized } });
      }
    }
    isl.gold = clamp(Math.floor(isl.gold), 0, (t.GOLD_MAX_PER_POP || 40) * isl.population); // clamp after the injection (v2)
    isl.lawlessness = clamp((isl.lawlessness || 0) + t.LAWLESS_OVERTHROW_BUMP, 0, 1); // turmoil leaves the streets unruly
    isl.grievance = (isl.grievance || 0) * t.GRIEVANCE_OVERTHROW_KEEP; // the tyrant is gone — the worst resentment vents
  }
  isl.loyalty = Math.max(isl.loyalty, 0.5); // order (of a sort) restored
  isl.unrest = 0;
  isl.rebellion = null;
  isl._rebelCd = world.simTime + t.REBEL_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
}

/** Whether the island's economy is frozen by revolt (read by production/upkeep). */
export function inRebellion(island) { return !!(island && island.rebellion); }
