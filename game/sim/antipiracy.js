// Anti-piracy — the ECONOMY fighting back. Three coupled responses to the black flag:
//   • DANGER routing: word of attacks (bounty.js) makes waters feared; merchants avoid trading
//     with dangerous ports (queries.js reads island.danger), so pirates strangle trade — which
//     is exactly what motivates a port to pay for protection. Danger decays here as peace returns.
//   • BOUNTIES: posted by victims in bounty.js; PAID here when a privateer takes a pirate's head.
//   • PRIVATEERS: a port under threat COMMISSIONS a pirate-hunter. Nothing is free — it must have
//     bought/made WEAPONS (loaded from its armoury) and pay crew wages from the TREASURY, and it
//     gives up one of its idle traders for the duration. The privateer hunts pirates (never
//     merchants), collects the bounty for its home, then stands down when its commission lapses.
// Self-limiting like piracy: fleet-fraction + per-island caps, a commission cooldown, and a real
// gold+weapon+ship cost that a poor or peaceful port simply can't or won't pay. PURE. Runs as its
// own SIM system after `piracy`. The merchant `ship` + `crew` systems skip privateer vessels.

import { streamFloat } from './rng.js';
import { transfer, cargoUnits, GOLD } from './resources.js';
import { logEvent, maybeSink } from './events.js';
import { makeCaptain, skill01 } from './captains.js';
import { windMult } from './wind.js';
import { combatStrength } from './piracy.js';
import { payBounty } from './bounty.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Local straight-line move (can't import ship.js — that would cycle). Returns arrival. */
function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y, d = Math.hypot(dx, dy), step = speed * h;
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
  ship.heading = Math.atan2(dy, dx);
  ship.x += (dx / d) * step; ship.y += (dy / d) * step;
  return false;
}

const burn = (ship, amt) => { ship.cargo.Weapons = Math.max(0, (ship.cargo.Weapons || 0) - amt); };
export function privateerCount(world) { let n = 0; for (const s of world.ships) if (s.privateer) n++; return n; }
function pirateCount(world) { let n = 0; for (const s of world.ships) if (s.pirate && !s._sunk) n++; return n; }

/** SIM system: decay danger, commission privateers where trade is under threat, hunt pirates. */
export function antipiracy(world, h) {
  const t = world.rules;
  const dDay = h / t.SIM_DAY_SECONDS;
  let sunk = false;

  // Peace lets fear fade from the waters.
  for (const isl of world.islands) {
    if (isl.danger > 0) isl.danger = Math.max(0, isl.danger - t.DANGER_DECAY * dDay);
  }

  const pirates = world.ships.filter((s) => s.pirate && !s._sunk);

  // Commission new privateers (throttled globally so it doesn't churn the fleet in one tick).
  if (pirates.length > 0 && privateerCount(world) < Math.max(1, world.ships.length * t.PRIVATEER_MAX_FRAC)) {
    for (const isl of world.islands) {
      if (world.simTime < (isl._privCd || 0)) continue;
      // A pirate must actually threaten these waters — the trigger is the threat itself, not the
      // island's own damage, so a wealthy weapons-stocking port can protect a nearby lane it cares
      // about even before it's personally sacked.
      if (!pirates.some((p) => dist(p, isl) < t.PRIVATEER_THREAT_RANGE)) continue;
      // MEANS (nothing free): keep a treasury reserve after paying wages, and have GUNS in the
      // armoury it had to trade for — so only a solvent, armed port can field a hunter.
      if ((isl.gold || 0) < t.PRIVATEER_TREASURY_MIN + t.PRIVATEER_COMMISSION_COST) continue;
      if ((isl.stock.Weapons || 0) < t.PRIVATEER_WEAPONS_MIN) continue;
      const owned = world.ships.filter((s) => s.privateer && s.homeId === isl.id).length;
      if (owned >= t.PRIVATEER_MAX_PER_ISLAND) continue;
      const hull = world.ships.find((s) => s.homeId === isl.id && !s.pirate && !s.privateer
        && s.state === 'idle' && !s.voyage && (world.agents[s.ownerId] || {}).kind === 'npc');
      if (!hull) continue;
      commissionPrivateer(world, isl, hull);
      isl._privCd = world.simTime + t.PRIVATEER_COOLDOWN;
      break; // at most one commission per tick — keeps the response measured
    }
  }

  // Drive every privateer: hunt, fight, or stand down.
  for (const priv of world.ships) {
    if (!priv.privateer || priv._sunk) continue;
    const speed = (priv.speed || t.SHIP_SPEED) * t.PRIVATEER_SPEED_MULT; // per-hull (a sloop privateer is fleet)
    const home = world.islandsById.get(priv.homeId);

    // Commission lapsed (or the seas are clear): make for home and pay off the crew.
    if (world.simTime >= (priv.privateerUntil || 0) || pirates.length === 0) {
      if (home && moveToward(priv, home.x, home.y, speed, h)) standDown(world, priv, home);
      else if (!home) standDown(world, priv, null);
      continue;
    }

    // Hunt the nearest pirate in range; run it down and fight.
    let prey = priv._prey ? pirates.find((p) => p.id === priv._prey) : null;
    if (!prey || dist(priv, prey) > t.PRIVATEER_HUNT_RANGE) {
      prey = nearestPirate(world, priv, pirates); priv._prey = prey ? prey.id : null;
    }
    if (prey) {
      if (dist(priv, prey) <= t.PIRATE_COMBAT_RANGE) { if (resolveHunt(world, priv, prey)) sunk = true; priv._prey = null; }
      else if (sailHunter(world, priv, prey.x, prey.y, speed, h)) sunk = true;
    } else {
      // No quarry in reach — patrol toward the most troubled nearby port.
      const patrol = mostDangerous(world, priv) || home;
      if (patrol) sailHunter(world, priv, patrol.x, patrol.y, speed, h);
    }
  }

  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}

