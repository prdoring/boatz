// The MAGISTRATE POLICY LOOP — the land-side agent's daily decision. Until now a magistrate made a
// single choice per regime (its `ambition`, which only reshaped demand targets); here it finally
// ACTS on that ambition. Phase 2 covers the INDUSTRY lever: the magistrate BUILDS, SWITCHES,
// DEMOLISHES, and REPAIRS its island's mutable WORKSHOPS to serve its agenda and the market.
// (Fiscal/corruption — Phase 3 — and garrison/infrastructure/trade — Phase 4 — extend this system.)
//
// INFORMATION TRAVELS BY SEA: every cross-island read the loop makes (a supplier's price, a supply
// line's danger) goes through the island's OWN ship-carried BELIEFS/INTEL, never a live scan of
// another port's truth — so a magistrate reasons from stale reports and can be wrong, exactly like
// every other actor in the sim. PURE + deterministic (no Date/Math.random; state is serialisable).
//
// The score-and-act driver is written generically (a priority list of scored actions) so the Pirate
// Lord's war-economy loop (Phase 6) can reuse the same shape.

import { clamp, safeDiv, basePrice } from './resources.js';
import { slotCap, mutateWorkshops, workshopStaffing, producesRaw, foodDays } from './island.js';
import { producersOf, flushProducers } from './goals.js';
import { beliefMid } from './beliefs.js';
import { believedDanger } from './intel.js';
import { logEvent } from './events.js';
import { commissionHull } from './development.js';
import { computeFleetByHome } from './fleet.js';
import { streamFloat } from './rng.js';

/** Pick one phrasing from a pool (seeded, deterministic) — so a recurring policy beat doesn't read the
 *  SAME sentence every time in the Story tab. The chosen text is then folded to first-person in the
 *  ruling keeper's own hand (chronicle-narrate.js); the pool gives word-variety on top of that. Draws
 *  from a DEDICATED cosmetic 'narrate' stream so it never perturbs any economic/decision RNG. */
function pick(world, arr) { return arr[Math.min(arr.length - 1, Math.floor(streamFloat(world, 'narrate') * arr.length))]; }

// Nice prose names for a workshop of each industrial good (island-name-first `event.text` folds to
// first-person in the ruling keeper's voice automatically — see chronicle-narrate.js).
const WORKSHOP_NAME = {
  Weapons: 'gun-foundry', Clothing: 'weaving-house', LuxuryGoods: "jeweller's works", Ships: 'shipyard',
};
function workshopName(g) { return WORKSHOP_NAME[g] || (g.toLowerCase() + ' works'); }

// Industrial goods whose making lifts civilisation (a welfare nudge in the score).
const COMFORT = new Set(['Clothing', 'LuxuryGoods']);

/** How corrupt this island's magistrate is: 0 (honest) … 0.5 (fully venal). Drives graft on spends +
 *  the score tilt (a grafter chases margin to skim, and cares less for the public good). */
function graftLevel(isl) {
  const m = isl.magistrate;
  return m && m.traits ? Math.max(0, 0.5 - m.traits.integrity) : 0;
}
/** The grafted cost of a `base` policy spend — a corrupt magistrate BILLS the treasury more (used by
 *  the affordability gate). */
function graftedCost(world, isl, base) { return base * (1 + graftLevel(isl) * (world.rules.GRAFT_RATE || 0)); }
/** Pay for a policy action: the treasury is billed the grafted total; a corrupt magistrate pockets the
 *  inflation into its hidden hoard. */
function spendWithGraft(world, isl, base) {
  const g = graftLevel(isl) * (world.rules.GRAFT_RATE || 0);
  isl.gold = Math.max(0, isl.gold - base * (1 + g));
  if (g > 0 && isl.magistrate) isl.magistrate.hoard = Math.min(world.rules.HOARD_MAX || Infinity, (isl.magistrate.hoard || 0) + base * g);
}

