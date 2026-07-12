// Ship factory + movement + the multi-stop VOYAGE state machine. A voyage loads a
// diversified basket at home, then visits each stop in order (selling/buying/dropping
// migrants), then returns home to unload. PURE. Every economic move goes through
// `transfer` (conserved); new ships spawn with 0 gold (no minting).

import { transfer, cargoUnits, capOf, GOLD, PEOPLE } from './resources.js';
import { bidAsk } from './pricing.js';
import { executeStop } from './trade.js';
import { maybeSink, shipDockDisease, logEvent } from './events.js';
import { observeAndGossip } from './beliefs.js';
import { windMult, upwindness } from './wind.js';
import { makeCaptain, skill01, awardVoyageXp, navProfile } from './captains.js';
import { provisionCrew, deviationTarget } from './crew.js';
import { shipName } from './naming.js';

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

/** Move toward (tx,ty). Returns true on arrival (snaps, guaranteed). */
export function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y;
  const d = Math.hypot(dx, dy);
  const step = speed * h;
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
  ship.heading = Math.atan2(dy, dx);
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
  const skill = skill01(ship.captain, t);
  const heading = Math.atan2(ship.targetY - ship.y, ship.targetX - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * windMult(world, heading, skill); // per-hull speed (sloop fast, galleon slow)
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  if (moveToward(ship, ship.targetX, ship.targetY, eff, h)) {
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
  const heading = Math.atan2(island.y - ship.y, island.x - ship.x);
  const eff = (ship.speed || t.SHIP_SPEED) * t.PIRATE_PANIC_MULT * windMult(world, heading, skill01(ship.captain, t)); // crew rows for their lives (outrun the pirate)
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  if (moveToward(ship, island.x, island.y, eff, h)) provisionCrew(world, island, ship); // reached safe harbour — victual up
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
  let near = 0;
  for (const s of world.ships) if (s.pirate && Math.hypot(s.x - home.x, s.y - home.y) < t.PIRATE_HUNT_RANGE) near++;
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
  for (const stop of v.stops) {
    const p = world.islandsById.get(stop.islandId);
    for (const good in stop.buy) cost += stop.buy[good] * bidAsk(p.price[good].mid, t.SPREAD).ask;
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
    for (let i = 0; i < bought; i++) spawnShip(world, home);
  }
}

/** A pirate within evasion range → the merchant runs for the nearest port. Returns the sanctuary
 *  island (or null). Pirates disrupt trade this way even when they never catch anyone. */
function fleeTarget(world, ship) {
  const t = world.rules;
  let threat = false;
  for (const s of world.ships) { if (s.pirate && Math.hypot(s.x - ship.x, s.y - ship.y) < t.PIRATE_EVADE_RANGE) { threat = true; break; } }
  if (!threat) return null;
  let best = null, bestD = Infinity;
  for (const p of world.islands) { const d = (p.x - ship.x) ** 2 + (p.y - ship.y) ** 2; if (d < bestD) { bestD = d; best = p; } }
  return best;
}

/** Divert a sailing ship to `island` to reprovision — abandons the old plan; docks there
 *  (crew fed), then heads home. */
function redirectResupply(world, ship, island) {
  ship.voyage = { reason: 'resupply', stops: [{ islandId: island.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  startLeg(world, ship, island.x, island.y);
  ship.state = 'outbound';
}

function updateShip(world, ship, h) {
  const t = world.rules;
  const home = world.islandsById.get(ship.homeId);
  const v = ship.voyage;
  if (ship.uprising) return; // crew in revolt — dead in the water until crew.js resolves it
  switch (ship.state) {
    case 'idle':
      if (v && v.stops.length) {
        if (shouldWaitForWind(world, ship, home, v)) { ship._waited += h; break; } // hold for a shift
        ship._waited = 0;
        loadForVoyage(world, home, ship);
        aimAtStop(world, ship);
        ship.state = 'outbound';
      }
      break;
    case 'outbound': {
      const flee = fleeTarget(world, ship); // pirate near → sprint for the nearest port
      if (flee) { if (panicRun(world, ship, flee, h) === 'sunk') return; break; }
      const dev = deviationTarget(world, ship); // a worried captain runs for the nearest larder
      if (dev) { redirectResupply(world, ship, dev); break; }
      const r = sail(world, ship, h);
      if (r === 'sunk') return; // lost at sea
      if (r === 'arrived') { ship.state = 'trading'; ship.dockTimer = t.DOCK_SECONDS; }
      break;
    }
    case 'trading':
      ship.dockTimer -= h;
      if (ship.dockTimer <= 0) {
        const island = world.islandsById.get(v.stops[v.index].islandId);
        executeStop(world, island, ship, v.stops[v.index]);
        shipDockDisease(world, island, ship);   // plague may pass between ship and port
        observeAndGossip(world, island, ship);  // the ship reads this port's prices + trades rumor
        provisionCrew(world, island, ship);     // top up the crew's stores at every port
        v.index++;
        if (v.index < v.stops.length) { aimAtStop(world, ship); ship.state = 'outbound'; }
        else { startLeg(world, ship, home.x, home.y); ship.state = 'inbound'; }
      }
      break;
    case 'inbound': {
      const flee = fleeTarget(world, ship);
      if (flee) { if (panicRun(world, ship, flee, h) === 'sunk') return; break; }
      const r = sail(world, ship, h);
      if (r === 'sunk') return; // lost at sea
      if (r === 'arrived') {
        unloadHome(world, home, ship);
        observeAndGossip(world, home, ship);            // the ship reports everything it saw back home
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
  let sunk = false;
  for (const s of world.ships) {
    if (s.pirate || s.privateer) continue; // driven by piracy / antipiracy, not merchant logic
    updateShip(world, s, h);
    if (s._sunk) sunk = true;
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}