/** Fit out an idle trader as a pirate-hunter: crew wages from the treasury (a gold sink), guns
 *  from the armoury (a Weapons sink — the port had to trade for them), victuals for the cruise. */
function commissionPrivateer(world, isl, ship) {
  const t = world.rules;
  isl.gold = Math.max(0, isl.gold - t.PRIVATEER_COMMISSION_COST); // crew wages, up front
  ship.privateer = true;
  ship.voyage = null; ship.leg = null; ship.legIdx = 0;
  ship.captain = ship.captain || makeCaptain(world);
  ship.morale = Math.max(ship.morale || 0, 0.85);
  ship.unrest = 0; ship.uprising = null; ship.hunger = 0;
  ship.privateerUntil = world.simTime + t.PRIVATEER_COMMISSION_DAYS * t.SIM_DAY_SECONDS;
  ship._prey = null;
  ship.state = 'outbound';
  // Arm from the armoury (up to the target, bounded by stock + hold space).
  const need = Math.max(0, t.PRIVATEER_WEAPONS - (ship.cargo.Weapons || 0));
  const space = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
  const load = Math.min(need, isl.stock.Weapons || 0, space);
  if (load >= 1) transfer(isl.stock, 'Weapons', ship.cargo, 'Weapons', load);
  // Victual the cruise from the town's food stores.
  const foodWant = t.CREW_FOOD_PER_DAY * (t.PRIVATEER_COMMISSION_DAYS + 3);
  const foodSpace = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
  const food = Math.min(Math.max(0, foodWant - (ship.cargo.Food || 0)), isl.stock.Food || 0, foodSpace);
  if (food >= 1) transfer(isl.stock, 'Food', ship.cargo, 'Food', food);
  logEvent(world, 'privateer', `${isl.name} commissioned the privateer ${ship.name} under Capt. ${ship.captain.name} to hunt the pirates plaguing its waters.`, { islandId: isl.id, shipId: ship.id });
}

/** Pay off the crew and return the ship to honest trade (its guns go back to the armoury). */
function standDown(world, priv, home) {
  priv.privateer = false;
  priv.privateerUntil = 0;
  priv._prey = null;
  priv.state = 'idle';
  priv.voyage = null; priv.leg = null; priv.legIdx = 0;
  if (home && (priv.cargo.Weapons || 0) > 0) transfer(priv.cargo, 'Weapons', home.stock, 'Weapons', priv.cargo.Weapons);
  logEvent(world, 'standdown', `The privateer ${priv.name} stood down and returned to trade${home ? ` at ${home.name}` : ''}.`, { islandId: home ? home.id : undefined, shipId: priv.id });
}

function sailHunter(world, ship, tx, ty, speed, h) {
  const heading = Math.atan2(ty - ship.y, tx - ship.x);
  const eff = speed * windMult(world, heading, skill01(ship.captain, world.rules));
  if (maybeSink(world, ship, eff * h)) return true; // lost to weather like any ship
  moveToward(ship, tx, ty, eff, h);
  return false;
}

/** A privateer runs down a pirate. Well-armed and paid, it usually wins — but the sea is cruel. */
function resolveHunt(world, priv, pirate) {
  const t = world.rules;
  const sP = combatStrength(world, priv), sV = combatStrength(world, pirate);
  const privWins = streamFloat(world, 'combat') < sP / (sP + sV);
  burn(priv, t.COMBAT_WEAPON_BURN * (privWins ? 0.6 : 1.2));
  burn(pirate, t.COMBAT_WEAPON_BURN * (privWins ? 1.2 : 0.6));
  if (privWins) {
    pirate._sunk = true;
    const paid = payBounty(world, pirate, priv.homeId);
    priv.morale = Math.min(1, (priv.morale || 0.7) + 0.1);
    logEvent(world, 'hunted', `The privateer ${priv.name} ran down ${pirate.name} and sank her — Capt. ${priv.captain.name} claimed ${paid}g in bounty.`, { x: pirate.x, y: pirate.y, shipId: priv.id });
    return true;
  }
  priv.morale = Math.max(0, (priv.morale || 0.7) - 0.15);
  pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.1);
  if (streamFloat(world, 'combat') < t.PRIVATEER_LOSS_SINK) {
    priv._sunk = true;
    logEvent(world, 'hunterlost', `The privateer ${priv.name} was lost to ${pirate.name} — Capt. ${pirate.captain.name} beat off the hunter.`, { x: priv.x, y: priv.y, shipId: pirate.id });
  }
  return false;
}

function nearestPirate(world, ship, pirates) {
  let best = null, bestD = Infinity;
  for (const p of pirates) {
    const d = dist(ship, p);
    if (d > world.rules.PIRATE_HUNT_RANGE) continue;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function mostDangerous(world, ship) {
  let best = null, bestScore = -Infinity;
  for (const isl of world.islands) {
    if (!isl.danger) continue;
    const score = isl.danger - dist(ship, isl) * 3e-4;
    if (score > bestScore) { bestScore = score; best = isl; }
  }
  return best;
}
