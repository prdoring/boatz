// Ship factory + movement + the multi-stop VOYAGE state machine. A voyage loads a
// diversified basket at home, then visits each stop in order (selling/buying/dropping
// migrants), then returns home to unload. PURE. Every economic move goes through
// `transfer` (conserved); new ships spawn with 0 gold (no minting).

import { transfer, cargoUnits, capOf, GOLD, PEOPLE } from './resources.js';
import { bidAsk } from './pricing.js';
import { executeStop } from './trade.js';
import { maybeSink, shipDockDisease, logEvent, logEventThrottled } from './events.js';
import { observeAndGossip, beliefMid, currentDay } from './beliefs.js';
import { observeFacts, sightAtSea, routePeril } from './intel.js';
import { noteDeparture, noteReturn } from './voyages.js';
import { windMult, upwindness } from './wind.js';
import { makeCaptain, skill01, awardVoyageXp, awardSeamanshipXp, navProfile, defensiveArmTarget, rankUp } from './captains.js';
import { provisionCrew, deviationTarget } from './crew.js';
import { shipName } from './naming.js';
import { computeFleetByHome, fleetAt } from './fleet.js';
import { setAct, balanceOfForce } from './piracy.js';
import { steerAroundIslands, islandLandRadius } from './navigation.js';
import { rigMult, repairAtPort, juryRig, maybeHeaveToRepair, stowRepairKit, inDistress, renderAid, spareAboard } from './repair.js';
import { bumpRep } from './reputation.js';
import { streamFloat } from './rng.js';
import { buildShipGrid, anyShipInRange, countShipsInRange, eachShipInRange, nearestIsland as gridNearestIsland, nearestShip } from './grid.js';

/** The build a port chooses for a new hull, by its situation: a threatened port arms with a
 *  fighting BRIG, a wealthy hub hauls volume in a GALLEON, and a modest port runs a cheap, fast
 *  SLOOP. Gated by treasury (a galleon is a major investment) → richer ports field bigger fleets. */
export function chooseShipType(world, home) {
  const types = world.rules.SHIP_TYPES;
  if (!types) return world.rules.SHIP_DEFAULT_TYPE || 'ship';
  const gold = home.gold || 0;
  const danger = home.danger || 0;
  if (danger > 0.4 && gold >= types.brig.minTreasury) return 'brig';   // arm for dangerous waters
  if (gold >= types.galleon.minTreasury) return 'galleon';             // a rich hub hauls volume
  if (gold >= types.brig.minTreasury) return 'brig';
  return 'sloop';                                                      // cheap and quick
}

export function createShip(idNum, home, tuning, type = tuning.SHIP_DEFAULT_TYPE || 'ship') {
  const spec = (tuning.SHIP_TYPES && tuning.SHIP_TYPES[type]) || null;
  return {
    id: 's' + idNum,
    homeId: home.id,
    ownerId: 'npc',
    type,
    x: home.x, y: home.y, heading: 0,
    speed: spec ? spec.speed : tuning.SHIP_SPEED,
    capacity: spec ? spec.capacity : tuning.SHIP_CAPACITY,
    cargo: { Gold: tuning.START_SHIP_GOLD, People: 0, Food: tuning.CREW_FOOD_PER_DAY * tuning.PROVISION_DAYS }, // sail victualled
    state: 'idle',
    infected: false, // carries plague between ports (cleared on returning home)
    knows: {},       // price book carried between ports — { islandId: { good: { mid, day } } } (beliefs.js)
    captain: null,   // { name, xp } — assigned by the world/spawn (captains.js); skill drives wind decisions
    name: null,      // vessel name (naming.js), assigned alongside the captain
    voyage: null,
    targetX: home.x, targetY: home.y,
    leg: null,       // current course as waypoints [{x,y}…] ending at the destination (tacking = a dogleg)
    legIdx: 0,
    _waited: 0,      // seconds spent holding in port for a foul wind to shift
    dockTimer: 0,
    morale: tuning.MORALE_STEADY, // crew morale 0..1 (crew.js)
    hunger: 0,       // sim-days at zero food
    unrest: 0,       // sim-days morale has sat below the mutiny line
    uprising: null,  // { until } while dead-in-the-water in revolt
    _upCd: 0,        // simTime before which a new uprising can't start
    hull: 1,         // structural integrity 0..1 (repair.js) — combat HP + founder risk
    rig: 1,          // rigging/sails condition 0..1 — multiplies effective speed
    hullSound: 1,    // structural SOUNDNESS ceiling 0..1 — hull can be jury-rigged only up to this; erodes with damage, rebuilt only at a dry-dock
    rigSound: 1,     // rigging soundness ceiling 0..1 — same, for the rig
  };
}

/** Spawn a purchased ship at `home` with NO working capital (gold conserved). Its build reflects
 *  the port's situation (see chooseShipType) — so fleets diversify as ports prosper or come under
 *  threat — unless a specific `type` is given (e.g. an investment chosen on pre-spend wealth). */
export function spawnShip(world, home, type = chooseShipType(world, home)) {
  const s = createShip(world.nextEntityId++, home, world.rules, type);
  s.cargo.Gold = 0;
  s.captain = makeCaptain(world); // a fresh captain takes the new vessel
  s.name = shipName(world);
  world.ships.push(s);
  logEvent(world, 'launch', `${home.name} launched ${s.name} under Capt. ${s.captain.name}`, { islandId: home.id, shipId: s.id });
  return s;
}

/** Move toward (tx,ty). Returns true on arrival (snaps, guaranteed). Faces the travel direction even
 *  on the arrival snap — otherwise a hull that reaches its mark in one step (notably an ORBITING
 *  blockader/patroller, whose next point sits ~one step ahead every tick) keeps a stale heading and
 *  visibly points the wrong way while it slides around the circle. */
