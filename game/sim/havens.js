// Pirate havens — the dark endpoint of the lawlessness stat. An island whose civil order collapses
// utterly (lawlessness pinned at the top while its civilisation rots) FALLS to the black flag: it
// becomes a pirate stronghold. A haven HARBOURS pirates — they sail to it to resupply food and to
// FENCE their plundered loot — and turns that fenced wealth into NEW pirate hulls (built from real
// Wood+Iron, nothing conjured free). This gives piracy a reliable, visible home base instead of the
// seed-dependent trickle of lone mutineers who starve within a day. It is self-limiting: a haven
// draws PRIVATEERS, who bombard it (antipiracy.js → assaultHaven) and, given enough pressure, break
// its grip — REDEEMING it back into a lawful port under a fresh magistrate, its harboured pirates
// cast out to roam homeless. Grows from [[lawlessness]]; capped by HAVEN_MAX_FRAC. PURE.

import { streamFloat } from './rng.js';
import { logEvent } from './events.js';
import { transfer, GOLD, PEOPLE, clamp } from './resources.js';
import { createShip } from './ship.js';
import { turnPirate, pirateCount } from './piracy.js';
import { shipName } from './naming.js';
import { installMagistrate } from './magistrate.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function havenCount(world) { let n = 0; for (const i of world.islands) if (i.haven) n++; return n; }

/** SIM system: fall failing islands to havens, drive each haven (entrench, build pirates, harbour
 *  and fence for nearby pirates), and redeem those beaten down by privateers. Runs after antipiracy
 *  (so a privateer's assault this tick can tip a haven into redemption) and before crew/upkeep. */
export function havens(world, h) {
  const t = world.rules;
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  const daily = day !== world._havenDay;
  if (daily) world._havenDay = day;
  const dDay = h / t.SIM_DAY_SECONDS;

  const havenList = [];
  for (const isl of world.islands) {
    if (isl.haven) { driveHaven(world, isl, dDay, daily); if (isl.haven) havenList.push(isl); }
    else if (daily) maybeFall(world, isl);
  }
  if (havenList.length) harbourPirates(world, havenList, dDay);
}

/** A wholly lawless, uncivilised port teeters for HAVEN_FALL_DAYS, then falls. Capped fleet-wide. */
function maybeFall(world, isl) {
  const t = world.rules;
  const failing = (isl.lawlessness || 0) >= t.HAVEN_LAWLESS && (isl.civ || 0) <= t.HAVEN_MAX_CIV && isl.population > t.POP_FLOOR * 2;
  if (failing) {
    isl._havenPressure = (isl._havenPressure || 0) + 1;
    if (isl._havenPressure >= t.HAVEN_FALL_DAYS && havenCount(world) < Math.max(1, Math.floor(world.islands.length * t.HAVEN_MAX_FRAC))) {
      fall(world, isl);
    }
  } else {
    isl._havenPressure = Math.max(0, (isl._havenPressure || 0) - 1);
  }
}

function fall(world, isl) {
  const t = world.rules;
  isl.haven = true;
  isl.havenStrength = t.HAVEN_START_STRENGTH;
  isl._havenPressure = 0;
  isl._havenBuildCd = world.simTime + t.HAVEN_BUILD_COOLDOWN_DAYS * t.SIM_DAY_SECONDS * 0.5; // a short grace before the first hull
  isl.rebellion = null;  // the disorder curdled into a pirate regime rather than an open blaze
  isl.contract = null;   // no lawful WANTED postings from a den of thieves
  isl.magistrate = null; // no lawful ruler — a pirate lord holds the wharves (governance auto-skips a magistrate-less isle)
  isl.wantsShip = false;
  logEvent(world, 'haven', `${isl.name} has fallen to the black flag — a lawless pirate haven now, its wharves ruled by cutthroats.`, { islandId: isl.id });
  // Its own idle merchant crews are the first to turn: instant raiders at no build cost — how a haven
  // bootstraps its fleet before fenced plunder funds new hulls.
  let turned = 0;
  for (const s of world.ships) {
    if (turned >= t.HAVEN_SEED_PIRATES) break;
    if (s.homeId === isl.id && !s.pirate && !s.privateer) { turnPirate(world, s); turned++; }
  }
}