/** Does making good X serve this magistrate's ambition? 0..1. (The profit term carries `wealth`.) */
function ambitionFit(kind, X) {
  switch (kind) {
    case 'fortify': case 'order': return X === 'Weapons' ? 1 : 0;
    case 'splendor': return X === 'LuxuryGoods' ? 1 : (X === 'Clothing' || X === 'Ale') ? 0.5 : 0;
    case 'grow': return X === 'Food' ? 0.7 : (X === 'Clothing' || X === 'Ale') ? 0.5 : 0; // a grow mayor feeds its people
    case 'industry': return 0.6; // any manufacture advances an industrialising port
    default: return 0;
  }
}

/** Resolve one recipe input for SCORING, mirroring production.resolveInput's "prefer a local raw":
 *  returns { local, cost, supplierId }. A local input is priced at the island's OWN (live, known)
 *  price; a foreign one at the cheapest BELIEVED price among its producers (stale — no omniscience),
 *  falling back to the base-price prior when the island knows of no producer. */
function resolveInput(world, isl, input, day) {
  const t = world.rules;
  const opts = input.all ? [input.all] : (input.anyOf || []);
  for (const r of opts) {
    if (producesRaw(isl, r) || isl.produces.includes(r)) {
      return { local: true, cost: isl.price[r] ? isl.price[r].mid : basePrice(t, r), supplierId: null };
    }
  }
  let best = null;
  for (const r of opts) {
    for (const p of producersOf(world, r)) {
      if (p === isl) continue;
      const cost = beliefMid(world, isl, p.id, r, day);
      if (!best || cost < best.cost) best = { local: false, cost, supplierId: p.id };
    }
  }
  return best || { local: false, cost: basePrice(t, opts[0]), supplierId: null };
}

/** Score building/keeping a workshop for industrial good X at this island (see the economy.json doc).
 *  Higher = a better bet. Reads only own live state + the island's own beliefs/intel. */
function scoreGood(world, isl, X, day) {
  const t = world.rules;
  const recipe = world.economy._recipeByOut[X];
  if (!recipe) return -Infinity;
  const sell = isl.price[X] ? isl.price[X].mid : basePrice(t, X); // it knows its OWN price live
  let inputCost = 0, imported = 0, totalQty = 0, peril = 0;
  for (const inp of recipe.inputs) {
    const r = resolveInput(world, isl, inp, day);
    inputCost += inp.qty * r.cost;
    totalQty += inp.qty;
    if (!r.local) {
      imported += inp.qty;
      // A supply line's peril = the believed danger of the supplier we'd buy from; an UNKNOWN
      // supplier (no producer in our books) is riskier still — we don't even know where to source it.
      peril = Math.max(peril, r.supplierId ? believedDanger(world, isl, r.supplierId, day) : 0.35);
    }
  }
  const margin = safeDiv(sell - inputCost, basePrice(t, X), 0);
  const fracImp = totalQty > 0 ? imported / totalQty : 0;
  const importRisk = fracImp * peril;
  const saturation = safeDiv(producersOf(world, X).length, world.islands.length, 0); // who already makes it
  const amb = isl.magistrate.ambition ? ambitionFit(isl.magistrate.ambition.kind, X) : 0;
  const welfare = COMFORT.has(X) ? 1 : 0;
  const diversity = fracImp === 0 ? 1 : 0; // a self-sufficient trade is worth a nudge (anti-homogenisation)
  // Corruption tilts the objective: a grafter over-weights PROFIT (more margin to skim) and under-weights
  // the public good (welfare), so a venal magistrate chases lucrative works over what the people want.
  const graft = graftLevel(isl);
  return t.POLICY_W_PROFIT * (1 + graft) * margin
    + t.POLICY_W_AMBITION * amb
    + t.POLICY_W_WELFARE * (1 - graft * 2) * welfare
    - t.POLICY_W_RISK * importRisk
    - t.POLICY_W_SATURATION * saturation
    + t.POLICY_W_DIVERSITY * diversity;
}

/** Count of this island's INDUSTRIAL workshops. */
function industrialCount(isl, industrial) {
  let n = 0;
  for (const w of isl.workshops || []) if (industrial.includes(w.good)) n++;
  return n;
}

