// Ship factory + movement + the multi-stop VOYAGE state machine. A voyage loads a
// diversified basket at home, then visits each stop in order (selling/buying/dropping
// migrants), then returns home to unload. PURE. Every economic move goes through
// `transfer` (conserved); new ships spawn with 0 gold (no minting).

import { transfer, cargoUnits, capOf, GOLD, PEOPLE } from './resources.js';
import { bidAsk } from './pricing.js';
import { executeStop } from './trade.js';
import { maybeSink, shipDockDisease, logEvent, logEventThrottled } from './events.js';
import { observeAndGossip, beliefMid, currentDay } from './beliefs.js';
import { observeFacts, sightAtSea } from './intel.js';
import { noteDeparture, noteReturn } from './voyages.js';
import { windMult, upwindness } from './wind.js';
import { makeCaptain, skill01, awardVoyageXp, navProfile } from './captains.js';
import { provisionCrew, deviationTarget } from './crew.js';
import { shipName } from './naming.js';
import { computeFleetByHome, fleetAt } from './fleet.js';
import { setAct } from './piracy.js';
import { steerAroundIslands } from './navigation.js';
import { buildShipGrid, anyShipInRange, countShipsInRange, nearestIsland as gridNearestIsland } from './grid.js';

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
  const skill = skill01(ship.captain, t);
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
  const skill = skill01(ship.captain, t);
  const aim = steerAroundIslands(world, ship, ship.targetX, ship.targetY); // steer clear of land in the way
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * windMult(world, heading, skill); // per-hull speed (sloop fast, galleon slow)
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

/** Crowd on sail and run for `island` (evading a pirate) — a panicked dash, no leg tracking. */
function panicRun(world, ship, island, h) {
  const t = world.rules;
  const aim = steerAroundIslands(world, ship, island.x, island.y); // even a panicked dash rounds land in the way
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * t.PIRATE_PANIC_MULT * windMult(world, heading, skill01(ship.captain, t)); // crew rows for their lives (outrun the pirate)
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  if (moveToward(ship, aim.x, aim.y, eff, h) && !aim.deflected) provisionCrew(world, island, ship); // reached safe harbour — victual up
  return 'fleeing';
}

/** A skilled captain on a non-urgent run may HOLD in port for a strong headwind to shift —
 *  bounded so patience always runs out. Never on a food run (people are starving) or a scout. */
function shouldWaitForWind(world, ship, home, v) {
  const t = world.rules;
  if (v.reason === 'food' || v.reason === 'scout') return false;
  if ((ship._waited || 0) >= t.WAIT_MAX_SECONDS) return false;
  if (skill01(ship.captain, t) < t.WAIT_MIN_SKILL) return false;
  if (!navProfile(ship.captain, t).patient) return false; // a bold captain never dawdles for wind
  const stop = world.islandsById.get(v.stops[0].islandId);
  const heading = Math.atan2(stop.y - home.y, stop.x - home.x);
  return upwindness(world, heading) >= t.WAIT_UPWIND_THRESHOLD;
}

/** Arm a departing merchant from its home armoury — Weapons the island PRODUCED or bought (never
 *  free). A cautious captain (or one sailing pirate-infested waters) mounts more guns, which take
 *  hold slots away from trade cargo; a bold captain runs light and fat. Guns are spent in any
 *  fight (a Weapons sink), so ports must keep replenishing them — real, ongoing Weapons demand. */
