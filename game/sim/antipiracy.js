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
import { makeCaptain, skill01, awardCombatXp } from './captains.js';
import { windMult } from './wind.js';
import { combatStrength, setAct } from './piracy.js';
import { foodDaysAboard } from './crew.js';
import { payBounty } from './bounty.js';
import { assaultHaven } from './havens.js';
import { computeFleetByHome, fleetAt } from './fleet.js';
import { buildShipGrid, anyShipInRange, nearestShip } from './grid.js';
import { orbitPoint, orbitStep, orbitDir } from './steering.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Local straight-line move (can't import ship.js — that would cycle). Returns arrival. Faces the travel
 *  direction even on the arrival snap, so an orbiting patroller (whose next point sits ~one step ahead
 *  every tick) points along its circle instead of freezing on a stale heading. */
function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y, d = Math.hypot(dx, dy), step = speed * h;
  if (d > 1e-6) ship.heading = Math.atan2(dy, dx);
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
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
  computeFleetByHome(world); // per-home privateer counts + fresh census for maybeSink (O(S))
  let sunk = false;

  // Peace lets fear fade from the waters (danger decays as attacks stop).
  for (const isl of world.islands) {
    if (isl.danger > 0) isl.danger = Math.max(0, isl.danger - t.DANGER_DECAY * dDay);
  }

  const pirates = world.ships.filter((s) => s.pirate && !s._sunk);
  const havenList = world.islands.filter((i) => i.haven);
  // Pirates are fixed for this whole pass (only `piracy`, already run, moves them), so one O(P) grid
  // replaces the per-island pirate scan in `threatened` (the O(N·P) wall) and the per-privateer
  // `nearestPirate` scan. Havens are few → the haven proximity test stays a small list scan.
  const pirateGrid = buildShipGrid(world, pirates);
  const threatened = (isl) => anyShipInRange(pirateGrid, isl.x, isl.y, t.PRIVATEER_THREAT_RANGE)
    || havenList.some((hv) => hv !== isl && dist(hv, isl) < t.PRIVATEER_THREAT_RANGE); // a nearby haven is a standing threat

  // The navy the economy will bear: PROPORTIONAL to the live threat (so many hunters per pirate at
  // large + per haven under siege), under a hard fleet-fraction ceiling. Beyond this budget no port
  // commissions another and the surplus stands down — so the navy doesn't balloon to the cap and idle
  // there once piracy is crushed (which over-crushed piracy AND drained the trading fleet).
  const threatBudget = Math.ceil(pirates.length * t.PRIVATEER_PER_PIRATE + havenList.length * t.PRIVATEER_PER_HAVEN);
  let activePriv = privateerCount(world);

  // Commission new privateers (throttled globally so it doesn't churn the fleet in one tick).
  if ((pirates.length > 0 || havenList.length > 0)
      && activePriv < threatBudget
      && activePriv < Math.max(1, world.ships.length * t.PRIVATEER_MAX_FRAC)) {
    for (const isl of world.islands) {
      if (isl.haven) continue; // a haven fields cutthroats, not privateers
      if (world.simTime < (isl._privCd || 0)) continue;
      // A pirate or a nearby haven must actually threaten these waters — the trigger is the threat
      // itself, not the island's own damage, so a wealthy weapons-stocking port can protect a lane
      // it cares about (or move against a den down the coast) even before it's personally sacked.
      if (!threatened(isl)) continue;
      // MEANS (nothing free): keep a treasury reserve after paying wages, and have GUNS in the
      // armoury it had to trade for — so only a solvent, armed port can field a hunter.
      if ((isl.gold || 0) < t.PRIVATEER_TREASURY_MIN + t.PRIVATEER_COMMISSION_COST) continue;
      if ((isl.stock.Weapons || 0) < t.PRIVATEER_WEAPONS_MIN) continue;
      const owned = fleetAt(world, isl.id).privateer;
      if (owned >= t.PRIVATEER_MAX_PER_ISLAND) continue;
      const hull = world.ships.find((s) => s.homeId === isl.id && !s.pirate && !s.privateer
        && s.state === 'idle' && !s.voyage && (world.agents[s.ownerId] || {}).kind === 'npc');
      if (!hull) continue;
      commissionPrivateer(world, isl, hull);
      isl._privCd = world.simTime + t.PRIVATEER_COOLDOWN;
      activePriv++;
      break; // at most one commission per tick — keeps the response measured
    }
  }

  // Drive every privateer: hunt, fight, patrol, or stand down.
  for (const priv of world.ships) {
    if (!priv.privateer || priv._sunk) continue;
    const speed = (priv.speed || t.SHIP_SPEED) * t.PRIVATEER_SPEED_MULT; // per-hull (a sloop privateer is fleet)
    const home = world.islandsById.get(priv.homeId);
    // The port this privateer guards (the one that commissioned it) — the waters it watches and, with
    // no pirate to chase, patrols. Falls back to home for a hand-commissioned hull with no _guard.
    const guard = world.islandsById.get(priv._guard) || home;

    // EXPERIENCE widens a hunter's reach: a seasoned captain watches and runs down threats over a wider
    // sea (a keen lookout and a nose for a raider); a green one only reacts to what comes close. Neutral
    // at average skill, so it adds spread without shifting the baseline navy behaviour.
    const skill = skill01(priv.captain, t);
    const reach = 1 + (skill - 0.5) * (t.PRIVATEER_SKILL_REACH || 0);

    // Acquire targets FIRST, so stand-down can tell a needed hull from a surplus one. Nearest haven,
    // then a pirate — one bearing down on the privateer OR one menacing the guarded port (a wider WATCH
    // than its raw hunt range: it actively watches its charge, not just reacting at gun-range).
    let haven = null, hd = Infinity;
    for (const hv of havenList) { const d = dist(priv, hv); if (d < hd) { hd = d; haven = hv; } }
    let prey = priv._prey ? pirates.find((p) => p.id === priv._prey && !p._sunk) : null;
    if (!prey || dist(priv, prey) > t.PRIVATEER_HUNT_RANGE * reach) {
      prey = nearestShip(pirateGrid, priv.x, priv.y, null, t.PRIVATEER_HUNT_RANGE * reach)
          || (guard && nearestShip(pirateGrid, guard.x, guard.y, null, t.PRIVATEER_WATCH_RANGE * reach));
      priv._prey = prey ? prey.id : null;
    }
    // Captain character: a cautious privateer won't charge a raider it can't beat — it holds its patrol
    // and SHADOWS, waiting for the odds to shift (the pirate weakened in a fight, or a consort arriving);
    // the bold press any fight. (Privateers are usually the stronger, so this only bites against a
    // heavily-gunned pirate — exactly when discretion is the better part of valour.)
    const bold = ((priv.captain && priv.captain.traits && priv.captain.traits.boldness) != null
      ? priv.captain.traits.boldness : 0.5) >= t.PRIVATEER_BOLD_TRAIT;
    const oddsBar = t.PRIVATEER_TIMID_ODDS - (skill - 0.5) * (t.PRIVATEER_SKILL_NERVE || 0); // veterans press harder odds
    if (prey && !bold && combatStrength(world, priv) < combatStrength(world, prey) * oddsBar) prey = null;
    const preyDist = prey ? dist(priv, prey) : Infinity;

    // Stand down (pay off the crew, back to honest trade) when the commission lapses, the seas are truly
    // clear (no pirates AND no havens), or this hull is SURPLUS — the navy already over-covers the threat
    // and it has nothing in reach. Surplus demobilisation shrinks a bloated navy back to the threat budget
    // instead of leaving dozens of hunters idling on the treasury after piracy is broken.
    const havenInReach = haven && hd <= t.PRIVATEER_WATCH_RANGE;
    const surplus = activePriv > threatBudget && !prey && !havenInReach;
    if (world.simTime >= (priv.privateerUntil || 0) || (pirates.length === 0 && havenList.length === 0) || surplus) {
      activePriv--; // one fewer effective hunter this tick — keep the budget/surplus test consistent
      setAct(priv, 'standdown', home ? home.id : null);
      if (home && moveToward(priv, home.x, home.y, speed, h)) standDown(world, priv, home);
      else if (!home) standDown(world, priv, null);
      continue;
    }

    // EMPTY LARDER — a hungry crew forces the hunter off station (siege or patrol) to victual at its guard
    // port, the same drastic action a starving pirate takes to a haven. It won't quit a foe already at
    // gun-range, but anything short of that yields to the empty stores (so a long siege can be broken by
    // provisions running out — the haven feeds its own defenders, the besieger must supply from afar).
    if (foodDaysAboard(world, priv) < t.PRIVATEER_RESUPPLY_DAYS && !(prey && preyDist <= t.PIRATE_COMBAT_RANGE)) {
      const larder = guard || home;
      setAct(priv, 'resupply', larder ? larder.id : null);
      if (larder && moveToward(priv, larder.x, larder.y, speed, h)) victualPrivateer(world, larder, priv);
      continue;
    }

    // A pirate lying within the haven's DEFENDED waters is its screen — cleared before the walls are
    // battered (no more parking off a den, bombarding once a day, and ignoring the raiders guarding it).
    const besieging = haven && hd <= t.HAVEN_SUPPRESS_RANGE;
    const defender = besieging && prey && dist(haven, prey) <= t.HAVEN_DEFEND_RANGE ? prey : null;

    if (prey && preyDist <= t.PIRATE_COMBAT_RANGE) {
      // A foe at gun-range is ALWAYS fought — even mid-bombardment. Paced by _fightCd (COMBAT_ROUND_SEC)
      // so the duel plays out over a few seconds instead of an instant kill: a running battle, not a
      // vanishing. The cadence also stops this hunt double-resolving a pair the pirate already skirmished.
      setAct(priv, 'hunt', prey.id);
      if (world.simTime >= (priv._fightCd || 0)) {
        priv._fightCd = world.simTime + (t.COMBAT_ROUND_SEC || 1.2);
        if (resolveHunt(world, priv, prey)) sunk = true;
        if (prey._sunk || priv._sunk) priv._prey = null;
      }
    } else if (defender) {
      // Run down the haven's screen before it can pound the siege line.
      setAct(priv, 'hunt', defender.id);
      if (sailHunter(world, priv, defender.x, defender.y, speed, h)) sunk = true;
    } else if (besieging) {
      // No defender close enough to matter — batter the walls (once/day; holds station otherwise).
      setAct(priv, 'assault', haven.id);
      if (assaultHaven(world, priv, haven) && priv._sunk) sunk = true;
    } else if (prey && (!haven || preyDist <= hd)) {
      // Chase a pirate — one near the guarded port, or nearer than a distant haven.
      setAct(priv, 'hunt', prey.id);
      if (sailHunter(world, priv, prey.x, prey.y, speed, h)) sunk = true;
    } else if (haven) {
      setAct(priv, 'assault', haven.id);
      if (sailHunter(world, priv, haven.x, haven.y, speed, h)) sunk = true; // bear down on a distant den
    } else if (guard) {
      // Patrol: circle the guarded port's approaches rather than mooring at the wharf, so it is
      // positioned to intercept the moment a raider ventures near — not reacting from a standstill.
      setAct(priv, 'patrol', guard.id);
      const p = orbitPoint(guard.x, guard.y, priv.x, priv.y, t.PRIVATEER_PATROL_RANGE, orbitDir(priv.id), orbitStep(speed, t.PRIVATEER_PATROL_RANGE, h));
      sailHunter(world, priv, p.x, p.y, speed, h);
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
  ship._guard = isl.id; // the port it was commissioned to protect — the waters it patrols
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

/** Victual a privateer from a friendly port's stores — FREE (the state feeds its own navy, the way a
 *  haven feeds its raiders). The hunger valve calls this when a starving hunter breaks off station; it
 *  tops up toward a full cruise's food and the fresh stores lift morale a touch. */
function victualPrivateer(world, port, priv) {
  const t = world.rules;
  const want = t.CREW_FOOD_PER_DAY * (t.PRIVATEER_COMMISSION_DAYS + 3) - (priv.cargo.Food || 0);
  const space = Math.max(0, priv.capacity - cargoUnits(priv, t.GOLD_PER_CARGO_UNIT));
  const load = Math.min(Math.max(0, want), port.stock.Food || 0, space);
  if (load >= 1) transfer(port.stock, 'Food', priv.cargo, 'Food', load);
  priv.morale = Math.min(1, (priv.morale || 0.7) + 0.05);
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
    awardCombatXp(priv.captain, t.XP_PER_KILL); // a pirate run down — the hunter's renown (and skill) grows
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