export function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y;
  const d = Math.hypot(dx, dy);
  const step = speed * h;
  if (d > 1e-6) ship.heading = Math.atan2(dy, dx);
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
  ship.x += (dx / d) * step;
  ship.y += (dy / d) * step;
  return false;
}

/** Plan the course from the ship to (tx,ty) as waypoints. A skilled captain facing a strong
 *  headwind TACKS — one visible dogleg whose two legs meet the wind at a broader, faster angle
 *  than sailing dead into it — instead of crawling straight upwind like a novice. */
function planLegTo(world, ship, tx, ty) {
  const t = world.rules;
  const dx = tx - ship.x, dy = ty - ship.y;
  const legLen = Math.hypot(dx, dy);
  if (legLen < 1) return [{ x: tx, y: ty }];
  const skill = skill01(ship.captain, t, 'sea');
  const bearing = Math.atan2(dy, dx);
  if (skill >= t.TACK_MIN_SKILL && upwindness(world, bearing) >= t.TACK_THRESHOLD) {
    const mx = ship.x + dx * 0.5, my = ship.y + dy * 0.5;
    const px = -dy / legLen, py = dx / legLen;                 // unit perpendicular to the direct route
    const side = (parseInt(ship.id.slice(1), 10) % 2) ? 1 : -1; // deterministic per ship; varies which way it tacks
    const off = Math.min(legLen * t.TACK_OFFSET_FRAC, 1500) * side;
    return [{ x: mx + px * off, y: my + py * off }, { x: tx, y: ty }];
  }
  return [{ x: tx, y: ty }];
}

/** Set the ship on a fresh course to (tx,ty), planning any tack. */
function startLeg(world, ship, tx, ty) {
  ship.leg = planLegTo(world, ship, tx, ty);
  ship.legIdx = 0;
  ship.targetX = ship.leg[0].x;
  ship.targetY = ship.leg[0].y;
}

function aimAtStop(world, ship) {
  const stop = ship.voyage.stops[ship.voyage.index];
  const p = world.islandsById.get(stop.islandId);
  startLeg(world, ship, p.x, p.y);
}

/** Advance the ship along its course one substep, at wind- and skill-scaled speed. Returns
 *  'sunk' (foundered), 'arrived' (reached the final waypoint), or 'sailing'. Sink odds ride on
 *  the ACTUAL distance covered, so a longer tacking path costs proportionally more risk. */
function sail(world, ship, h) {
  const t = world.rules;
  sightAtSea(world, ship); // the captain sees the ports it passes firsthand — fresher than home's orders
  const skill = skill01(ship.captain, t, 'sea');
  const aim = steerAroundIslands(world, ship, ship.targetX, ship.targetY); // steer clear of land in the way
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * rigMult(ship, t) * windMult(world, heading, skill); // per-hull speed × rig condition × wind
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  if (moveToward(ship, aim.x, aim.y, eff, h)) {
    if (aim.deflected) return 'sailing'; // reached only a way-round point, not the real target — press on
    if (ship.leg && ship.legIdx < ship.leg.length - 1) { // reached a tack corner — turn onto the next leg
      const p = ship.leg[++ship.legIdx];
      ship.targetX = p.x; ship.targetY = p.y;
      return 'sailing';
    }
    return 'arrived';
  }
  return 'sailing';
}

/** Crowd on sail and run for `island` (evading a pirate) — a panicked dash, no leg tracking. On making the
 *  harbour the ship DOCKS to shelter (`_sheltered`): the renderer berths her and she rides out the danger in
 *  port (shelterOrFlee holds her there), instead of heaving-to off the wharf and darting back out the moment
 *  the raider drifts off — the "fleeing ship bouncing around the port" bug. A shot rig can't outrun trouble. */
function panicRun(world, ship, island, h) {
  const t = world.rules;
  const harbour = islandLandRadius(island, t) + (t.SHIP_ISLAND_CLEARANCE || 0); // the wharf's edge — close enough to berth
  if (Math.hypot(island.x - ship.x, island.y - ship.y) <= harbour) {
    ship._sheltered = true; ship._shelterAt = island.id; ship._fleeing = false; // made port — DOCK and shelter
    provisionCrew(world, island, ship); // safe in harbour — victual up
    repairAtPort(world, island, ship);  // …and patch battle/storm damage from the yard
    return 'fleeing';
  }
  const aim = steerAroundIslands(world, ship, island.x, island.y); // even a panicked dash rounds land in the way
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * rigMult(ship, t) * t.PIRATE_PANIC_MULT * windMult(world, heading, skill01(ship.captain, t, 'sea')); // crew rows for their lives (a shot rig can't outrun)
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  moveToward(ship, aim.x, aim.y, eff, h);
  return 'fleeing';
}

/** Evade pirates: either RUN for a refuge, or — once DOCKED there (panicRun) — ride out the danger IN PORT
 *  until the coast is clear for a sustained spell, THEN resume the voyage. Crucially a docked ship does NOT
 *  dash to a fresh port each time a raider drifts past the disengage range, nor weigh anchor on the first
 *  clear tick — that flip-flopping IS the bounce. A port is the safest place; she simply stays put under its
 *  guns until the raider is gone for good. Returns 'sunk', true (sheltering/fleeing — the caller must NOT sail
 *  the voyage this tick), or false (all clear — resume). */
