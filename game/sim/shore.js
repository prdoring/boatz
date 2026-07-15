// Shore batteries — an island FIGHTS BACK against hostile shipping loitering in its waters, instead of
// passively sheltering while a raider chokes its trade or a hunter batters its walls. Two mirrored cases:
//   • a LAWFUL port shells PIRATES with its traded armoury (stock.Weapons). Firing spends powder — a real
//     Weapons sink and standing gun demand — so a port that never restocks falls silent, and a poor,
//     unarmed one can't shoot at all (self-limiting).
//   • a pirate HAVEN turns its guns on besieging PRIVATEERS, its strength its ENTRENCHMENT (havenStrength),
//     which a privateer's bombardment (havens.js assaultHaven) already wears down — so the longer the siege
//     presses, the weaker the den's answering fire.
// Guns scale with the garrison: a well-found port can cripple or sink a raider that lingers; a lightly-armed
// one only stings. Throttled per-port (_cannonCd) so it fires measured salvoes, not a per-substep beam.
// Registered after piracy + antipiracy (reads their FINAL positions this tick), before separation. PURE —
// its only randomness is the seeded 'combat' stream, so it serialises and replays deterministically.

import { streamFloat } from './rng.js';
import { logEvent } from './events.js';
import { payBounty } from './bounty.js';
import { buildShipGrid, nearestShip } from './grid.js';
import { damageHull, damageRig } from './repair.js';

/** SIM system: every armed island fires on the nearest hostile ship within cannon range. */
export function shoreBatteries(world, h) {
  const t = world.rules;
  if (t.PORT_CANNON_RANGE == null) return; // feature disabled
  const pirates = world.ships.filter((s) => s.pirate && !s._sunk);      // a lawful port's foes
  const privateers = world.ships.filter((s) => s.privateer && !s._sunk); // a haven's foes
  if (!pirates.length && !privateers.length) return;
  const pirateGrid = buildShipGrid(world, pirates);
  const privGrid = buildShipGrid(world, privateers);
  const full = t.PORT_CANNON_FULL || 12; // stockpiled guns for a full-strength battery
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  let sunk = false;

  for (const isl of world.islands) {
    if (world.simTime < (isl._cannonCd || 0)) continue; // still reloading
    // Which flag flies decides the garrison AND the prey: a lawful port shells pirates from its armoury; a
    // haven shells privateers from its fortifications.
    const garrison = isl.haven ? (isl.havenStrength || 0) * full : (isl.stock.Weapons || 0);
    const minGun = isl.haven ? 0.05 : (t.PORT_CANNON_MIN_WEAPONS || 2);
    if (garrison < minGun) continue; // no working guns
    const target = nearestShip(isl.haven ? privGrid : pirateGrid, isl.x, isl.y, null, t.PORT_CANNON_RANGE);
    if (!target) continue; // nothing hostile in the roads

    isl._cannonCd = world.simTime + (t.PORT_CANNON_COOLDOWN || 12);
    // A lawful port burns powder from the armoury (a Weapons sink → ongoing gun demand); a haven fires on
    // its own works, whose wear is the bombardment it already takes.
    if (!isl.haven) isl.stock.Weapons = Math.max(0, (isl.stock.Weapons || 0) - (t.PORT_CANNON_COST || 0.6));
    // The salvo: burn the target's guns, then grind its HULL (and a little RIG) — round-shot into a hull
    // that won't leave. A well-found battery bites hard; a lone gun only stings. The damage ACCUMULATES
    // across salvoes, so a ship that lingers under fire is worn down and eventually founders (hull → 0) —
    // shore guns deter loitering rather than dealing a lucky one-shot. A small extra coup keeps the drama.
    target.cargo.Weapons = Math.max(0, (target.cargo.Weapons || 0) - (t.PORT_CANNON_BURN || 1));
    const power = Math.min(1, garrison / full);
    const hullDmg = (t.PORT_CANNON_HULL_DMG || 0.06) * power;
    damageHull(target, hullDmg, t);
    damageRig(target, hullDmg * 0.5, t); // chain-shot in the rigging too — a battered ship can't slip away
    if (target.hull <= 0 || streamFloat(world, 'combat') < (t.PORT_CANNON_SINK || 0.02) * power) {
      target._sunk = true; sunk = true;
      if (isl.haven) {
        logEvent(world, 'battery', `The guns of ${isl.name} sank the privateer ${target.name || 'a hunter'} besieging its haven.`, { islandId: isl.id, shipId: target.id });
      } else {
        const paid = payBounty(world, target, isl.id); // the port claims the bounty on the raider it downed
        logEvent(world, 'battery', `${isl.name}'s shore guns sank ${target.name || 'a raider'} standing off the port${paid ? ` — ${paid}g bounty claimed` : ''}.`, { islandId: isl.id, shipId: target.id });
      }
    } else if (isl._batteryDay !== day) { // once a day per port, note it is fighting back — so the guns are VISIBLE
      isl._batteryDay = day;              // in the chronicle (they mostly wear a raider down rather than sink it)
      logEvent(world, 'battery', isl.haven
        ? `The guns of ${isl.name} thunder at ${target.name || 'a privateer'} besieging its haven.`
        : `${isl.name}'s shore batteries open fire on ${target.name || 'a raider'} standing into its waters.`,
        { islandId: isl.id, shipId: target.id });
    }
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}
