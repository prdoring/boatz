// Contracts — directed, visible relief logistics. A port in ACUTE need of a good it can't make
// itself posts a paid CONTRACT: a reward set aside from its treasury (escrowed) that pays out to
// whoever supplies the good, on top of the sale. It pulls that good in faster than price alone
// would — a shipwright starved of Iron, a port rebuilding after a raid — and makes a readable
// "WANTED / fulfilled" story. Ships route to the premium (queries.js), the reward is paid per
// delivery (trade.js) until the hold refills or the purse runs dry. PURE. Runs once per sim-day.

import { logEventThrottled } from './events.js';
import { tradeables } from './resources.js';

// The good a magistrate's AMBITION most wants pulled in by contract (if the port lacks it) — so a
// fortify mayor commissions Weapons, a splendour mayor luxuries, etc. Directed relief becomes agenda-driven.
const AMBITION_CONTRACT_GOOD = { fortify: 'Weapons', order: 'Weapons', splendor: 'LuxuryGoods', grow: 'Clothing' };

/** The bonus gold a delivery of `good` to `island` earns right now, drawn from its contract purse. */
export function contractPayout(world, island, good, qty) {
  const c = island.contract;
  if (!c || c.good !== good || c.reward <= 0) return 0;
  const bonus = Math.min(c.reward, qty * world.rules.CONTRACT_UNIT_BONUS);
  c.reward -= bonus;
  if (c.reward <= 0.5) { c.reward = 0; c._fulfilled = true; } // purse emptied → fulfilled
  return bonus;
}

export function contracts(world, h) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  if (day === world._contractDay) return;
  world._contractDay = day;

  for (const isl of world.islands) {
    const c = isl.contract;
    if (c) {
      // Close a contract that's been filled, run dry, or lapsed — refunding any unspent reward.
      const stocked = (isl.stock[c.good] || 0) >= isl.targets[c.good] * t.RESERVE_RATIO;
      if (c.reward <= 0 || stocked || world.simTime >= c.until) {
        if (c.reward > 0) isl.gold += c.reward; // unspent purse returns to the treasury
        // #26 — distinguish the two ways a contract ENDS: the reward PURSE ran dry (deliveries claimed it
        // all) vs the HOLDS reached target (stocked; the port withdraws the standing offer).
        if (c._fulfilled) logEventThrottled(world, 'contractdone', 0.5 * t.SIM_DAY_SECONDS, `${isl.name}'s contract for ${c.good} is claimed in full — the reward purse is spent.`, { islandId: isl.id });
        else if (stocked) logEventThrottled(world, 'contractdone', 0.5 * t.SIM_DAY_SECONDS, `${isl.name}'s holds of ${c.good} are replenished — it withdraws the contract.`, { islandId: isl.id });
        isl.contract = null;
      }
      continue;
    }
    if (isl.rebellion || isl.haven) continue; // a port aflame or fallen to piracy posts no lawful contracts
    if (world.simTime < (isl._contractCd || 0)) continue; // a port posts sparingly, not constantly
    if ((isl.gold || 0) < t.CONTRACT_MIN_TREASURY + t.CONTRACT_REWARD) continue;

    // Post for the good it most acutely lacks and doesn't make itself (food is covered by the
    // survival/aid systems, so it's excluded here — contracts are for materials & manufactures).
    let worst = null, worstRatio = t.CONTRACT_SHORTAGE;
    for (const good of tradeables(world.economy)) {
      if (t.SPECIAL_GOODS.includes(good) || good === 'Food') continue;
      if (isl.produces && isl.produces.includes(good)) continue;
      const ratio = (isl.stock[good] || 0) / Math.max(1, isl.targets[good]);
      if (ratio < worstRatio) { worstRatio = ratio; worst = good; }
    }
    // MAGISTRATE-DRIVEN: if the mayor's AMBITION wants a good the port lacks (and is short of), commission
    // THAT instead — directed relief becomes agenda-driven (a fortifier pulls in Weapons, etc.).
    const mag = isl.magistrate;
    const ambGood = mag && mag.ambition ? AMBITION_CONTRACT_GOOD[mag.ambition.kind] : null;
    if (ambGood && !(isl.produces && isl.produces.includes(ambGood))
        && (isl.stock[ambGood] || 0) / Math.max(1, isl.targets[ambGood]) < t.CONTRACT_SHORTAGE) worst = ambGood;
    if (!worst) continue;
    // ESCROW subject to GRAFT: a corrupt magistrate pads the purse and pockets the excess into its hoard.
    const graft = mag ? Math.max(0, 0.5 - mag.traits.integrity) * (t.GRAFT_RATE || 0) : 0;
    isl.gold -= t.CONTRACT_REWARD * (1 + graft); // set the reward aside (escrow), padded if corrupt
    if (graft > 0 && mag) mag.hoard = Math.min(t.HOARD_MAX || Infinity, (mag.hoard || 0) + t.CONTRACT_REWARD * graft);
    isl.contract = { good: worst, reward: t.CONTRACT_REWARD, until: world.simTime + t.CONTRACT_DAYS * t.SIM_DAY_SECONDS };
    isl._contractCd = world.simTime + t.CONTRACT_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
    logEventThrottled(world, 'contract', 0.5 * t.SIM_DAY_SECONDS, `${isl.name} posts a ${t.CONTRACT_REWARD}g contract for ${worst} — supply it and claim the reward.`, { islandId: isl.id });
  }
}