/** Per-day: advance each industrial workshop's "how long has it been idle/derelict/starved" counter,
 *  which drives the demolish trigger (v2 #9 hysteresis). Reset the moment it runs healthy again. */
function updateIdleTimers(isl, industrial) {
  for (const w of isl.workshops || []) {
    if (!industrial.includes(w.good)) continue;
    const idle = (w._st != null && w._st !== 0) || w._starved; // unstaffed/unfunded/derelict OR input-starved
    w._lowDays = idle ? (w._lowDays || 0) + 1 : 0;
  }
}

const onCd = (isl, good, now) => isl._wsCd && now < (isl._wsCd[good] || 0);
function setCd(isl, good, until) { if (!isl._wsCd) isl._wsCd = {}; isl._wsCd[good] = until; }

/** DEMOLISH — tear down a workshop that has sat idle/derelict too long: free the slot + stop billing
 *  upkeep on a cold works. Highest priority (stop the bleed before spending on anything new). */
function tryDemolish(world, isl) {
  const t = world.rules;
  const industrial = t.INDUSTRIAL_GOODS || [];
  const victim = (isl.workshops || []).find((w) => industrial.includes(w.good) && (w._lowDays || 0) >= (t.WORKSHOP_DERELICT_DAYS || 8));
  if (!victim) return false;
  mutateWorkshops(world, isl, isl.workshops.filter((w) => w !== victim));
  setCd(isl, victim.good, world.simTime + (t.WORKSHOP_COOLDOWN_DAYS || 12) * t.SIM_DAY_SECONDS); // don't re-raise it at once
  const wn = workshopName(victim.good);
  logEvent(world, 'derelict', pick(world, [
    `${isl.name} pulls down its idle ${wn}; the cold works are cleared away.`,
    `${isl.name} tears out its derelict ${wn} — better bare ground than a rotting shell.`,
    `The shuttered ${wn} of ${isl.name} is demolished, its berth freed for something new.`,
    `${isl.name} clears away a failed ${wn} — no sense feeding a works that makes nothing.`,
  ]), { islandId: isl.id, tier: 'log', data: { good: victim.good } });
  return true;
}

/** BUILD — raise the best-scoring buildable good into an open slot, if affordable + staffable. */
function tryBuild(world, isl, day) {
  const t = world.rules;
  const industrial = t.INDUSTRIAL_GOODS || [];
  const nInd = industrialCount(isl, industrial);
  if (nInd >= slotCap(isl, t)) return false;                        // no open berth
  const projStaff = Math.min(1, isl.population * (t.WORKFORCE_FRAC || 0.5) / ((t.LABOR_PER_WORKSHOP || 10) * (nInd + 1)));
  if (projStaff < (t.POLICY_BUILD_MIN_STAFFING || 0.8)) return false; // can't crew another works (v2 #8 hysteresis)
  if ((isl.gold || 0) < graftedCost(world, isl, t.WORKSHOP_BUILD_GOLD) + t.POLICY_TREASURY_RESERVE) return false;
  if ((isl.stock.Wood || 0) < t.WORKSHOP_BUILD_WOOD || (isl.stock.Iron || 0) < t.WORKSHOP_BUILD_IRON) return false; // no timber/iron to build with

  const have = new Set(isl.workshops.map((w) => w.good));
  let best = null;
  for (const X of industrial) {
    if (have.has(X) || onCd(isl, X, world.simTime)) continue;       // one workshop per good; respect the cooldown
    const s = scoreGood(world, isl, X, day);
    if (!best || s > best.s) best = { X, s };
  }
  if (!best || best.s < (t.POLICY_BUILD_MIN_SCORE ?? 0.1)) return false;

  spendWithGraft(world, isl, t.WORKSHOP_BUILD_GOLD);                 // a real gold + materials sink (billed higher if corrupt)
  isl.stock.Wood = Math.max(0, isl.stock.Wood - t.WORKSHOP_BUILD_WOOD);
  isl.stock.Iron = Math.max(0, isl.stock.Iron - t.WORKSHOP_BUILD_IRON);
  mutateWorkshops(world, isl, [...isl.workshops, { good: best.X, condition: 1 }]);
  const wn = workshopName(best.X);
  logEvent(world, 'workshop', pick(world, [
    `${isl.name} raises a new ${wn} — the port takes up a fresh trade.`,
    `A ${wn} rises on ${isl.name}'s wharves; its artisans set to work.`,
    `${isl.name} lays the foundations of a ${wn}, broadening what it makes for the sea.`,
    `Smoke and hammering where there was idle ground — ${isl.name} builds itself a ${wn}.`,
  ]), { islandId: isl.id, tier: 'log', data: { good: best.X } });
  return true;
}