function shelterOrFlee(world, ship, h) {
  const t = world.rules;
  if (ship._sheltered) {
    const port = world.islandsById.get(ship._shelterAt);
    if (port) provisionCrew(world, port, ship); // kept victualled while snug in port (tops to target — a no-op once full)
    // WHEN to slip back out is a judgement call, and captains differ. BOLDNESS sets how close a raider may
    // still be when she chances it — the bold cut it fine, the cautious hold for a wide offing. SEAMANSHIP
    // sets how fast she commits once it looks clear — a skilled hand reads the moment and goes, a green one
    // dithers. So a smart, bold master slips out promptly and cleanly, while a dull-but-bold one is just as
    // willing yet mistimes it — dawdling far longer before finally weighing anchor.
    const skill = skill01(ship.captain, t, 'sea');
    const b = (ship.captain && ship.captain.traits && ship.captain.traits.boldness);
    const bold = b != null ? b : 0.5;
    const clearRange = t.PIRATE_EVADE_RANGE * t.FLEE_DISENGAGE * (1.25 - 0.5 * bold); // bold slips out with a raider nearer
    const dwell = (t.SHELTER_CLEAR_SECONDS || 15) * (1.35 - 0.7 * skill) * (1.05 - 0.15 * bold); // skill → commits fast
    const nearRaider = port && anyShipInRange(world._pirateGrid, port.x, port.y, clearRange);
    if (!port || nearRaider) { ship._shelterClear = 0; setAct(ship, 'shelter', ship._shelterAt); return true; } // raider still about — hold
    ship._shelterClear = (ship._shelterClear || 0) + h; // looks clear — settle a spell (captain-scaled) before weighing anchor
    if (ship._shelterClear < dwell) { setAct(ship, 'shelter', ship._shelterAt); return true; }
    ship._sheltered = false; ship._shelterAt = null; ship._shelterClear = 0; // the coast is clear — resume the voyage
    return false;
  }
  const refuge = fleeTarget(world, ship); // pirate near → run for the nearest safe port
  if (refuge) { setAct(ship, 'flee', ship._fleeTo); return panicRun(world, ship, refuge, h) === 'sunk' ? 'sunk' : true; }
  return false;
}

/** A skilled captain on a non-urgent run may HOLD in port for a strong headwind to shift —
 *  bounded so patience always runs out. Never on a food run (people are starving) or a scout. */
function shouldWaitForWind(world, ship, home, v) {
  const t = world.rules;
  if (v.reason === 'food' || v.reason === 'scout') return false;
  if ((ship._waited || 0) >= t.WAIT_MAX_SECONDS) return false;
  if (skill01(ship.captain, t, 'sea') < t.WAIT_MIN_SKILL) return false;
  if (!navProfile(ship.captain, t).patient) return false; // a bold captain never dawdles for wind
  const stop = world.islandsById.get(v.stops[0].islandId);
  const heading = Math.atan2(stop.y - home.y, stop.x - home.x);
  return upwindness(world, heading) >= t.WAIT_UPWIND_THRESHOLD;
}

/** Arm a departing merchant from its home armoury — Weapons the island PRODUCED or bought (never
 *  free). The captain DECIDES the loadout (defensiveArmTarget): a baseline, more if cautious, and a
 *  response to the KNOWN danger of the route sharpened by judgment — routeDanger blends what the home
 *  has HEARD of the peril along the planned stops (believedDanger, no omniscience) with any raider
 *  physically off the home port right now. Guns take hold slots from trade (a bold captain runs light
 *  and fat) and are spent in any fight (a Weapons sink → ongoing demand). The home can only supply
 *  what it stocks; the shortfall on a dangerous run is bought en route (goals.js planVoyage). */
function armForDefence(world, home, ship) {
  const t = world.rules;
  const spec = t.SHIP_TYPES && t.SHIP_TYPES[ship.type];
  const wcap = spec ? spec.weaponCap : t.COMBAT_WEAPON_CAP; // a hull mounts only so many guns
  const day = currentDay(world);
  const nearHome = Math.min(1, countShipsInRange(world._pirateGrid, home.x, home.y, t.PIRATE_HUNT_RANGE) / 2);
  const routeDanger = Math.max(nearHome, routePeril(world, home, ship.voyage && ship.voyage.stops, day));
  const target = defensiveArmTarget(ship.captain, t, wcap, routeDanger);
  const need = target - (ship.cargo.Weapons || 0);
  if (need < 1) return;
  const space = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
  const load = Math.min(need, Math.max(0, home.stock.Weapons || 0), space);
  if (load >= 1) transfer(home.stock, 'Weapons', ship.cargo, 'Weapons', load);
}

/** Load the whole voyage at home: the multi-good sell basket, migrants, and a gold
 *  budget for planned buys (with headroom for price drift). Records the ACTUAL amounts
 *  loaded back onto each stop so executeStop never tries to sell more than was carried. */
