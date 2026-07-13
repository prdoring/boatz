// voyages.js — the outstanding-voyage ledger. A home port cannot see its ships once they sail
// over the horizon: it does NOT instantly know a vessel was sunk far out at sea. Instead it keeps
// EXPECTING each dispatched ship back until an estimated return day plus a grace period; only when
// a ship is truly overdue does the port PRESUME it lost (and only then does it know to seek a
// replacement). This is the "assume it's coming back, then write it off" mechanic — an information
// delay that a raiding pirate exploits (sink a ship and its home sails on none the wiser for a
// while) and a foundation for later gameplay (a ship overdue may simply be becalmed, captured, or
// waylaid — not necessarily dead).
//
//   island.expecting[shipId] = { dueDay, name }
// Rides through serialize.js for free (nested on the island). PURE.

import { currentDay } from './beliefs.js';
import { logEvent } from './events.js';
import { dist } from './queries.js';
import { fleetAt } from './fleet.js';

/** Estimate the sim-day a voyage should be back by: the full round-trip path length at the ship's
 *  speed, plus a dock spell per stop, plus a generous grace for wind, waiting, and detours. */
function estimateReturnDay(world, home, ship, day) {
  const t = world.rules;
  const v = ship.voyage;
  let d = 0, cx = home.x, cy = home.y;
  if (v && v.stops) {
    for (const s of v.stops) {
      const p = world.islandsById.get(s.islandId);
      if (!p) continue;
      d += Math.hypot(p.x - cx, p.y - cy); cx = p.x; cy = p.y;
    }
  }
  d += Math.hypot(home.x - cx, home.y - cy); // and home again
  const speed = ship.speed || t.SHIP_SPEED || 120;
  const sailSecs = d / Math.max(1, speed);
  const dockSecs = ((v && v.stops ? v.stops.length : 0) + 1) * (t.DOCK_SECONDS || 3);
  const travelDays = (sailSecs + dockSecs) / t.SIM_DAY_SECONDS;
  return day + Math.ceil(travelDays * 1.5) + (t.VOYAGE_GRACE_DAYS || 6);
}

/** Record that `home` has sent `ship` off — it now expects it back by an estimated day. */
export function noteDeparture(world, home, ship) {
  if (!home.expecting) home.expecting = {};
  const day = currentDay(world);
  home.expecting[ship.id] = { dueDay: estimateReturnDay(world, home, ship, day), name: ship.name || null };
}

/** The ship made it home — clear it from the ledger (no longer outstanding). */
export function noteReturn(home, ship) {
  if (home.expecting) delete home.expecting[ship.id];
}

/** How many ships a home BELIEVES it still has: those actually afloat under its flag, PLUS any it
 *  is still expecting that have in fact been lost but aren't yet overdue (it doesn't know yet). This
 *  is the count the port plans around, so it won't rush to buy a replacement for a ship it thinks is
 *  merely late. Hard fleet caps (launch/development) still use the LIVE count — beliefs guide
 *  decisions, truth guards invariants. */
export function fleetBelievedByHome(world, island, liveIds) {
  const owned = fleetAt(world, island.id).total; // ships afloat under its flag (O(1) census read)
  let ghosts = 0;
  const exp = island.expecting;
  if (exp) {
    const day = currentDay(world);
    for (const id in exp) {
      if (liveIds.has(id)) continue;            // still afloat — already in `owned`
      if (day <= exp[id].dueDay) ghosts++;      // lost, but the port doesn't know yet — still hoping
    }
  }
  return owned + ghosts;
}

/** SIM system (daily): reckon the ledger. A ship that is gone (sunk) AND now past its due day is
 *  presumed lost — the port finally learns of the loss and stops expecting it. A ship still afloat
 *  but wildly overdue is eventually cleared too (a safety valve, no news). */
export function reckonVoyages(world) {
  const t = world.rules;
  const day = currentDay(world);
  if (day === world._voyageDay) return;
  world._voyageDay = day;

  const live = new Set();
  for (const s of world.ships) live.add(s.id);

  for (const isl of world.islands) {
    const exp = isl.expecting;
    if (!exp) continue;
    for (const id in exp) {
      const e = exp[id];
      if (live.has(id)) {
        // Still afloat. Only clear if absurdly overdue (becalmed forever / stuck) — a safety valve.
        if (day > e.dueDay + (t.VOYAGE_GRACE_DAYS || 6) * 3) delete exp[id];
        continue;
      }
      // Gone from the seas. Until it's overdue the port assumes it's still coming (the delay).
      if (day <= e.dueDay) continue;
      delete exp[id];
      logEvent(world, 'lost', `${e.name || 'A ship'} of ${isl.name} is long overdue and presumed lost at sea.`, { islandId: isl.id });
    }
  }
}