/** SWITCH — when every slot is full, retool the worst-earning workshop into a markedly better good. */
function trySwitch(world, isl, day) {
  const t = world.rules;
  const industrial = t.INDUSTRIAL_GOODS || [];
  if (industrialCount(isl, industrial) < slotCap(isl, t)) return false; // still has room → prefer BUILD
  if ((isl.gold || 0) < graftedCost(world, isl, t.WORKSHOP_SWITCH_GOLD) + t.POLICY_TREASURY_RESERVE) return false;

  const have = new Set(isl.workshops.map((w) => w.good));
  let worst = null;
  for (const w of isl.workshops) {
    if (!industrial.includes(w.good)) continue;
    const s = scoreGood(world, isl, w.good, day);
    if (!worst || s < worst.s) worst = { w, s };
  }
  let best = null;
  for (const X of industrial) {
    if (have.has(X) || onCd(isl, X, world.simTime)) continue;
    const s = scoreGood(world, isl, X, day);
    if (!best || s > best.s) best = { X, s };
  }
  if (!worst || !best || best.s < worst.s + (t.POLICY_SWITCH_MARGIN || 0.4)) return false;

  spendWithGraft(world, isl, t.WORKSHOP_SWITCH_GOLD);
  const next = isl.workshops.map((w) => (w === worst.w ? { good: best.X, condition: 0.5 } : w)); // new works starts half-built
  mutateWorkshops(world, isl, next);
  setCd(isl, worst.w.good, world.simTime + (t.WORKSHOP_COOLDOWN_DAYS || 12) * t.SIM_DAY_SECONDS);
  const from = workshopName(worst.w.good), to = workshopName(best.X);
  logEvent(world, 'workshop', pick(world, [
    `${isl.name} retools its ${from} into a ${to}, chasing a better trade.`,
    `The ${from} at ${isl.name} is gutted and made over into a ${to}.`,
    `${isl.name} turns its hand from the ${from} to a ${to}, following the coin.`,
  ]), { islandId: isl.id, tier: 'log', data: { good: best.X } });
  return true;
}

/** REPAIR — spend to refit a run-down workshop the port CAN crew, so it comes back online fast rather
 *  than crawling up through slow drift. (No point reviving one it can't staff — it would just re-rot.) */
function tryRepair(world, isl) {
  const t = world.rules;
  const industrial = t.INDUSTRIAL_GOODS || [];
  if ((isl.gold || 0) < graftedCost(world, isl, t.WORKSHOP_MAINTAIN_GOLD) + t.POLICY_TREASURY_RESERVE) return false;
  if (workshopStaffing(isl, t) < 0.8) return false;
  const w = (isl.workshops || []).find((s) => industrial.includes(s.good) && (s.condition != null ? s.condition : 1) < (t.POLICY_REPAIR_BELOW || 0.4));
  if (!w) return false;
  spendWithGraft(world, isl, t.WORKSHOP_MAINTAIN_GOLD);
  w.condition = Math.min(1, (w.condition || 0) + 0.35);
  w._lowDays = 0;
  const wn = workshopName(w.good);
  logEvent(world, 'workshop', pick(world, [
    `${isl.name} refits its ${wn}; the hammers ring out anew.`,
    `${isl.name} pours coin into its run-down ${wn}, and the works come back to life.`,
    `The ${wn} at ${isl.name} is patched up and set working again.`,
  ]), { islandId: isl.id, tier: 'log', data: { good: w.good } });
  return true;
}

