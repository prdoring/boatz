// Island development — a wealthy port INVESTS its surplus into fleet growth. This is the
// deliberate counterpart to the fragile buy-a-ship-on-a-voyage path (which needs an idle hull at
// home exactly when demand peaks, so it almost never fires): here a rich, under-strength port
// simply commissions a new hull from a shipyard directly. It's a real GOLD SINK (a big outlay,
// self-limited because a bigger fleet costs more upkeep), and it honours the economy — the hull is
// a Ship the shipyard actually BUILT from Wood+Iron, bought and paid for, not conjured free. The
// build reflects the port's wealth at the moment it invests (a flush hub lays down a galleon; a
// modest one a brig), so fleets diversify as fortunes diverge. PURE. Runs once per sim-day.

import { bidAsk } from './pricing.js';
import { transfer, GOLD } from './resources.js';
import { spawnShip, chooseShipType } from './ship.js';
import { nearestWhere } from './queries.js';
import { isEmbargoed } from './reputation.js';
import { computeFleetByHome, fleetAt } from './fleet.js';
import { beliefMid } from './beliefs.js';
import { believedHaven } from './intel.js';

/** Commission ONE hull for `isl` from a shipyard it BELIEVES is open (information travels by sea), paid
 *  from the treasury — a real gold SINK + fleet growth (the hull is a Ship the yard actually built,
 *  bought and paid for). Returns true if a hull was bought. The caller keeps the per-home census fresh
 *  (computeFleetByHome) and applies its own throttle + ambition gates. This is now the EXECUTOR that the
 *  magistrate's naval-expansion lever (policy.js) calls — no longer a parallel treasury-spender (v2 #10). */
export function commissionHull(world, isl, day) {
  const t = world.rules;
  if (world.ships.length >= t.MAX_SHIPS_TOTAL) return false;
  if ((isl.gold || 0) < t.DEVELOP_SHIP_GOLD) return false;          // only a flush port invests
  if (fleetAt(world, isl.id).total >= t.MAX_SHIPS_PER_ISLAND) return false; // fleet already at its cap
  // Source a hull: its own yard if it has stock, else the nearest yard the port BELIEVES is open (not a
  // known haven) and that hasn't embargoed it — stale intel, not omniscient truth (mirrors goals.js), so
  // it may commission from a yard since fallen, or overlook one since cleared.
  const src = (isl.stock.Ships || 0) >= 1 ? isl
    : nearestWhere(world, isl, (p) => (p.stock.Ships || 0) >= 1 && !believedHaven(world, isl, p.id, day) && !isEmbargoed(p, isl.id, t) && !isEmbargoed(isl, p.id, t));
  if (!src) return false;
  // A port knows its OWN yard's price live; a foreign yard's price is only BELIEVED (stale).
  const askMid = src === isl ? isl.price.Ships.mid : beliefMid(world, isl, src.id, 'Ships', day);
  const ask = bidAsk(askMid, t.SPREAD).ask;
  if ((isl.gold || 0) < ask + t.DEVELOP_RESERVE) return false;      // keep a working reserve after buying
  const type = chooseShipType(world, isl);                         // build on PRE-spend wealth (the rich lay down galleons)
  if (src !== isl) transfer(isl, 'gold', src, 'gold', ask);        // pay the shipyard (a gold flow)
  else isl.gold = Math.max(0, isl.gold - ask);                     // (self-built: the outlay is still a sink)
  src.stock.Ships = Math.max(0, (src.stock.Ships || 0) - 1);       // consume the hull it built
  spawnShip(world, isl, type);                                     // spawns at home + logs 'launch'
  return true;
}

/** Legacy per-day fleet-growth loop, RETAINED so tests exercise commissionHull directly. In the live
 *  sim this is NO LONGER a registered system — magistrate policy (policy.js tryNaval) drives fleet
 *  expansion now, ambition-gated and budgeted alongside every other treasury spend (v2 #10). */
export function development(world, h) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  if (day === world._devDay) return;
  world._devDay = day;
  computeFleetByHome(world); // per-home census (spawnShip keeps it fresh as hulls launch)
  for (const isl of world.islands) {
    if (isl.rebellion || isl.haven) continue;                      // a port aflame or turned pirate builds no honest fleet
    if (world.simTime < (isl._devCd || 0)) continue;
    if (commissionHull(world, isl, day)) isl._devCd = world.simTime + t.DEVELOP_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
  }
}