function loadForVoyage(world, home, ship) {
  const t = world.rules;
  const v = ship.voyage;

  provisionCrew(world, home, ship); // victual the crew first — food (and grog) before trade cargo
  armForDefence(world, home, ship); // then load guns from the home armoury (fewer hold slots for trade)
  repairAtPort(world, home, ship);  // mend hull/rig from the home yard (Wood/Fiber) before sailing
  snapshotAllies(world, home, ship); // carry home's alliances to sea (info-by-sea — his aid decisions run off this)

  for (const stop of v.stops) {
    for (const good in stop.sell) {
      const space = ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT);
      const load = Math.min(stop.sell[good], Math.max(0, space));
      stop.sell[good] = transfer(home.stock, good, ship.cargo, good, load);
    }
    // Aid gifts ride along like sell cargo, but no coin comes back for them (see executeStop).
    if (stop.gift) for (const good in stop.gift) {
      const space = ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT);
      const load = Math.min(stop.gift[good], Math.max(0, space));
      stop.gift[good] = transfer(home.stock, good, ship.cargo, good, load);
    }
  }

  const totalPeople = v.stops.reduce((a, s) => a + s.people, 0);
  if (totalPeople > 0) {
    const avail = Math.max(0, home.population - t.POP_FLOOR);
    const space = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
    const loaded = transfer(home, 'population', ship.cargo, PEOPLE, Math.min(totalPeople, avail, space));
    if (loaded < totalPeople) { // couldn't load all — scale each stop down proportionally
      const scale = totalPeople > 0 ? loaded / totalPeople : 0;
      for (const s of v.stops) s.people *= scale;
    }
  }

  let cost = 0;
  const day = currentDay(world);
  for (const stop of v.stops) {
    // Size the purse on the BELIEVED price at each remote stop (what the home reckons things cost),
    // not live truth — the ship tops up from sales along the way and settles at real prices on arrival.
    for (const good in stop.buy) cost += stop.buy[good] * bidAsk(beliefMid(world, home, stop.islandId, good, day), t.SPREAD).ask;
  }
  if (cost > 0) {
    // Coin is heavy: only load working capital that still FITS after the sell cargo, so the
    // hold never departs overloaded. That's fine — sell-stops are routed first, so the ship
    // tops up its purse from the sale proceeds before it reaches a buy stop.
    const room = Math.max(0, ship.capacity - cargoUnits(ship, t.GOLD_PER_CARGO_UNIT));
    const goldRoom = t.GOLD_PER_CARGO_UNIT > 0 ? room * t.GOLD_PER_CARGO_UNIT : Infinity;
    transfer(home, 'gold', ship.cargo, GOLD, Math.min(home.gold, cost * 1.2, goldRoom));
  }

  stowRepairKit(world, home, ship); // a cautious captain fills any LEFTOVER hold with spare spars & canvas
}

/** Deposit everything the ship is carrying back home; a purchased Ship becomes a new
 *  vessel in the home fleet (the "bought ship joins the fleet" rule). */
function unloadHome(world, home, ship) {
  const t = world.rules;
  const bought = Math.floor(ship.cargo.Ships || 0);
  for (const key in ship.cargo) {
    const amt = ship.cargo[key];
    if (amt <= 0) continue;
    if (key === GOLD) transfer(ship.cargo, GOLD, home, 'gold', amt);
    else if (key === PEOPLE) transfer(ship.cargo, PEOPLE, home, 'population', amt);
    else if (key === 'Ships') { /* consumed by the spawn below */ }
    else {
      // Deposit unsold cargo, but a full warehouse can't overflow — excess spoils
      // (goods aren't conserved; this keeps every stockpile bounded by its cap).
      transfer(ship.cargo, key, home.stock, key, amt);
      const cap = capOf(world.economy, world.rules, key);
      if (home.stock[key] > cap) home.stock[key] = cap;
    }
  }
  if (bought >= 1) {
    ship.cargo.Ships = Math.max(0, (ship.cargo.Ships || 0) - bought);
    // Re-check the fleet caps at the moment of launch, not just when the voyage was planned: a
    // parallel path (island development) may have filled the last berth while this hull was in
    // transit. Any hull that won't fit is shelved as re-sellable stock rather than overflowing the
    // cap (or vanishing) — it cost Wood+Iron to build, so its value is kept.
    const owned = fleetAt(world, home.id).total;
    const room = Math.max(0, Math.min(t.MAX_SHIPS_PER_ISLAND - owned, t.MAX_SHIPS_TOTAL - world.ships.length));
    const launch = Math.min(bought, room);
    for (let i = 0; i < launch; i++) spawnShip(world, home);
    if (bought > launch) home.stock.Ships = (home.stock.Ships || 0) + (bought - launch); // no berth — keep the hull to re-sell
  }
}

/** A pirate within evasion range → the merchant runs for the nearest SAFE port. Returns the sanctuary
 *  island (or null). Character: a BOLD, armed captain RUNS the blockade — holds course and trusts her
 *  speed and guns — unless a pirate is right on top of her; the cautious duck into harbour. Pirates
 *  disrupt trade this way even when they never catch anyone.
 *
 *  HYSTERESIS is essential here: the trigger is a hard distance boundary, and a pirate ORBITING a
 *  blockaded port (or one the ship is trying to reach) sits right around it — so a knife-edge test would
 *  flip the ship between fleeing and pressing on every substep, spinning it back and forth (headwind ↔
 *  tailwind) and making no progress. So once fleeing, a ship keeps running until the raider is WELL clear
 *  (FLEE_DISENGAGE × the range) and commits to ONE refuge (`_fleeTo`) until it arrives or that port
 *  itself falls under blockade — never re-picking a nearer bolt-hole each tick (which also swings the heading). */