/** NAVAL EXPANSION — a fleet-ambition mayor (grow/wealth/industry) commissions a new hull from a yard
 *  it believes is open, budgeted from the same treasury as every other spend (the old development.js
 *  loop, folded into the policy menu — v2 #10). Replacing LOST hulls stays need-driven in goals.js. */
function tryNaval(world, isl, day) {
  const t = world.rules;
  const kind = isl.magistrate.ambition && isl.magistrate.ambition.kind;
  if (kind !== 'grow' && kind !== 'wealth' && kind !== 'industry') return false;
  if (world.simTime < (isl._devCd || 0)) return false;
  if ((isl.gold || 0) < t.DEVELOP_SHIP_GOLD + (t.POLICY_TREASURY_RESERVE || 0)) return false;
  if (!commissionHull(world, isl, day)) return false;
  isl._devCd = world.simTime + (t.DEVELOP_COOLDOWN_DAYS || 10) * t.SIM_DAY_SECONDS;
  return true;
}

/** PUBLIC WORKS — a welfare spend: lifts civ, eases lawlessness/grievance, and warms approval. A
 *  grow/splendor/order mayor makes it when flush with sagging civ, or ANY mayor when loyalty is fragile. */
function tryPublicWorks(world, isl) {
  const t = world.rules;
  const kind = isl.magistrate.ambition && isl.magistrate.ambition.kind;
  const loy = isl.loyalty != null ? isl.loyalty : 1;
  if (!(kind === 'grow' || kind === 'splendor' || kind === 'order' || loy < 0.5)) return false;
  if ((isl.civ || 0) > (t.PUBLIC_WORKS_CIV_MAX || 0.75)) return false; // already thriving → no need
  if ((isl.gold || 0) < graftedCost(world, isl, t.PUBLIC_WORKS_GOLD) + t.POLICY_TREASURY_RESERVE) return false;
  spendWithGraft(world, isl, t.PUBLIC_WORKS_GOLD);
  isl.civ = Math.min(1, (isl.civ || 0) + (t.PUBLIC_WORKS_CIV || 0.05));
  isl.lawlessness = Math.max(0, (isl.lawlessness || 0) - (t.PUBLIC_WORKS_ORDER || 0.04));
  isl.grievance = Math.max(0, (isl.grievance || 0) - (t.PUBLIC_WORKS_ORDER || 0.04));
  isl._approval = clamp((isl._approval || 0) + (t.APPROVAL_PUBLICWORKS || 0.25), -1, 1);
  logEvent(world, 'publicworks', pick(world, [
    `${isl.name} raises a public work — a fountain, a granary, a mended quay — and the people take heart.`,
    `${isl.name} spends on the common good: a market roof, a paved lane, a well dug deep. The port brightens.`,
    `A new almshouse, a repaired sea-wall — ${isl.name} tends to its people, and they warm to their ruler.`,
    `${isl.name} puts idle hands to public works, and the mood of the streets lifts with the wages.`,
  ]), { islandId: isl.id, tier: 'log' });
  return true;
}

/** DEVELOP a new workshop SLOT — an industry/grow mayor whose berths are all full buys +1 capacity (a
 *  big gold sink), so its industry can keep growing past the population-tiered base. */
function tryDevelopSlot(world, isl) {
  const t = world.rules;
  const kind = isl.magistrate.ambition && isl.magistrate.ambition.kind;
  if (kind !== 'industry' && kind !== 'grow') return false;
  if (industrialCount(isl, t.INDUSTRIAL_GOODS || []) < slotCap(isl, t)) return false; // still has open berths → BUILD instead
  if (slotCap(isl, t) >= (t.MAX_SLOTS || 6)) return false;                             // already at the hard cap
  if ((isl.gold || 0) < graftedCost(world, isl, t.DEVELOP_SLOT_GOLD) + t.POLICY_TREASURY_RESERVE) return false;
  spendWithGraft(world, isl, t.DEVELOP_SLOT_GOLD);
  isl.development = (isl.development || 0) + 1;
  logEvent(world, 'publicworks', pick(world, [
    `${isl.name} clears fresh ground by its wharves — room for another works.`,
    `${isl.name} drains a marsh and lays out a new works-yard, making space for its industry to grow.`,
    `Surveyors mark out fresh ground at ${isl.name}; another workshop berth is opened.`,
  ]), { islandId: isl.id, tier: 'log' });
  return true;
}

