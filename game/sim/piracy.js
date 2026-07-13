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
import { makePirateCaptain, skill01, awardCombatXp } from './captains.js';
import { windMult } from './wind.js';
import { markDanger, postBounty, payBounty } from './bounty.js';
import { computeFleetByHome } from './fleet.js';
import { nearestIsland as gridNearestIsland, buildShipGrid, eachShipInRange, nearestShip } from './grid.js';
import { orbitPoint, orbitStep, orbitDir, awayPoint } from './steering.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Record what a ship is doing right now, for the info panel's activity line. k is a short activity key,
 *  id the island/ship it concerns (or null). Mutates a reused object so it makes no per-tick garbage. */
export function setAct(s, k, id) {
  if (!s._act) s._act = { k, id: id || null };
  else { s._act.k = k; s._act.id = id || null; }
}

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

/** SIM system: drive every pirate — hunt and fight prey, run from a hunter, blockade a port, or make
 *  for a haven to victual and fence. What a pirate DOES is shaped by its captain's character (bold /
 *  timid / wandering / greedy), so no two raiders behave alike. */
export function piracy(world, h) {
  const t = world.rules;
  computeFleetByHome(world); // fresh per-home census for maybeSink's last-ship guard (O(S))
  // Havens are few and change slowly; scan a per-substep haven list (built O(N) once) instead of
  // sweeping all N islands per pirate. Preserves world.islands order → same nearest tie-break.
  const havenList = world.islands.filter((i) => i.haven);
  // Prey (non-pirate ships) are fixed for this pass — only `ship`/`antipiracy` move them, and both
  // ran / run outside piracy — so one O(S) grid replaces the per-pirate full-fleet prey scans (the
  // O(P·S) walls in nearestPrey/nearestSeaMerchant). A by-id map turns the per-pirate `_prey`
  // re-lookup from an O(S) find into O(1). Both are rebuilt fresh each substep (ships move).
  world._merchGrid = buildShipGrid(world, world.ships.filter((s) => !s.pirate && !s._sunk));
  world._shipsById = new Map(world.ships.map((s) => [s.id, s]));
  // Privateers hunt pirates; a timid raider needs to see one bearing down to run. Few in number and
  // fixed for this pass (antipiracy runs later), so one small grid covers the flee check.
  const privGrid = buildShipGrid(world, world.ships.filter((s) => s.privateer && !s._sunk));
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  let sunk = false;
  for (const ship of world.ships) {
    if (!ship.pirate || ship._sunk) continue;
    const speed = (ship.speed || t.SHIP_SPEED) * t.PIRATE_SPEED_MULT; // per-hull (a captured galleon is slow)
    const tr = (ship.captain && ship.captain.traits) || {};
    const bold = (tr.boldness != null ? tr.boldness : 0.5) >= t.PIRATE_BOLD_TRAIT;
    const timid = (tr.boldness != null ? tr.boldness : 0.5) <= t.PIRATE_TIMID_TRAIT;
    const wander = (tr.wanderlust != null ? tr.wanderlust : 0.5) >= t.PIRATE_WANDER_TRAIT;
    const minPrize = (tr.greed != null ? tr.greed : 0.5) >= 0.6 ? t.PIRATE_GREED_MIN_PRIZE : 0; // the greedy scorn a lean hull
    // EXPERIENCE shapes the hunt: a seasoned raider's nose for a prize reaches farther (a green hand
    // engages only what stumbles across its bow); a veteran also presses a defence a novice would flinch
    // from. Neutral at average skill, so it adds spread without shifting the baseline.
    const skill = skill01(ship.captain, t);
    const reach = 1 + (skill - 0.5) * (t.PIRATE_SKILL_REACH || 0);

    // A TIMID raider that spots a privateer closing in BREAKS OFF and runs — no prize is worth the noose.
    if (timid) {
      const hunter = nearestShip(privGrid, ship.x, ship.y, null, t.PIRATE_FLEE_PRIVATEER_RANGE);
      if (hunter) {
        ship._blockadeId = null; ship._prey = null;
        setAct(ship, 'flee', hunter.id);
        const away = awayPoint(hunter.x, hunter.y, ship.x, ship.y, t.PIRATE_HUNT_RANGE);
        if (sail(world, ship, away.x, away.y, speed, h) === 'sunk') sunk = true;
        continue;
      }
    }

    // DEFEND THE HAVEN — a raider lying off its stronghold turns on a privateer come to assault it (home and
    // larder are worth a fight). With the privateer now clearing this screen before it bombards
    // (antipiracy.js), this turns the old "two lines facing off, nobody engaging" into a real battle. A
    // pirate that can trade blows CHARGES to board; one plainly outgunned SHADOWS the besieger at a menacing
    // distance — ready to pounce if its guns run dry or a consort closes — rather than throwing itself away.
    // Only the BOLD press the attack (pirates skew bold, so most do).
    const den = nearestHaven(havenList, ship);
    if (den && dist(ship, den) <= t.HAVEN_DEFEND_RANGE) {
      const besieger = nearestShip(privGrid, den.x, den.y, null, t.HAVEN_DEFEND_RANGE);
      if (besieger) {
        ship._blockadeId = null;
        setAct(ship, 'defend', den.id);
        const oddsBar = t.PIRATE_DEFEND_ODDS - (skill - 0.5) * (t.PIRATE_DEFEND_SKILL_EDGE || 0); // the seasoned press closer fights
        const matched = combatStrength(world, ship) >= combatStrength(world, besieger) * oddsBar;
        if (bold && matched) {
          ship._prey = besieger.id;
          if (dist(ship, besieger) <= t.PIRATE_COMBAT_RANGE) {
            if (world.simTime >= (ship._fightCd || 0) && skirmish(world, ship, besieger)) sunk = true;
          } else if (sail(world, ship, besieger.x, besieger.y, speed, h) === 'sunk') sunk = true;
        } else { // outmatched or cautious: shadow the hunter, keeping the haven's waters contested
          ship._prey = null;
          const radius = t.PIRATE_BLOCKADE_RANGE;
          const p = orbitPoint(besieger.x, besieger.y, ship.x, ship.y, radius, orbitDir(ship.id), orbitStep(speed, radius, h));
          if (sail(world, ship, p.x, p.y, speed, h) === 'sunk') sunk = true;
        }
        continue;
      }
    }

    // Between raids a pirate lies low with its loot (a cooldown) — no fresh fights, just roams. While
    // HOLDING a blockade its prey range shrinks to the snap (it stays on station and pounces on ships
    // that come close, rather than chasing distant traffic and abandoning the port); a rover ranges wide.
    const resting = world.simTime < (ship._huntCd || 0);
    const holding = !wander && ship._blockadeId && world.simTime < (ship._blockadeUntil || 0);
    const preyRange = (holding ? t.PIRATE_BLOCKADE_SNAP : t.PIRATE_HUNT_RANGE) * reach;
    let prey = null;
    if (!resting && ship._prey) { const p = world._shipsById.get(ship._prey); if (p && !p.pirate && !p._sunk && dist(ship, p) <= preyRange) prey = p; }
    if (!resting && !prey) { prey = nearestPrey(world, ship, preyRange, minPrize); ship._prey = prey ? prey.id : null; }

    if (prey) {
      setAct(ship, 'hunt', prey.id);
      if (dist(ship, prey) <= t.PIRATE_COMBAT_RANGE) { resolveCombat(world, ship, prey); ship._prey = null; }
      else if (sail(world, ship, prey.x, prey.y, speed, h) === 'sunk') sunk = true; // ran down at sea
      continue;
    }

    // No prey in sight. A hungry or plunder-laden pirate makes for its nearest HAVEN to victual and
    // fence its loot (havens.js does the transfer once it's in range) — a base is what lets a pirate
    // survive and a haven grow rich.
    const hungry = (ship.cargo.Food || 0) < t.CREW_FOOD_PER_DAY;
    const laden = cargoUnits(ship) > ship.capacity * 0.5 || (ship.cargo[GOLD] || 0) > 150;
    const haven = nearestHaven(havenList, ship);
    if (haven && (hungry || laden)) {
      ship._blockadeId = null;
      setAct(ship, 'resupply', haven.id);
      if (dist(ship, haven) > t.HAVEN_RESUPPLY_RANGE * 0.5 && sail(world, ship, haven.x, haven.y, speed, h) === 'sunk') sunk = true;
      // else: loitering in the haven's roads — resupply/fence happens in havens.js this same tick
      continue;
    }

    const isle = gridNearestIsland(world, ship.x, ship.y);
    // A BOLD raider raids a port when merely peckish; a cautious one only when truly starving (raiding
    // is dangerous, so the timid would sooner hunt or slink to a haven).
    const willRaid = hungry && (bold || (ship.cargo.Food || 0) <= 0);
    if (willRaid && isle && dist(ship, isle) <= t.PIRATE_RAID_RANGE
        && world.simTime >= (ship._raidCd || 0) && world.simTime >= (isle._raidCd || 0)) {
      ship._blockadeId = null;
      setAct(ship, 'raid', isle.id);
      raidIsland(world, ship, isle);
      continue;
    }
    if (willRaid && isle) { // starving with no haven to run to: close on a port to raid it (the crew must eat)
      ship._blockadeId = null;
      setAct(ship, 'raid', isle.id);
      if (sail(world, ship, isle.x, isle.y, speed, h) === 'sunk') sunk = true;
      continue;
    }

    // Fed, no prey: a WANDERER roves the lanes for wherever trade is moving; everyone else BLOCKADES a
    // port — orbiting its approaches (never camping the wharf, which would pin the whole fleet in
    // harbour and gridlock trade), chasing anything that ventures close, and stoking the fear of these
    // waters so the law takes notice. A wanderer with no trade in sight falls through to blockade too.
    const seaPrey = wander ? nearestSeaMerchant(world, ship) : null;
    if (seaPrey) {
      ship._blockadeId = null;
      setAct(ship, 'hunt', seaPrey.id);
      if (sail(world, ship, seaPrey.x, seaPrey.y, speed, h) === 'sunk') sunk = true;
    } else if (isle) {
      if (!ship._blockadeId || world.simTime >= (ship._blockadeUntil || 0) || !world.islandsById.has(ship._blockadeId)) {
        ship._blockadeId = isle.id;
        ship._blockadeUntil = world.simTime + t.PIRATE_BLOCKADE_DAYS * t.SIM_DAY_SECONDS;
      }
      const port = world.islandsById.get(ship._blockadeId) || isle;
      setAct(ship, 'blockade', port.id);
      if (ship._blockadeDay !== day) { // once a day, word of the blockade makes these waters feared (draws privateers)
        ship._blockadeDay = day;
        port.danger = Math.min(1, (port.danger || 0) + t.PIRATE_BLOCKADE_DANGER);
      }
      // Bold blockaders choke in tight; the timid keep a looser noose out in the approaches.
      const radius = t.PIRATE_BLOCKADE_RANGE * (bold ? 0.8 : timid ? 1.25 : 1);
      const p = orbitPoint(port.x, port.y, ship.x, ship.y, radius, orbitDir(ship.id), orbitStep(speed, radius, h));
      if (sail(world, ship, p.x, p.y, speed, h) === 'sunk') sunk = true;
    } else { // no port anywhere in reach (open ocean) — drift toward any moving trade
      const target = nearestSeaMerchant(world, ship);
      setAct(ship, target ? 'hunt' : 'rove', target ? target.id : null);
      if (target && sail(world, ship, target.x, target.y, speed, h) === 'sunk') sunk = true;
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

/** Nearest merchant (non-pirate, at sea) within `range` — the fatter the prize the better. Visits
 *  only the ships the merchant grid holds within range (grid excludes pirates); keeps the exact
 *  in-port skip and prize scoring. `minPrize` lets a greedy captain scorn a near-empty hull. */
function nearestPrey(world, ship, range, minPrize = 0) {
  let best = null, bestScore = -Infinity;
  eachShipInRange(world._merchGrid, ship.x, ship.y, range, (s) => {
    if (s._sunk || s.state === 'idle' || s.state === 'trading') return; // ships in port are safe
    const prize = (s.cargo[GOLD] || 0) + cargoUnits(s) * 10; // rough worth of the haul
    if (prize < minPrize) return; // not worth a greedy captain's powder
    const score = prize - dist(ship, s) * 2; // near + rich preferred
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return best;
}

/** Nearest merchant already UNDER WAY (outbound/inbound) — a pirate's real prey lives on the lanes,
 *  not in port (ships in harbour are safe and are skipped by nearestPrey). No range cap: it gives a
 *  prowling pirate a heading toward wherever trade is actually moving. Expanding-ring nearest over
 *  the merchant grid (excludes pirates); same lowest-index tie-break as the old first-min scan. */
function nearestSeaMerchant(world, ship) {
  return nearestShip(world._merchGrid, ship.x, ship.y,
    (s) => !s.privateer && !s._sunk && (s.state === 'outbound' || s.state === 'inbound'));
}

/** Nearest pirate HAVEN — a stronghold a raider can run to for food and to fence loot (havens.js).
 *  Scans the pre-filtered per-substep haven list (built once in piracy()), which preserves
 *  world.islands order so the first-min tie-break is unchanged. */
function nearestHaven(havens, ship) {
  let best = null, bestD = Infinity;
  for (const p of havens) { const d = dist(ship, p); if (d < bestD) { bestD = d; best = p; } }
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
    awardCombatXp(pirate.captain, t.XP_PER_PRIZE); // a prize taken — the captain's legend (and skill) grows
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

/** A HAVEN-DEFENCE skirmish: a pirate trades broadsides with a besieging privateer — a fight for the den,
 *  not a robbery (no plunder). Symmetric weapon burn; the loser may go down. Paced by _fightCd on BOTH ships
 *  (COMBAT_ROUND_SEC) so a duel plays out over several seconds instead of resolving in a single substep —
 *  which is what makes a siege read as a running battle — and so antipiracy's hunt doesn't double-resolve
 *  the same pair this same tick. Returns true if a hull was sunk. */
function skirmish(world, pirate, priv) {
  const t = world.rules;
  const round = t.COMBAT_ROUND_SEC || 1.2;
  pirate._fightCd = world.simTime + round;
  priv._fightCd = world.simTime + round;
  const sP = combatStrength(world, pirate), sV = combatStrength(world, priv);
  const pirateWins = streamFloat(world, 'combat') < sP / (sP + sV);
  burn(pirate, t.COMBAT_WEAPON_BURN * (pirateWins ? 0.6 : 1.2));
  burn(priv, t.COMBAT_WEAPON_BURN * (pirateWins ? 1.2 : 0.6));
  if (pirateWins) {
    pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.08);
    priv.morale = Math.max(0, (priv.morale || 0.7) - 0.12);
    if (streamFloat(world, 'combat') < t.PRIVATEER_LOSS_SINK) {
      priv._sunk = true;
      awardCombatXp(pirate.captain, t.XP_PER_DEFENSE); // drove off the hunter — a defender's renown
      logEvent(world, 'hunterlost', `${priv.name || 'A privateer'} was beaten off a pirate haven and sunk by ${pirate.name || 'a raider'}.`, { x: priv.x, y: priv.y, shipId: pirate.id });
      return true;
    }
  } else {
    priv.morale = Math.min(1, (priv.morale || 0.7) + 0.06);
    pirate.morale = Math.max(0, (pirate.morale || 0.6) - 0.12);
    if (streamFloat(world, 'combat') < t.PIRATE_SINK_ON_FEND) {
      pirate._sunk = true;
      awardCombatXp(priv.captain, t.XP_PER_KILL); // cut down a raider defending its den
      const paid = payBounty(world, pirate, priv.homeId);
      logEvent(world, 'hunted', `${priv.name || 'A privateer'} cut down ${pirate.name || 'a raider'} defending its haven${paid ? ` — ${paid}g bounty claimed` : ''}.`, { x: pirate.x, y: pirate.y, shipId: priv.id });
      return true;
    }
  }
  return false;
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
  awardCombatXp(pirate.captain, t.XP_PER_PRIZE); // a port sacked — hard-won experience
  pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.15);
  markDanger(world, island.x, island.y, 'raid');       // a sacked port's waters are the most feared
  postBounty(world, pirate, island.id, 'raid');        // and it puts a price on the raider's head
  logEvent(world, 'raid', `${pirate.name} raided ${island.name} — Capt. ${pirate.captain.name} carried off ${Math.round(food)} food and ${gold}g.`, { islandId: island.id, shipId: pirate.id });
}