function fleeTarget(world, ship) {
  const t = world.rules;
  const engaged = !!ship._fleeing;
  // Start fleeing at the evade range; once fleeing, only disengage when the raider is well beyond it.
  const detect = t.PIRATE_EVADE_RANGE * (engaged ? t.FLEE_DISENGAGE : 1);
  if (!anyShipInRange(world._pirateGrid, ship.x, ship.y, detect)) { ship._fleeing = false; ship._fleeTo = null; return null; }
  // DECIDE — run the blockade, or duck into port? BOLDNESS is the risk appetite; a steady, seasoned hand
  // (SEAMANSHIP) tips a borderline captain toward chancing it and a green one toward caution. An unarmed hull
  // has no teeth to run a raider down, so it shelters. A captain who DOES make the run holds course — hysteretic,
  // so she doesn't flicker between running and bolting — until a raider is nearly aboard; HOW near she lets it
  // come scales with that same nerve (bold + skilled hold course longest), so a dull-but-bold master mistimes
  // the run where a smart one threads it clean.
  const skill = skill01(ship.captain, t, 'sea');
  const boldness = (ship.captain && ship.captain.traits && ship.captain.traits.boldness);
  const bnd = boldness != null ? boldness : 0.5;
  const armed = (ship.cargo.Weapons || 0) >= t.ARM_WEAPONS_BASE;
  if (armed && (bnd + 0.25 * (skill - 0.5)) >= t.MERCHANT_RUN_BLOCKADE_TRAIT) {
    // A trader is no warship: she only holds her course past a raider she can genuinely STAND UP to. Outgunned
    // (the usual case — merchants are never the stronger), even a bold captain FLEES, letting her stern guns
    // shoot away the pursuer's rig to cover the run (defensive fire, resolved when the chase closes to gun-range)
    // rather than standing to be worn down and boarded. So arming buys a covered retreat, not a licence to slug.
    const raider = nearestShip(world._pirateGrid, ship.x, ship.y, null, detect);
    // GROUP-AWARE: a lone armed trader still runs a single weak raider's blockade, but FLEES a PACK whose
    // summed guns clear the bar (three raiders off the bow, no consorts of her own — she doesn't stand). Ally
    // side is self only (aggressors-only scope: merchants don't convoy); foes are the raiders in the evade
    // bubble. `armed` above stays a hard precondition — numbers never lend a cargo hull teeth it lacks.
    const bal = balanceOfForce(world, ship, null, world._pirateGrid, detect, { foe: raider });
    const canStand = bal.foe <= 0 || bal.ally >= bal.foe * (t.MERCHANT_STAND_ODDS || 0.8);
    if (canStand) {
      const grit = 0.6 * bnd + 0.4 * skill; // steadier nerve → hold the run until the raider is closer
      const runClear = t.PIRATE_COMBAT_RANGE * (engaged ? 3.5 : 2.5) * (1.35 - 0.6 * grit);
      if (!anyShipInRange(world._pirateGrid, ship.x, ship.y, runClear)) { ship._fleeing = false; ship._fleeTo = null; return null; }
    }
  }
  ship._fleeing = true;
  // Sticky refuge: choose ONE safe bolt-hole when the flight BEGINS and hold it until the raider is
  // clear (which resets _fleeTo). Re-choosing the "nearest safe port" every tick was the bug behind the
  // spin: as the chasing pirate moved, WHICH port counted as "safe" flipped between two, so the target
  // (and heading) alternated every substep and the ship thrashed in place instead of running. Picked
  // once, the heading is stable all the way in. Fall back to the nearest port if none is clear.
  if (ship._fleeTo == null || !world.islandsById.get(ship._fleeTo)) {
    const refuge = gridNearestIsland(world, ship.x, ship.y, (isl) => !anyShipInRange(world._pirateGrid, isl.x, isl.y, t.PIRATE_BLOCKADE_SNAP))
      || gridNearestIsland(world, ship.x, ship.y);
    ship._fleeTo = refuge ? refuge.id : null;
  }
  return world.islandsById.get(ship._fleeTo) || gridNearestIsland(world, ship.x, ship.y);
}

/** Divert a sailing ship to `island` to reprovision — abandons the old plan; docks there
 *  (crew fed), then heads home. */