/** GARRISON — a fortify/order mayor, or ANY port in dangerous waters, raises its Weapons stock target so
 *  the trade machine imports guns for the shore batteries. A cheap standing order, run every day. */
function tryGarrison(world, isl) {
  const t = world.rules;
  const kind = isl.magistrate.ambition && isl.magistrate.ambition.kind;
  const wants = kind === 'fortify' || kind === 'order' || (isl.danger || 0) > (t.GARRISON_DANGER || 0.3);
  if (wants && (isl.targets.Weapons || 0) < (t.GARRISON_WEAPONS_TARGET || 80)) isl.targets.Weapons = t.GARRISON_WEAPONS_TARGET || 80;
}

/** TARIFF lever — a protectionist mayor (order/fortify/wealth) raises its duty on foreign trade toward
 *  TARIFF_MAX; a grow/industry mayor (which needs cheap imports) keeps its port open. Eased daily. On
 *  first raising a real duty, a beat is logged. */
function tryTariff(world, isl) {
  const t = world.rules;
  const kind = isl.magistrate.ambition && isl.magistrate.ambition.kind;
  const target = (kind === 'order' || kind === 'fortify' || kind === 'wealth') ? (t.TARIFF_MAX || 0.3) : 0;
  const tar = isl.tariff || 0;
  const step = t.TARIFF_STEP || 0.05;
  let next = tar;
  if (tar < target - 1e-6) next = Math.min(target, Math.round((tar + step) * 100) / 100);
  else if (tar > target + 1e-6) next = Math.max(target, Math.round((tar - step) * 100) / 100);
  if (next === tar) return;
  isl.tariff = next;
  if (tar < 0.15 && next >= 0.15) logEvent(world, 'tariff', pick(world, [
    `${isl.name} throws up protective duties against foreign trade.`,
    `${isl.name} shuts its purse to foreigners — a stiff tariff now greets outside traders.`,
    `The magistrate of ${isl.name} levies duties on foreign hulls, favouring its own.`,
  ]), { islandId: isl.id, tier: 'log', data: { tariff: next } });
}

/** EXPORT HOLDS — in DISTRESS the magistrate withholds a strategic good from FOREIGN export, keeping it
 *  for its own people: Food when the larder runs thin, Weapons when raiders are about and the garrison is
 *  short. Cleared when the crisis passes. Manages island._holds (a plain, JSON-safe array). */
function tryHolds(world, isl) {
  const t = world.rules;
  const holds = new Set(isl._holds || []);
  if (foodDays(isl, t) < (t.FOOD_SECURITY_DAYS || 2)) holds.add('Food'); else holds.delete('Food');
  const gunShort = (isl.stock.Weapons || 0) < (isl.targets.Weapons || 0) * 0.5;
  if ((isl.danger || 0) > (t.GARRISON_DANGER || 0.3) && gunShort) holds.add('Weapons'); else holds.delete('Weapons');
  isl._holds = [...holds];
}

/** TAXATION lever — the magistrate nudges its income-tax rate within a HYSTERESIS band: cut when
 *  loyalty is fragile, raise when it is secure AND the port needs revenue AND the ruler isn't too
 *  generous. In normal operation tax holds and _approval decays to 0 (no limit-cycle). Each change
 *  pushes the populace's approval, and on crossing a levy band logs a beat. Runs every policy day (a
 *  light continuous knob, independent of the once-per-cooldown industry action). */
