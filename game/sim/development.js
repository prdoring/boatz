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

export function development(world, h) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  if (day === world._devDay) return;
  world._devDay = day;
  if (world.ships.length >= t.MAX_SHIPS_TOTAL) return;

  for (const isl of world.islands) {
    if (world.ships.length >= t.MAX_SHIPS_TOTAL) break;
    if (world.simTime < (isl._devCd || 0)) continue;
    if ((isl.gold || 0) < t.DEVELOP_SHIP_GOLD) continue;          // only a flush port invests
    if (isl.rebellion || isl.haven) continue;                      // a port aflame or turned pirate builds no honest fleet
    const owned = world.ships.filter((s) => s.homeId === isl.id).length;
    if (owned >= t.MAX_SHIPS_PER_ISLAND) continue;                 // fleet already at its cap

    // Source a hull: its own yard if it is one with stock, else the nearest shipyard that has a
    // Ship to sell and hasn't embargoed it.
    const src = (isl.stock.Ships || 0) >= 1 ? isl
      : nearestWhere(world, isl, (p) => (p.stock.Ships || 0) >= 1 && !isEmbargoed(p, isl.id, t) && !isEmbargoed(isl, p.id, t));
    if (!src) continue;

    const ask = bidAsk(src.price.Ships.mid, t.SPREAD).ask;
    if ((isl.gold || 0) < ask + t.DEVELOP_RESERVE) continue;       // keep a working reserve after buying

    // Choose the build on PRE-spend wealth (so the rich really do lay down galleons), then pay the
    // yard, consume the hull it built, and launch.
    const type = chooseShipType(world, isl);
    if (src !== isl) transfer(isl, 'gold', src, 'gold', ask);      // pay the shipyard (a gold flow)
    else isl.gold = Math.max(0, isl.gold - ask);                   // (self-built: the outlay is still a sink)
    src.stock.Ships = Math.max(0, (src.stock.Ships || 0) - 1);
    spawnShip(world, isl, type);                                   // spawns at home + logs 'launch'
    isl._devCd = world.simTime + t.DEVELOP_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
  }
}
