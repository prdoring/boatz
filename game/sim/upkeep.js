// Gold flow + universal spoilage — the sinks that keep the economy from inflating and
// make disruption bite. Gold is NO LONGER conserved: it is created and destroyed here (a
// flow economy), which is what lets shipwrecks/blights/plague actually cost something.
//
//   SOURCE  income  = GOLD_INCOME_RATE · population · civ        (GDP — prosperous,
//                                                                 populous ports mint wealth)
//   SINK    upkeep  = SHIP_UPKEEP·ships + Σ WORKSHOP_UPKEEP·pop     (fleet + per-WORKSHOP maintenance
//            over each INDUSTRIAL workshop                          — a FIXED cost you pay even when
//                                                                    trade is disrupted; replaces the
//                                                                    old flat PROD_UPKEEP·pop aggregate)
//   DRIFT   each industrial workshop's condition eases toward min(staffing, funding): a port that
//           can't staff (too few people) or fund (empty treasury) its works lets them ROT (disrepair),
//           and mends them back toward new when resourced again — the visible rise-and-fall of industry.
//   SINK    hoard cap: gold above GOLD_MAX_PER_POP·population overflows (no infinite hoards)
//
// So a thriving port profits (income > upkeep → grows to its cap), but a port whose
// production/population is knocked down by an event earns less than its fixed upkeep and
// BLEEDS toward zero — the "if trade is disrupted it could be a problem" dynamic.
//
// Spoilage: every stockpile decays a little each step, so goods can't sit pinned at the
// cap forever — they must be continually produced and traded. PURE.

import { workshopStaffing } from './island.js';

export function upkeep(world, h) {
  const t = world.rules;
  const perDay = h / t.SIM_DAY_SECONDS;
  const spoil = (t.STOCK_SPOILAGE || 0) * h;
  const industrial = t.INDUSTRIAL_GOODS || [];
  const condRate = (t.WORKSHOP_CONDITION_RATE || 0) * perDay;

  // Fleet upkeep scales with each hull's class (a galleon costs far more to keep than a sloop),
  // so a big ship is a real ongoing commitment — the counterweight to its greater capacity.
  const fleet = new Map();
  for (const s of world.ships) {
    const spec = t.SHIP_TYPES && t.SHIP_TYPES[s.type];
    fleet.set(s.homeId, (fleet.get(s.homeId) || 0) + (spec ? spec.upkeep : 1));
  }

  for (const island of world.islands) {
    const pop = island.population;
    const n = fleet.get(island.id) || 0;
    // GDP scales with prosperity, but a floor keeps a poor port from a deflation spiral
    // (low gold → low civ → low income → lower gold).
    // A port aflame with revolt earns nothing while it burns — but its fixed upkeep bleeds on.
    // GROSS income scales with prosperity (civ) AND the magistrate's TAX rate; a floor keeps a poor
    // port off a deflation spiral. A port aflame with revolt earns nothing while it burns.
    const grossIncome = island.rebellion ? 0
      : t.GOLD_INCOME_RATE * pop * (0.4 + 0.6 * (island.civ || 0)) * (1 + (island.tax || 0) * (t.TAX_INCOME_W || 0)) * perDay;
    // CORRUPTION SKIM (a flow, not a one-off): an integrity-poor magistrate quietly diverts a cut of
    // gross income into a hidden HOARD (bounded ≤30% of gross by SKIM_RATE), so less actually reaches the
    // treasury — starving gold → civ → loyalty on top of the static integrity penalty. No haven has one.
    const mag = island.magistrate;
    let income = grossIncome;
    if (mag && grossIncome > 0) {
      const skim = Math.max(0, 0.5 - mag.traits.integrity) * (t.SKIM_RATE || 0) * grossIncome;
      if (skim > 0) { mag.hoard = Math.min(t.HOARD_MAX || Infinity, (mag.hoard || 0) + skim); income = grossIncome - skim; }
    }
    const shipCost = t.SHIP_UPKEEP_PER_DAY * n * perDay;

    // WORKSHOP UPKEEP (replaces the flat PROD_UPKEEP·pop): each INDUSTRIAL workshop bills
    // WORKSHOP_UPKEEP_PER_DAY·pop. Ship upkeep is paid first; the treasury then funds as much of the
    // workshop bill as it can — `funding` < 1 means deferred maintenance, which decays condition below.
    const warGoods = t.HAVEN_WAR_GOODS || [];
    const haven = island.haven;
    // Bill upkeep per MAINTAINED industrial workshop. A haven funds only its WAR works (Weapons/Ships,
    // paid from fenced plunder) — its abandoned civilian works aren't maintained (they rot below).
    let workshopBill = 0;
    for (const shop of island.workshops || []) {
      if (!industrial.includes(shop.good)) continue;
      if (haven && !warGoods.includes(shop.good)) continue;
      workshopBill += t.WORKSHOP_UPKEEP_PER_DAY * pop * perDay;
    }
    const avail = Math.max(0, island.gold + income - shipCost);
    const funding = workshopBill > 0 ? Math.min(1, avail / workshopBill) : 1;
    const cap = t.GOLD_MAX_PER_POP * pop;
    island.gold = Math.max(0, Math.min(cap, avail - workshopBill * funding));

    // CONDITION DRIFT (industrial workshops only). A lawful port eases each toward min(staffing, funding).
    // A HAVEN keeps its WAR works (funding, crewed by its pirates) but lets CIVILIAN works ROT to 0 (no
    // lawful labour — so which island falls matters). A just-REDEEMED port gets an upkeep-holiday floor so
    // it isn't a revolving-door wreck. A precomputed status byte (0 running / 1 idle / 2 derelict) rides the wire.
    if (condRate > 0) {
      const lawfulTarget = Math.min(workshopStaffing(island, t), funding);
      const reconstructing = island._reconstructUntil != null && world.simTime < island._reconstructUntil;
      for (const shop of island.workshops || []) {
        if (!industrial.includes(shop.good)) continue;
        let condTarget = haven ? (warGoods.includes(shop.good) ? funding : 0) : lawfulTarget;
        if (reconstructing) condTarget = Math.max(condTarget, t.HAVEN_RECONSTRUCT_COND || 0.45);
        const cond = shop.condition != null ? shop.condition : 1;
        shop.condition = Math.max(0, Math.min(1, cond + (condTarget - cond) * condRate));
        shop._st = shop.condition <= 0.03 ? 2 : (condTarget < 0.5 ? 1 : 0);
      }
    }

    if (spoil > 0) {
      const st = island.stock;
      for (const k in st) { const v = st[k]; if (v > 0) st[k] = v - v * spoil; }
    }

    // GARRISON DRILL — a lawful armed port's militia musters and keeps order, burning a powder trickle
    // from the armoury each day whether or not a raider is near (Weapons' peacetime demand floor; combat +
    // shore fire are the wartime sinks). Scales with population and DISORDER; never drains the armoury
    // below a working minimum (so the shore batteries stay armed). A haven/rebelling port musters no militia.
    if (!haven && !island.rebellion) {
      const floor = t.MILITIA_MIN_WEAPONS || 0;
      const have = island.stock.Weapons || 0;
      if (have > floor) {
        const use = (t.MILITIA_POWDER_PER_DAY || 0) * pop * (1 + (t.MILITIA_LAWLESS_MULT || 0) * (island.lawlessness || 0)) * perDay;
        island.stock.Weapons = Math.max(floor, have - use);
      }
    }
  }
}
