// Gold flow + universal spoilage — the sinks that keep the economy from inflating and
// make disruption bite. Gold is NO LONGER conserved: it is created and destroyed here (a
// flow economy), which is what lets shipwrecks/blights/plague actually cost something.
//
//   SOURCE  income  = GOLD_INCOME_RATE · population · civ        (GDP — prosperous,
//                                                                 populous ports mint wealth)
//   SINK    upkeep  = SHIP_UPKEEP·ships + PROD_UPKEEP·population  (fleet + factory maintenance
//                                                                 — a FIXED cost you pay even
//                                                                 when trade is disrupted)
//   SINK    hoard cap: gold above GOLD_MAX_PER_POP·population overflows (no infinite hoards)
//
// So a thriving port profits (income > upkeep → grows to its cap), but a port whose
// production/population is knocked down by an event earns less than its fixed upkeep and
// BLEEDS toward zero — the "if trade is disrupted it could be a problem" dynamic.
//
// Spoilage: every stockpile decays a little each step, so goods can't sit pinned at the
// cap forever — they must be continually produced and traded. PURE.

export function upkeep(world, h) {
  const t = world.rules;
  const perDay = h / t.SIM_DAY_SECONDS;
  const spoil = (t.STOCK_SPOILAGE || 0) * h;

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
    const income = island.rebellion ? 0 : t.GOLD_INCOME_RATE * pop * (0.4 + 0.6 * (island.civ || 0)) * perDay;
    const cost = (t.SHIP_UPKEEP_PER_DAY * n + t.PROD_UPKEEP_PER_DAY * pop) * perDay;
    const cap = t.GOLD_MAX_PER_POP * pop;
    island.gold = Math.max(0, Math.min(cap, island.gold + income - cost));

    if (spoil > 0) {
      const st = island.stock;
      for (const k in st) { const v = st[k]; if (v > 0) st[k] = v - v * spoil; }
    }
  }
}