function driveHaven(world, isl, dDay, daily) {
  const t = world.rules;
  isl.lawlessness = 1;   // a haven is wholly lawless
  isl.loyalty = 0;       // and holds no lawful order
  isl.havenStrength = clamp((isl.havenStrength || 0) + t.HAVEN_ENTRENCH_PER_DAY * dDay, 0, 1); // digs in the longer it stands

  // BUILD a pirate from fenced plunder + hull timber and iron (a real cost — nothing free).
  if (daily && world.simTime >= (isl._havenBuildCd || 0)) {
    const based = world.ships.reduce((n, s) => n + (s.pirate && s.homeId === isl.id ? 1 : 0), 0);
    const roomInSeas = pirateCount(world) < Math.max(2, Math.floor(world.ships.length * t.PIRATE_MAX_FRAC * 2.5)); // havens lift the ceiling a touch
    if (based < t.HAVEN_MAX_PIRATES_EACH && roomInSeas
        && (isl.gold || 0) >= t.HAVEN_BUILD_GOLD + t.HAVEN_BUILD_RESERVE
        && (isl.stock.Wood || 0) >= t.HAVEN_SHIP_WOOD && (isl.stock.Iron || 0) >= t.HAVEN_SHIP_IRON) {
      isl.gold -= t.HAVEN_BUILD_GOLD;
      isl.stock.Wood -= t.HAVEN_SHIP_WOOD;
      isl.stock.Iron -= t.HAVEN_SHIP_IRON;
      buildPirate(world, isl);
      isl._havenBuildCd = world.simTime + t.HAVEN_BUILD_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
    }
  }

  if ((isl.havenStrength || 0) <= 0) redeem(world, isl);
}

/** Lay down a fresh raider at the haven — a fast, light sloop under a fearsome captain. */
function buildPirate(world, haven) {
  const ship = createShip(world.nextEntityId++, haven, world.rules, 'sloop');
  ship.name = shipName(world);
  ship.x = haven.x; ship.y = haven.y;
  world.ships.push(ship);
  turnPirate(world, ship); // sets the black flag, a pirate captain, and its hunting state; logs 'pirate'
}

/** Pirates near a haven RESUPPLY (draw food from the haven's stores) and FENCE their loot (offload
 *  plundered coin + goods into the haven), throttled. This is what makes a haven a base: its raiders
 *  eat and get rich, and the haven grows wealthy enough to build the next hull. */
function harbourPirates(world, havenList, dDay) {
  const t = world.rules;
  for (const p of world.ships) {
    if (!p.pirate || p._sunk) continue;
    let haven = null, best = Infinity;
    for (const hv of havenList) { const d = dist(p, hv); if (d < best) { best = d; haven = hv; } }
    if (!haven || best > t.HAVEN_RESUPPLY_RANGE) continue;

    // FENCE — drop plundered coin and cargo (except a little food to sail on) into the haven's coffers.
    transfer(p.cargo, GOLD, haven, 'gold', p.cargo[GOLD] || 0);
    for (const g in p.cargo) {
      if (g === GOLD || g === PEOPLE || g === 'Food') continue;
      if ((p.cargo[g] || 0) > 0.5) transfer(p.cargo, g, haven.stock, g, p.cargo[g]);
    }
    // RESUPPLY — victual the crew from the haven's larder (free to its own; a base feeds its raiders).
    const want = t.CREW_FOOD_PER_DAY * t.PROVISION_DAYS - (p.cargo.Food || 0);
    if (want > 0.5 && (haven.stock.Food || 0) > 1) transfer(haven.stock, 'Food', p.cargo, 'Food', Math.min(want, t.HAVEN_RESUPPLY_FOOD * dDay + 1));
  }
}

/** A privateer/navy batters a haven: cut its entrenchment, and enough breaks its grip. Risky — the
 *  haven's guns can send the attacker down. Called from antipiracy when a privateer has no prey and
 *  a haven is in reach. Returns true if it engaged (so the caller doesn't also sail past). */
export function assaultHaven(world, striker, haven) {
  const t = world.rules;
  if (streamFloat(world, 'combat') < t.HAVEN_ASSAULT_RISK) {
    striker._sunk = true;
    logEvent(world, 'hunterlost', `${striker.name || 'A privateer'} was sunk assaulting the pirate haven of ${haven.name}.`, { islandId: haven.id, shipId: striker.id });
    return true;
  }
  haven.havenStrength = Math.max(0, (haven.havenStrength || 0) - t.HAVEN_SUPPRESS_PER_HIT);
  if (haven.havenStrength <= 0) { redeem(world, haven); return true; }
  logEvent(world, 'assault', `${striker.name || 'A privateer'} bombarded the pirate haven of ${haven.name} — its grip weakens.`, { islandId: haven.id, shipId: striker.id });
  return true;
}

/** The haven is broken: order returns under a fresh lawful magistrate; its harboured pirates lose
 *  their base (they keep raiding but now starve like any rogue — self-limiting). */
function redeem(world, isl) {
  const t = world.rules;
  isl.haven = false;
  isl.havenStrength = 0;
  isl._havenPressure = 0;
  isl.lawlessness = t.HAVEN_REDEEM_LAWLESS; // the scars of lawlessness linger, but order returns
  isl.loyalty = 0.5;
  isl.unrest = 0;
  isl._rebelCd = world.simTime + t.REBEL_COOLDOWN_DAYS * t.SIM_DAY_SECONDS;
  installMagistrate(world, isl); // a lawful regime retakes the port with a fresh agenda + re-targeted economy
  logEvent(world, 'redeemed', `The black flag is struck at ${isl.name} — privateers have retaken the haven; a lawful magistrate restores order.`, { islandId: isl.id });
}
