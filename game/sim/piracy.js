// Piracy — the antagonist. A crew that mutinies sometimes raises the BLACK FLAG instead of just
// swapping captains: the ship leaves the merchant economy and turns predator. Pirates hunt
// merchant ships, run them down, and fight — the outcome decided by CAPTAIN SKILL, CREW MORALE,
// and WEAPONS ABOARD (a ship loaded with guns fights hard but carries less trade; a fat, unarmed
// trader is easy meat). The winner plunders the loser's cargo and coin; the loser is sunk or
// flees stripped. Combat BURNS weapons (a real sink for a good the economy over-produces), and
// pirates need to eat like anyone — so a pirate that can't take prizes or raid a port starves.
// That plus a hard fleet-fraction cap keeps piracy self-limiting. Rich, recurring characters:
// a feared captain "the Redhand" you can follow across the map. PURE. Runs as its own SIM system
// (after `ship`); the merchant ship system skips pirate vessels, the crew system still feeds them.

import { streamFloat } from './rng.js';
import { transfer, cargoUnits, GOLD, PEOPLE } from './resources.js';
import { logEvent, maybeSink } from './events.js';
import { makePirateCaptain, skill01 } from './captains.js';
import { windMult } from './wind.js';
import { markDanger, postBounty, payBounty } from './bounty.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Local straight-line move (piracy can't import ship.js — that would cycle). Returns arrival. */
function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y, d = Math.hypot(dx, dy), step = speed * h;
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
  ship.heading = Math.atan2(dy, dx);
  ship.x += (dx / d) * step; ship.y += (dy / d) * step;
  return false;
}

export function pirateCount(world) { let n = 0; for (const s of world.ships) if (s.pirate) n++; return n; }

/** Weapons a ship has to fight with (offense + defense). */
export function weaponsAboard(ship) { return ship.cargo.Weapons || 0; }

/** A ship's fighting strength: base + captaincy + crew spirit + guns (+ a pirate's ferocity),
 *  scaled by the HULL's fighting character (a brig fights above its weight, a sloop below it, and
 *  it can mount only as many guns as its class allows — a galleon out-guns a sloop). */
export function combatStrength(world, ship) {
  const t = world.rules;
  const spec = (t.SHIP_TYPES && t.SHIP_TYPES[ship.type]) || null;
  const wcap = spec ? spec.weaponCap : t.COMBAT_WEAPON_CAP;
  const cmult = spec ? spec.combat : 1;
  const guns = Math.min(weaponsAboard(ship), wcap) * t.COMBAT_WEAPON_W;
  const s = t.COMBAT_BASE
    + skill01(ship.captain, t) * t.COMBAT_SKILL_W
    + (ship.morale != null ? ship.morale : 0.6) * t.COMBAT_MORALE_W
    + guns
    + (ship.pirate ? t.COMBAT_PIRATE_BONUS : 0)
    + (ship.privateer ? t.COMBAT_PRIVATEER_BONUS : 0); // a professional hunter's edge
  return s * cmult;
}

/** Whether the seas can bear another pirate (fleet-fraction cap → self-limiting). */
export function canTurnPirate(world) {
  return pirateCount(world) < Math.max(1, world.ships.length * world.rules.PIRATE_MAX_FRAC);
}

/** Raise the black flag: this ship becomes a pirate under a fresh, fearsome captain. */
export function turnPirate(world, ship) {
  ship.pirate = true;
  ship.captain = makePirateCaptain(world);
  ship.morale = 0.85; ship.unrest = 0; ship.uprising = null; ship.hunger = 0;
  ship.voyage = null; ship.leg = null; ship.legIdx = 0;
  ship._prey = null; ship._plunder = 0; ship._raidCd = 0;
  ship.state = 'outbound'; // displays as 'sailing'; the piracy system drives it
  const home = world.islandsById.get(ship.homeId);
  logEvent(world, 'pirate', `Black flag! The crew of ${ship.name || 'a ship'} turned pirate under Capt. ${ship.captain.name}${home ? ` — a ${home.name} vessel gone rogue` : ''}.`, { x: ship.x, y: ship.y, shipId: ship.id });
}