function armForDefence(world, home, ship) {
  const t = world.rules;
  const bold = (ship.captain && ship.captain.traits && ship.captain.traits.boldness) || 0.5;
  const near = countShipsInRange(world._pirateGrid, home.x, home.y, t.PIRATE_HUNT_RANGE);
  const danger = Math.min(1, near / 2);
  const spec = t.SHIP_TYPES && t.SHIP_TYPES[ship.type];
  const wcap = spec ? spec.weaponCap : t.COMBAT_WEAPON_CAP; // a hull mounts only so many guns
  const target = Math.min(wcap, t.ARM_WEAPONS_BASE + (1 - bold) * t.ARM_WEAPONS_CAUTION + danger * t.ARM_DANGER_BONUS);
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
  const boldness = (ship.captain && ship.captain.traits && ship.captain.traits.boldness);
  const bold = (boldness != null ? boldness : 0.5) >= t.MERCHANT_RUN_BLOCKADE_TRAIT;
  const armed = (ship.cargo.Weapons || 0) >= t.ARM_WEAPONS_BASE;
  // The daring make the run — hold course — until a raider is nearly aboard (also hysteretic, so a bold
  // captain doesn't flicker between running the blockade and bolting).
  const runClear = t.PIRATE_COMBAT_RANGE * (engaged ? 3.5 : 2.5);
  if (bold && armed && !anyShipInRange(world._pirateGrid, ship.x, ship.y, runClear)) { ship._fleeing = false; ship._fleeTo = null; return null; }
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
  if (skill01(ship.captain, t) < (t.CAPTAIN_REROUTE_MIN_SKILL || 0.35)) return false;
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
  switch (ship.state) {
    case 'idle':
      if (v && v.stops.length) {
        // SHELTER: don't sail into a blockade. A pirate lurking off the home port holds the fleet in
        // harbour until the coast clears — so a blockaded port doesn't feed its ships to the raider one
        // by one. A bold captain runs for it anyway, and a survival FOOD run always sails (the crew must
        // eat, blockade or no). This resolves on its own once the pirate is driven off or moves on.
        const boldness = (ship.captain && ship.captain.traits && ship.captain.traits.boldness);
        const boldCap = (boldness != null ? boldness : 0.5) >= t.MERCHANT_RUN_BLOCKADE_TRAIT;
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
      const flee = fleeTarget(world, ship); // pirate near → sprint for the nearest port
      if (flee) { setAct(ship, 'flee', ship._fleeTo); if (panicRun(world, ship, flee, h) === 'sunk') return; break; }
      const dev = deviationTarget(world, ship); // a worried captain runs for the nearest larder
      if (dev) { setAct(ship, 'resupply', dev.id); redirectResupply(world, ship, dev); break; }
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
        }
        v.index++;
        if (v.index < v.stops.length) { aimAtStop(world, ship); ship.state = 'outbound'; }
        else { startLeg(world, ship, home.x, home.y); ship.state = 'inbound'; }
      }
      break;
    case 'inbound': {
      const flee = fleeTarget(world, ship);
      if (flee) { setAct(ship, 'flee', ship._fleeTo); if (panicRun(world, ship, flee, h) === 'sunk') return; break; }
      setAct(ship, 'home', home ? home.id : null);
      const r = sail(world, ship, h);
      if (r === 'sunk') return; // lost at sea
      if (r === 'arrived') {
        unloadHome(world, home, ship);
        observeAndGossip(world, home, ship);            // the ship reports everything it saw back home
        observeFacts(world, home, ship);                // …including all the facts it gathered abroad
        noteReturn(home, ship);                         // safely home — clear it from the ledger
        awardVoyageXp(ship.captain, t, v.stops.length); // the captain earns experience for the run
        ship.infected = false; // crew rotates / quarantines on returning home
        home._runs++;
        ship.voyage = null;
        ship.leg = null;
        ship.state = 'idle';
      }
      break;
    }
  }
}

/** The ship SIM system. Removes any vessels that foundered this step. */
export function ship(world, h) {
  computeFleetByHome(world); // fresh per-home census for maybeSink's last-ship guard (O(S), was O(S²))
  // Pirate positions are fixed for this whole pass (only `piracy`, which runs later, moves them),
  // so one O(P) grid replaces the per-merchant full-fleet pirate scans in fleeTarget/armForDefence
  // (the O(S²) wall). Stored on the world so the deep-nested voyage machine can read it.
  world._pirateGrid = buildShipGrid(world, world.ships.filter((s) => s.pirate && !s._sunk));
  let sunk = false;
  for (const s of world.ships) {
    if (s.pirate || s.privateer) continue; // driven by piracy / antipiracy, not merchant logic
    updateShip(world, s, h);
    if (s._sunk) sunk = true;
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}
