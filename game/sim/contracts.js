// Contracts — directed, visible relief logistics. A port in ACUTE need of a good it can't make
// itself posts a paid CONTRACT: a reward set aside from its treasury (escrowed) that pays out to
// whoever supplies the good, on top of the sale. It pulls that good in faster than price alone
// would — a shipwright starved of Iron, a port rebuilding after a raid — and makes a readable
// "WANTED / fulfilled" story. Ships route to the premium (queries.js), the reward is paid per
// delivery (trade.js) until the hold refills or the purse runs dry. PURE. Runs once per sim-day.

import { logEventThrottled } from './events.js';
import { tradeables } from './resources.js';

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
        if (c._fulfilled || stocked) logEventThrottled(world, 'contractdone', 0.5 * t.SIM_DAY_SECONDS, `${isl.name}'s contract for ${c.good} was fulfilled — its holds are replenished.`, { islandId: isl.id });
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
    if (!worst) continue;
    isl.gold -= t.CONTRACT_REWARD; // set the reward aside (escrow)
    isl.contract = { good: worst, reward: t.CONTRACT_REWARD, until: world.simTime + t.CONTRACT_DAYS * t.SIM_DAY_SECONDS };
    isl._contractCd = world.simTime + t.CONTRACT_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
    logEventThrottled(world, 'contract', 0.5 * t.SIM_DAY_SECONDS, `${isl.name} posts a ${t.CONTRACT_REWARD}g contract for ${worst} — supply it and claim the reward.`, { islandId: isl.id });
  }
}