/** SIM system: drive every pirate — hunt, chase, fight, or raid a port for provisions. */
export function piracy(world, h) {
  const t = world.rules;
  let sunk = false;
  for (const ship of world.ships) {
    if (!ship.pirate || ship._sunk) continue;
    const speed = (ship.speed || t.SHIP_SPEED) * t.PIRATE_SPEED_MULT; // per-hull (a captured galleon is slow)

    // Between raids a pirate lies low with its loot (a cooldown) — no fresh fights, just roams.
    const resting = world.simTime < (ship._huntCd || 0);
    let prey = (!resting && ship._prey) ? world.ships.find((s) => s.id === ship._prey && !s.pirate && !s._sunk) : null;
    if (!resting && (!prey || dist(ship, prey) > t.PIRATE_HUNT_RANGE)) { prey = nearestPrey(world, ship); ship._prey = prey ? prey.id : null; }

    if (prey) {
      if (dist(ship, prey) <= t.PIRATE_COMBAT_RANGE) { resolveCombat(world, ship, prey); ship._prey = null; }
      else if (sail(world, ship, prey.x, prey.y, speed, h) === 'sunk') sunk = true; // ran down at sea
      continue;
    }

    // No prey in sight. Starving + near a port → raid it. Otherwise roam the hunting grounds.
    const isle = nearestIsland(world, ship);
    if ((ship.cargo.Food || 0) < t.CREW_FOOD_PER_DAY && isle && dist(ship, isle) <= t.PIRATE_RAID_RANGE
        && world.simTime >= (ship._raidCd || 0) && world.simTime >= (isle._raidCd || 0)) {
      raidIsland(world, ship, isle);
    } else if (isle) {
      if (sail(world, ship, isle.x, isle.y, speed, h) === 'sunk') sunk = true;
    }
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}

function sail(world, ship, tx, ty, speed, h) {
  const heading = Math.atan2(ty - ship.y, tx - ship.x);
  const eff = speed * windMult(world, heading, skill01(ship.captain, world.rules));
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  moveToward(ship, tx, ty, eff, h);
  return 'sailing';
}

/** Nearest merchant (non-pirate, at sea) within the hunt range — the fatter the prize the better. */
function nearestPrey(world, ship) {
  const t = world.rules;
  let best = null, bestScore = -Infinity;
  for (const s of world.ships) {
    if (s.pirate || s._sunk || s.state === 'idle' || s.state === 'trading') continue; // ships in port are safe
    const d = dist(ship, s);
    if (d > t.PIRATE_HUNT_RANGE) continue;
    const prize = (s.cargo[GOLD] || 0) + cargoUnits(s) * 10; // rough worth of the haul
    const score = prize - d * 2; // near + rich preferred
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function nearestIsland(world, ship) {
  let best = null, bestD = Infinity;
  for (const p of world.islands) { const d = dist(ship, p); if (d < bestD) { bestD = d; best = p; } }
  return best;
}

const burn = (ship, amt) => { ship.cargo.Weapons = Math.max(0, (ship.cargo.Weapons || 0) - amt); };

/** A boarding action. Strength (skill + morale + guns) sets the odds; both sides expend weapons
 *  (the loser more), the victor plunders, and the beaten merchant is sunk or flees stripped. */
function resolveCombat(world, pirate, victim) {
  const t = world.rules;
  pirate._huntCd = world.simTime + t.PIRATE_HUNT_COOLDOWN; // lie low with the spoils before the next raid
  const sP = combatStrength(world, pirate), sV = combatStrength(world, victim);
  const pirateWins = streamFloat(world, 'combat') < sP / (sP + sV);
  burn(pirate, t.COMBAT_WEAPON_BURN * (pirateWins ? 0.6 : 1.2)); // guns spent in the fight — a sink
  burn(victim, t.COMBAT_WEAPON_BURN * (pirateWins ? 1.2 : 0.6));

  if (pirateWins) {
    const loot = plunder(world, pirate, victim);
    pirate.morale = Math.min(1, (pirate.morale || 0.6) + t.PIRATE_MORALE_PLUNDER);
    markDanger(world, victim.x, victim.y, 'plunder');           // these waters are now feared
    postBounty(world, pirate, victim.homeId, 'plunder');        // the robbed ship's home wants blood
    const sinks = streamFloat(world, 'combat') < t.PIRATE_SINK_ON_LOSS;
    logEvent(world, 'plunder', `${pirate.name} ran down ${victim.name || 'a merchant'} — Capt. ${pirate.captain.name} took ${loot.goods} cargo and ${loot.gold}g${sinks ? ', then put her under.' : '; she fled home stripped.'}`, { x: victim.x, y: victim.y, shipId: pirate.id });
    if (sinks) { victim._sunk = true; }
    else { // limp home empty, the crew shaken
      victim.morale = Math.max(0, (victim.morale != null ? victim.morale : 0.5) - 0.2);
      const home = world.islandsById.get(victim.homeId);
      victim.voyage = { reason: 'flee', stops: [], index: 0 };
      victim.leg = null; victim.legIdx = 0;
      victim.targetX = home ? home.x : victim.x; victim.targetY = home ? home.y : victim.y;
      victim.state = 'inbound';
    }
  } else {
    victim.morale = Math.min(1, (victim.morale != null ? victim.morale : 0.5) + 0.05);
    pirate.morale = Math.max(0, (pirate.morale || 0.6) - 0.15);
    // A well-armed merchant can cripple its attacker — pirates that pick the wrong fight die.
    if (streamFloat(world, 'combat') < t.PIRATE_SINK_ON_FEND) {
      pirate._sunk = true;
      const paid = payBounty(world, pirate, victim.homeId); // the merchant's home claims the reward
      logEvent(world, 'fended', `${victim.name || 'A merchant'} fought off ${pirate.name} and sent her to the bottom — Capt. ${victim.captain ? victim.captain.name : 'the master'}'s guns won the day${paid ? ` (${paid}g bounty claimed)` : ''}.`, { x: victim.x, y: victim.y, shipId: victim.id });
    } else {
      logEvent(world, 'fended', `${victim.name || 'A merchant'} fought off ${pirate.name} — Capt. ${victim.captain ? victim.captain.name : 'the master'}'s guns drove the pirates back.`, { x: victim.x, y: victim.y, shipId: victim.id });
    }
  }
}

/** Strip a beaten merchant: all its coin, then its cargo (food first — pirates must eat) into the
 *  pirate's hold, up to what will fit. Returns rough {goods, gold} for the chronicle. */
function plunder(world, pirate, victim) {
  const gpu = world.rules.GOLD_PER_CARGO_UNIT;
  const gold = Math.round(victim.cargo[GOLD] || 0);
  transfer(victim.cargo, GOLD, pirate.cargo, GOLD, victim.cargo[GOLD] || 0);
  let goods = 0;
  const keys = Object.keys(victim.cargo).sort((a, b) => (a === 'Food' ? -1 : b === 'Food' ? 1 : 0));
  for (const g of keys) {
    if (g === GOLD || g === PEOPLE) continue;
    const space = Math.max(0, pirate.capacity - cargoUnits(pirate, gpu));
    const take = Math.min(victim.cargo[g] || 0, space);
    if (take > 0.5) goods += transfer(victim.cargo, g, pirate.cargo, g, take);
  }
  return { goods: Math.round(goods), gold };
}

/** A coastal raid: a starving pirate carries off a port's food and coin (a hit to its loyalty),
 *  which feeds the crew but stokes hardship on the island (→ more famine, unrest, rebellion). */
function raidIsland(world, pirate, island) {
  const t = world.rules;
  island._raidCd = world.simTime + t.PIRATE_RAID_ISLAND_CD; // the port musters its defences afterward
  pirate._raidCd = world.simTime + 60;
  // Raiding a port is dangerous — its guns and mob can send the raider to the bottom.
  if (streamFloat(world, 'combat') < t.PIRATE_RAID_RISK) {
    pirate._sunk = true;
    const paid = payBounty(world, pirate, island.id); // the port claims the reward on its own defence
    logEvent(world, 'raidfail', `${island.name} beat off a raid by ${pirate.name} and sank her at the quay${paid ? ` (${paid}g bounty claimed)` : ''}.`, { islandId: island.id, shipId: pirate.id });
    return;
  }
  const food = Math.min(t.PIRATE_RAID_FOOD, island.stock.Food || 0);
  transfer(island.stock, 'Food', pirate.cargo, 'Food', food);
  const gold = Math.floor((island.gold || 0) * t.PIRATE_RAID_GOLD_FRAC);
  transfer(island, 'gold', pirate.cargo, GOLD, gold);
  if (island.loyalty != null) island.loyalty = Math.max(0, island.loyalty - t.PIRATE_RAID_LOYALTY_HIT);
  pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.15);
  markDanger(world, island.x, island.y, 'raid');       // a sacked port's waters are the most feared
  postBounty(world, pirate, island.id, 'raid');        // and it puts a price on the raider's head
  logEvent(world, 'raid', `${pirate.name} raided ${island.name} — Capt. ${pirate.captain.name} carried off ${Math.round(food)} food and ${gold}g.`, { islandId: island.id, shipId: pirate.id });
}