function redirectResupply(world, ship, island) {
  ship.voyage = { reason: 'resupply', stops: [{ islandId: island.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  startLeg(world, ship, island.x, island.y);
  ship.state = 'outbound';
}

/** A capable captain who has SEEN firsthand (at sea, sightAtSea) that the port ahead has fallen to
 *  a pirate haven won't waste the leg sailing into it — he strikes it from the route and presses on
 *  to the next stop (or turns for home). A less able captain sails in and finds out the hard way
 *  (the 'trading' case), then carries that news home. Only acts on a sighting the ship actually
 *  holds in its logbook, so it's the captain's own fresher knowledge, not the home's. */
function rerouteFromFallen(world, ship) {
  const t = world.rules;
  if (skill01(ship.captain, t, 'sea') < (t.CAPTAIN_REROUTE_MIN_SKILL || 0.35)) return false;
  const v = ship.voyage;
  const stop = v.stops[v.index];
  const rec = ship.intel && ship.intel[stop.islandId];
  if (!rec || !rec.haven) return false;
  if (currentDay(world) - rec.day > (t.INTEL_HAVEN_FORGET || 25)) return false; // a sighting still current
  const port = world.islandsById.get(stop.islandId);
  logEventThrottled(world, 'reroute', t.SIM_DAY_SECONDS, `${ship.captain ? ship.captain.name : 'A captain'} steered ${ship.name || 'clear'} away from pirate-held ${port ? port.name : 'a fallen port'}.`, { x: ship.x, y: ship.y });
  v.index++;
  const home = world.islandsById.get(ship.homeId);
  if (v.index < v.stops.length) aimAtStop(world, ship);
  else { startLeg(world, ship, home.x, home.y); ship.state = 'inbound'; }
  return true;
}

function updateShip(world, ship, h) {
  const t = world.rules;
  const home = world.islandsById.get(ship.homeId);
  const v = ship.voyage;
  if (ship.uprising) return; // crew in revolt — dead in the water until crew.js resolves it
  if (ship.adrift) { driftLost(world, ship, h); return; } // blown off course — wanders until bearings return
  // SELF-REPAIR — the SAME heave-to a raider uses (a boat's a boat): badly hurt, repair timber aboard (a
  // stowed kit or spars from a rescue), and no lawful port within reach to limp to? HEAVE TO and jury-rig,
  // dead in the water, showing the careen badge. A merchant normally just docks to mend, so this only fires
  // when it's genuinely stranded and hurt — but it's the one shared mechanism, not a merchant-only path.
  if ((ship.state === 'outbound' || ship.state === 'inbound') && !ship._sheltered
      && ((ship.hull != null ? ship.hull : 1) < 0.5 || (ship.rig != null ? ship.rig : 1) < 0.4)) {
    const port = gridNearestIsland(world, ship.x, ship.y);
    const nearBase = port && !port.haven && Math.hypot(port.x - ship.x, port.y - ship.y) <= t.HAVEN_DEFEND_RANGE;
    if (!nearBase && maybeHeaveToRepair(world, ship, h)) return; // hove to this tick — don't sail
  }
  switch (ship.state) {
    case 'idle':
      if (v && v.stops.length) {
        // SHELTER: don't sail into a blockade. A pirate lurking off the home port holds the fleet in
        // harbour until the coast clears — so a blockaded port doesn't feed its ships to the raider one
        // by one. A bold captain runs for it anyway, and a survival FOOD run always sails (the crew must
        // eat, blockade or no). This resolves on its own once the pirate is driven off or moves on.
        const boldness = (ship.captain && ship.captain.traits && ship.captain.traits.boldness);
        // A seasoned hand (skill) tips a borderline captain toward chancing the run out; a green one toward
        // riding it out in harbour — the same nerve-plus-judgement that governs a flight at sea.
        const boldCap = ((boldness != null ? boldness : 0.5) + 0.25 * (skill01(ship.captain, t, 'sea') - 0.5)) >= t.MERCHANT_RUN_BLOCKADE_TRAIT;
        if (!boldCap && v.reason !== 'food' && home
            && anyShipInRange(world._pirateGrid, home.x, home.y, t.PIRATE_EVADE_RANGE)) {
          setAct(ship, 'shelter', home.id); break; // riding out a blockade in harbour
        }
        if (shouldWaitForWind(world, ship, home, v)) { setAct(ship, 'wait', home ? home.id : null); ship._waited += h; break; }
        ship._waited = 0;
        loadForVoyage(world, home, ship);
        aimAtStop(world, ship);
        noteDeparture(world, home, ship); // the home now EXPECTS this ship back (voyages.js ledger)
        ship.state = 'outbound';
      } else setAct(ship, 'idle', ship.homeId); // lying at anchor, awaiting orders
      break;
    case 'outbound': {
      const ev = shelterOrFlee(world, ship, h); // run from a raider / ride it out DOCKED in a refuge until clear
      if (ev === 'sunk') return;
      if (ev) break; // fleeing or sheltering in port — hold the voyage this tick
      const dev = deviationTarget(world, ship); // a worried captain runs for the nearest larder
      if (dev) { setAct(ship, 'resupply', dev.id); redirectResupply(world, ship, dev); break; }
      const help = aidTarget(world, ship); // an ally in distress nearby → heave-to and render aid (mercy valve)
      if (help) { setAct(ship, 'aid', help.id); if (renderAidRun(world, ship, help, h) === 'sunk') return; break; }
      if (rerouteFromFallen(world, ship)) break; // a capable captain skips a port he KNOWS has fallen
      setAct(ship, 'sailTo', v.stops[v.index] ? v.stops[v.index].islandId : ship.homeId);
      const r = sail(world, ship, h);
      if (r === 'sunk') return; // lost at sea
      if (r === 'arrived') { ship.state = 'trading'; ship.dockTimer = t.DOCK_SECONDS; }
      break;
    }
    case 'trading':
      setAct(ship, 'tradeAt', v.stops[v.index] ? v.stops[v.index].islandId : ship.homeId);
      ship.dockTimer -= h;
      if (ship.dockTimer <= 0) {
        const island = world.islandsById.get(v.stops[v.index].islandId);
        if (island.haven) {
          // Sailed in on stale orders to find the port has RAISED THE BLACK FLAG — no honest market
          // here now. The crew sees the truth firsthand (carried home as fresh intel) and slips away
          // without trading. This is the price of acting on out-of-date information.
          observeAndGossip(world, island, ship);
          observeFacts(world, island, ship);
          logEventThrottled(world, 'shun', t.SIM_DAY_SECONDS, `${ship.name || 'A merchant'} found ${island.name} fallen to pirates and fled without trading.`, { x: island.x, y: island.y });
        } else {
          executeStop(world, island, ship, v.stops[v.index]);
          shipDockDisease(world, island, ship);   // plague may pass between ship and port
          observeAndGossip(world, island, ship);  // the ship reads this port's prices + trades rumor
          observeFacts(world, island, ship);      // …and its live facts (danger/haven/food), reporting its logbook
          provisionCrew(world, island, ship);     // top up the crew's stores at every port
          repairAtPort(world, island, ship);      // …and mend battle/storm damage from the yard (buys Wood/Fiber)
        }
        v.index++;
        if (v.index < v.stops.length) { aimAtStop(world, ship); ship.state = 'outbound'; }
        else { startLeg(world, ship, home.x, home.y); ship.state = 'inbound'; }
      }
      break;
    case 'inbound': {
      const ev = shelterOrFlee(world, ship, h); // run from a raider / ride it out DOCKED in a refuge until clear
      if (ev === 'sunk') return;
      if (ev) break; // fleeing or sheltering in port — hold the voyage this tick
      const help = aidTarget(world, ship); // even homeward-bound, an ally in distress is answered
      if (help) { setAct(ship, 'aid', help.id); if (renderAidRun(world, ship, help, h) === 'sunk') return; break; }
      setAct(ship, 'home', home ? home.id : null);
      const r = sail(world, ship, h);
      if (r === 'sunk') return; // lost at sea
      if (r === 'arrived') {
        unloadHome(world, home, ship);
        repairAtPort(world, home, ship);                // battered home — mend from the home yard
        observeAndGossip(world, home, ship);            // the ship reports everything it saw back home
        observeFacts(world, home, ship);                // …including all the facts it gathered abroad
        applyAidDeeds(world, home, ship);               // …and reports any rescues rendered — the goodwill lands now
        noteReturn(home, ship);                         // safely home — clear it from the ledger
        awardVoyageXp(ship.captain, t, v.stops.length); // the captain earns experience for the run
        ship.infected = false; // crew rotates / quarantines on returning home
        home._runs++;
        // ── Quiet-life BEATS (tier:'log') — a trader's Story tab otherwise stays empty until it fights ──
        const rankedUp = rankUp(ship.captain); // did this run raise the captain's rank?
        if (rankedUp) logEvent(world, 'promotion', `Capt. ${ship.captain.name} of ${ship.name || 'a ship'} was raised to ${rankedUp}, out of ${home.name}.`,
          { shipId: ship.id, islandId: home.id, tier: (rankedUp === 'Master' || rankedUp === 'Legendary') ? 'news' : 'log' });
        ship._voyages = (ship._voyages || 0) + 1;
        if (ship._voyages === 1) {
          logEvent(world, 'maiden', `${ship.name || 'A new ship'} completed her maiden voyage, home to ${home.name}.`, { shipId: ship.id, islandId: home.id, tier: 'log' });
        } else if ((t.SHIP_VOYAGE_MILESTONES || []).includes(ship._voyages)) {
          logEvent(world, 'voyages', `${ship.name || 'A ship'} has now made ${ship._voyages} voyages out of ${home.name}.`, { shipId: ship.id, islandId: home.id, tier: 'log' });
        }
        ship.voyage = null;
        ship.leg = null;
        ship.state = 'idle';
      }
      break;
    }
  }
}

/** Snapshot HOME's alliances aboard at departure — the captain carries this to sea and judges whom to aid
 *  from it (info by sea; no live rep read mid-ocean). Refreshed each time he sails from home. */
function snapshotAllies(world, home, ship) {
  const t = world.rules;
  ship._allies = {}; ship._embargoes = {};
  if (!home || !home.rep) return;
  for (const id in home.rep) {
    const r = home.rep[id];
    if (r >= t.REP_ALLY_AID_MIN) ship._allies[id] = 1;
    else if (r <= t.REP_EMBARGO_THRESHOLD) ship._embargoes[id] = 1;
  }
}

/** The nearest ship in DISTRESS this captain would heave-to for: a FLEETMATE (same home, always) or a home
 *  he CARRIES as an ally (never one he carries as embargoed) — judged off his carried knowledge, not live
 *  rep. Gated by capacity (he must have SPARE goods to give), a trait-scaled divert distance (the generous
 *  go farther, the greedy grudge it), and — for a cautious captain — local danger (pirate waters suppress
 *  mercy). Returns null if there's no one he can, or will, help. */
function aidTarget(world, ship) {
  const t = world.rules;
  const grid = world._distressGrid;
  if (!grid || world.simTime < (ship._rescueCd || 0)) return null; // resting after a rescue → press on
  const goods = t.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const foodKeep = (t.CREW_FOOD_PER_DAY || 1) * (t.PROVISION_DAYS || 1);
  const hasSpare = spareAboard(ship, goods.rig, t.RESCUE_KEEP_FIBER) >= 1
    || spareAboard(ship, goods.hull, t.RESCUE_KEEP_WOOD) >= 1
    || spareAboard(ship, 'Food', foodKeep) >= 1;
  if (!hasSpare) return null; // a tapped-out friend genuinely can't help
  const tr = (ship.captain && ship.captain.traits) || {};
  const greed = tr.greed != null ? tr.greed : 0.5;
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  const divert = (t.RESCUE_DIVERT_MAX || 700) * Math.max(0.4, Math.min(1.4, 1 + (0.55 - greed)));
  const cautious = bold < 0.45;
  let best = null, bestD = Infinity;
  eachShipInRange(grid, ship.x, ship.y, t.RESCUE_RANGE, (v) => {
    if (v === ship || v._sunk) return;
    const d = Math.hypot(v.x - ship.x, v.y - ship.y);
    if (d > divert || d >= bestD) return;
    if (v.homeId !== ship.homeId) { // a fleetmate is always answered; otherwise consult carried knowledge
      if (ship._embargoes && ship._embargoes[v.homeId]) return;
      if (!(ship._allies && ship._allies[v.homeId])) return;
    }
    if (cautious) { const near = gridNearestIsland(world, v.x, v.y); if (near && (near.danger || 0) > (t.RESCUE_DANGER_MAX || 0.45)) return; }
    best = v; bestD = d;
  });
  return best;
}

/** Close on a stricken ship and, once alongside, render aid — then rest a while before the next rescue and
 *  resume the voyage. Returns 'sunk' if the helper founders on the way (it still sails real waters). */
function renderAidRun(world, helper, victim, h) {
  const t = world.rules;
  if (Math.hypot(victim.x - helper.x, victim.y - helper.y) <= (t.RESCUE_DOCK_RANGE || 120)) {
    renderAid(world, helper, victim);
    helper._rescueCd = world.simTime + (t.RESCUE_COOLDOWN_DAYS || 3) * t.SIM_DAY_SECONDS;
    return 'aided';
  }
  const aim = steerAroundIslands(world, helper, victim.x, victim.y);
  const heading = Math.atan2(aim.y - helper.y, aim.x - helper.x);
  const eff = (helper.speed || t.SHIP_SPEED) * rigMult(helper, t) * windMult(world, heading, skill01(helper.captain, t, 'sea'));
  if (maybeSink(world, helper, eff * h)) return 'sunk';
  moveToward(helper, aim.x, aim.y, eff, h);
  return 'aiding';
}

/** Report rescues rendered abroad once the helper is safely HOME: the goodwill (bumpRep) lands now, at the
 *  quay — never mid-ocean — so an alliance forged by a rescue propagates by sea like any other news. */
function applyAidDeeds(world, home, ship) {
  if (!ship._aidDeeds || !home) return;
  for (const d of ship._aidDeeds) if (d.otherHome && d.otherHome !== home.id) bumpRep(world, home.id, d.otherHome, world.rules.REP_AID_GAIN);
  ship._aidDeeds = null;
}

const TAU = Math.PI * 2;
/** Stable per-ship hash (FNV-1a over the id) for a deterministic drift heading — no Math.random. */
function idHash(id) {
  let x = 2166136261; const s = String(id);
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x >>> 0;
}

/** Re-plan a ship's course after it regains its bearings: an outbound ship makes for its next stop; any
 *  other (inbound, or a voyage already run out) turns for home. */
function regainBearings(world, ship) {
  const v = ship.voyage;
  const home = world.islandsById.get(ship.homeId);
  if (ship.state === 'outbound' && v && v.stops && v.index < v.stops.length) aimAtStop(world, ship);
  else if (home) { startLeg(world, ship, home.x, home.y); ship.state = 'inbound'; }
}

/** A ship blown off course (ship.adrift) wanders a drifting heading, making NO real progress toward its
 *  destination — still eating its stores, off the trade lanes, and easy prey — while the captain fights to
 *  regain his bearings. A seamanlike hand jury-rigs storm damage from stores aboard meanwhile. Each day
 *  he attempts a fix: LOST_RECOVER_BASE + seamanship (+ a bonus if land is in sight); on success the ship
 *  clears `adrift`, re-plans its voyage, and the captain earns hard-won seamanship. A long time lost is its
 *  own peril — the crew starves and the wallowing hull founders more readily (events.js maybeSink). */
function driftLost(world, ship, h) {
  const t = world.rules;
  setAct(ship, 'adrift', null);
  sightAtSea(world, ship);        // the captain still reads any coast he drifts past — his best hope of a fix
  juryRig(world, ship, h);        // and the crew patches what damage they can from the hold
  const sea = skill01(ship.captain, t, 'sea');
  const day = currentDay(world);
  if (ship._adriftDay !== day) {  // one attempt to find the bearings per day
    ship._adriftDay = day;
    const land = gridNearestIsland(world, ship.x, ship.y);
    const sighted = land && Math.hypot(land.x - ship.x, land.y - ship.y) <= t.SIGHT_RANGE_AT_SEA;
    const p = (t.LOST_RECOVER_BASE || 0) + sea + (sighted ? (t.LOST_SIGHT_BONUS || 0) : 0);
    if (streamFloat(world, 'weather') < p) {
      ship.adrift = null;
      awardSeamanshipXp(ship.captain, t.XP_LOST_RECOVER || 0);
      regainBearings(world, ship);
      const who = ship.captain ? ` under Capt. ${ship.captain.name}` : '';
      logEvent(world, 'bearings', `${ship.name || 'A ship'}${who} regained her bearings and resumed course.`, { x: ship.x, y: ship.y, shipId: ship.id });
      return;
    }
  }
  // Still lost — drift on a deterministic heading that shifts by the day (seeded by id + day), rounded past
  // any land so it doesn't beach, at a slow wallowing pace. No progress toward the real destination.
  const ang = ((idHash(ship.id) ^ Math.imul(day + 1, 2654435761)) >>> 0) / 4294967296 * TAU;
  const far = t.SIGHT_RANGE_AT_SEA || 700;
  const aim = steerAroundIslands(world, ship, ship.x + Math.cos(ang) * far, ship.y + Math.sin(ang) * far);
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * rigMult(ship, t) * (t.LOST_DRIFT_MULT || 0.5) * windMult(world, heading, sea);
  if (maybeSink(world, ship, eff * h)) return; // maybeSink marks _sunk; the ship system removes it
  moveToward(ship, aim.x, aim.y, eff, h);
}

/** The ship SIM system. Removes any vessels that foundered this step. */
export function ship(world, h) {
  computeFleetByHome(world); // fresh per-home census for maybeSink's last-ship guard (O(S), was O(S²))
  // Pirate positions are fixed for this whole pass (only `piracy`, which runs later, moves them),
  // so one O(P) grid replaces the per-merchant full-fleet pirate scans in fleeTarget/armForDefence
  // (the O(S²) wall). Stored on the world so the deep-nested voyage machine can read it.
  world._pirateGrid = buildShipGrid(world, world.ships.filter((s) => s.pirate && !s._sunk));
  world._strengthCache = new Map(); // per-substep combatStrength memo for a merchant's group-force flee test (derived)
  // Ships in DISTRESS (dismasted / adrift) are few — one small grid lets a passing ally spot and aid them
  // (aidTarget), the sea's mercy valve. Merchants only: pirates/privateers ride their own storms.
  world._distressGrid = buildShipGrid(world, world.ships.filter((s) => !s._sunk && !s.pirate && !s.privateer && inDistress(s, world.rules)));
  let sunk = false;
  for (const s of world.ships) {
    if (s.pirate || s.privateer) continue; // driven by piracy / antipiracy, not merchant logic
    updateShip(world, s, h);
    if (s._sunk) sunk = true;
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}