function tryTax(world, isl) {
  const t = world.rules;
  const m = isl.magistrate;
  const loy = isl.loyalty != null ? isl.loyalty : 1;
  const tax = isl.tax || 0;
  const kind = m.ambition && m.ambition.kind;
  const wantsRevenue = kind === 'wealth' || kind === 'fortify' || kind === 'splendor' || (isl.gold || 0) < (t.POLICY_TREASURY_RESERVE || 700);
  let next = tax;
  if (loy < (t.TAX_CUT_LOYALTY || 0.35) && tax > (t.TAX_MIN || 0)) next = tax - (t.TAX_STEP || 0.05);
  else if (loy > (t.TAX_RAISE_LOYALTY || 0.6) && wantsRevenue && m.traits.generosity < 0.65 && tax < (t.TAX_MAX || 0.4)) next = tax + (t.TAX_STEP || 0.05);
  next = clamp(Math.round(next * 100) / 100, t.TAX_MIN || 0, t.TAX_MAX || 0.4);
  if (next === tax) return;
  isl.tax = next;
  const up = next > tax;
  isl._approval = clamp((isl._approval || 0) + (up ? (t.APPROVAL_TAX_HIKE || 0) : (t.APPROVAL_TAX_CUT || 0)), -1, 1);
  const band = (x) => (x < 0.12 ? 0 : x < 0.28 ? 1 : 2);
  if (band(next) !== band(tax)) { // log only a MATERIAL move — a crossed levy band, not every 0.05 step
    const word = ['light', 'moderate', 'heavy'][band(next)];
    logEvent(world, up ? 'taxup' : 'taxcut', up
      ? pick(world, [
          `${isl.name} raises its taxes to a ${word} levy.`,
          `The magistrate of ${isl.name} tightens the purse-strings — a ${word} levy now falls on the port.`,
          `New tax-farmers walk ${isl.name}'s wharves; the levy is ${word} now, and the merchants grumble.`,
        ])
      : pick(world, [
          `${isl.name} eases its taxes to a ${word} levy.`,
          `The magistrate of ${isl.name} lightens the burden — taxes fall to a ${word} levy.`,
          `${isl.name}'s people breathe easier as the levy is cut to a ${word} rate.`,
        ]),
      { islandId: isl.id, tier: 'log', data: { tax: next } });
  }
}

/** SIM system (once per sim-day): each magistrate takes at most one industry action, priority-ordered.
 *  Registered AFTER governance (reads loyalty/civ) and near development/contracts. */
export function policy(world, h) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  if (day === world._policyDay) return;
  world._policyDay = day;
  const industrial = t.INDUSTRIAL_GOODS || [];
  computeFleetByHome(world); // fresh per-home census for the naval-expansion lever (fleetAt)

  for (const isl of world.islands) {
    if (!isl.magistrate || isl.rebellion || isl.haven) continue; // no lawful policy while aflame or fallen
    updateIdleTimers(isl, industrial);                            // keep the demolish timer accurate every day
    tryTax(world, isl);                                           // continuous fiscal knob (hysteresis-gated, cheap)
    tryGarrison(world, isl);                                      // continuous standing order: import guns if threatened/fortifying
    tryTariff(world, isl);                                        // continuous: ease the foreign-trade duty toward the ambition's target
    tryHolds(world, isl);                                         // continuous: withhold strategic goods from export in distress
    if (world.simTime < (isl._policyCd || 0)) continue;          // per-island action throttle
    // One throttled treasury action, priority-ordered: stop the bleed, then grow industry, fleet,
    // welfare, capacity, then retool/refit. Each gate carries its own ambition + affordability test.
    const acted = tryDemolish(world, isl)
      || tryBuild(world, isl, day)
      || tryNaval(world, isl, day)
      || tryPublicWorks(world, isl)
      || tryDevelopSlot(world, isl)
      || trySwitch(world, isl, day)
      || tryRepair(world, isl);
    if (acted) isl._policyCd = world.simTime + (t.POLICY_COOLDOWN_DAYS || 6) * t.SIM_DAY_SECONDS;
  }

  flushProducers(world); // coalesced: rebuild the per-good producer index ONCE after all mutations (v2 #3)
}
