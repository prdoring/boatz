// Crew provisioning + morale + mutiny/defection. A ship must feed its crew: while at sea the
// crew eats Food (and, if any is aboard, drinks Ale for a lift) out of the hold — a small
// draw, nothing like a town's population. Well-fed → morale sits at a steady state; low on
// food → it slips; out of food → it plummets AND the crew starts to starve (too long and the
// ship is lost). If morale stays in the gutter too long the crew rises up: the ship goes dead
// in the water, then a dice roll weighted by the captain's EXPERIENCE decides whether he faces
// them down (order restored) or loses the ship to a MUTINY (a fresh novice captain takes over)
// or a DEFECTION (the ship joins another island's fleet). Either way morale resets — but the
// food problem doesn't, so it must actually be solved. A worried captain will DEVIATE from his
// plan and run for the nearest larder before it comes to that. Experience shapes all of it:
// how well he provisions, how little the crew wastes, how much a tot of grog helps, how long
// the crew tolerates him, and his odds of quelling a revolt. PURE.

import { GOLD, transfer, clamp } from './resources.js';
import { bidAsk } from './pricing.js';
import { skill01, makeCaptain } from './captains.js';
import { logEvent } from './events.js';
import { streamFloat } from './rng.js';
import { turnPirate, canTurnPirate } from './piracy.js';

const perDay = (world, ratePerDay, h) => ratePerDay * (h / world.rules.SIM_DAY_SECONDS);
const days = (world, h) => h / world.rules.SIM_DAY_SECONDS;

/** The reason a crew turned — for the chronicle's "why". */
function crewGrievance(ship) {
  if ((ship.cargo.Food || 0) <= 0.001 || ship.hunger > 0.25) return 'their stores gone and bellies empty';
  if (ship.morale < 0.22) return 'morale rotted through on a long, hard haul';
  return 'discontent festering below decks';
}

/** Set a fresh crew's morale/hunger/unrest on a new ship. */
export function initCrew(ship, rules) {
  ship.morale = rules.MORALE_STEADY;
  ship.hunger = 0;        // sim-days spent at zero food
  ship.unrest = 0;        // sim-days morale has sat below the mutiny line
  ship.uprising = null;   // { kind, until } while the ship is dead-in-the-water in revolt
  ship._upCd = 0;         // simTime before which a new uprising can't start
}

// A skilled captain runs a tighter ship — the crew eats/drinks a bit less.
function foodRate(world, ship) {
  const r = world.rules;
  return r.CREW_FOOD_PER_DAY * (1 - skill01(ship.captain, r) * r.CONSUME_SKILL_CUT);
}
function aleRate(world, ship) {
  const r = world.rules;
  return r.CREW_ALE_PER_DAY * (1 - skill01(ship.captain, r) * r.CONSUME_SKILL_CUT);
}
function aleBoost(world, ship) {
  const r = world.rules;
  return r.MORALE_ALE_PER_DAY * (1 + skill01(ship.captain, r) * r.ALE_SKILL_BOOST);
}

/** Days of crew food currently aboard, at this crew's eating rate. */
export function foodDaysAboard(world, ship) {
  const fr = foodRate(world, ship);
  return fr > 0 ? (ship.cargo.Food || 0) / fr : 99;
}

/** How many days of food a captain aims to keep aboard — more with experience, a touch less
 *  for a bold captain who'll chance it (and more for a cautious one). */
function provisionDays(world, ship) {
  const r = world.rules;
  const bold = (ship.captain && ship.captain.traits && ship.captain.traits.boldness) || 0.5;
  return Math.max(0.6, r.PROVISION_DAYS + skill01(ship.captain, r) * r.PROVISION_SKILL_DAYS - (bold - 0.5) * 1.4);
}

/** Top up the crew's Food (and a little Ale) from `island` — the captain victualling the ship.
 *  Pays the port's ask from the ship's purse; a starving crew is given a minimal ration even
 *  if broke (no port lets sailors die at the quay). Called at home on departure and at each
 *  dock, so a trading ship reprovisions as it goes. */
export function provisionCrew(world, island, ship) {
  const r = world.rules;
  const spare = (good) => Math.max(0, (island.stock[good] || 0) - island.targets[good] * r.PROVISION_FOOD_RESERVE);

  const foodWant = foodRate(world, ship) * provisionDays(world, ship) - (ship.cargo.Food || 0);
  if (foodWant >= 0.5) {
    const ask = bidAsk(island.price.Food.mid, r.SPREAD).ask;
    const afford = ask > 0 ? (ship.cargo[GOLD] || 0) / ask : 0;
    let take = Math.min(foodWant, spare('Food'), afford);
    if (take < 1 && ship.morale < 0.35 && (island.stock.Food || 0) > 2) take = Math.min(foodWant, 3); // charity ration
    if (take >= 0.5) {
      const moved = transfer(island.stock, 'Food', ship.cargo, 'Food', take);
      transfer(ship.cargo, GOLD, island, 'gold', Math.min(ship.cargo[GOLD] || 0, moved * ask));
    }
  }
  // A prudent captain also lays in some grog for morale (only if he can pay and it's spare).
  const aleWant = aleRate(world, ship) * r.PROVISION_ALE_DAYS - (ship.cargo.Ale || 0);
  if (aleWant >= 0.5 && (island.stock.Ale || 0) > 0) {
    const ask = bidAsk(island.price.Ale.mid, r.SPREAD).ask;
    const take = Math.min(aleWant, spare('Ale'), ask > 0 ? (ship.cargo[GOLD] || 0) / ask : 0);
    if (take >= 0.5) {
      const moved = transfer(island.stock, 'Ale', ship.cargo, 'Ale', take);
      transfer(ship.cargo, GOLD, island, 'gold', Math.min(ship.cargo[GOLD] || 0, moved * ask));
    }
  }
}

/** SIM system: run the crew of every at-sea ship — consume stores, move morale, starve, and
 *  raise/resolve mutinies. Ships resting at home recover. Runs after `ship` (movement). */
export function crew(world, h) {
  const r = world.rules;
  let lost = false;
  for (const ship of world.ships) {
    const away = ship.pirate || (ship.voyage && ship.state !== 'idle'); // pirates are always at sea, always eating
    if (!away) { // in home port: crew ashore, stores land — reset toward calm
      ship.morale = Math.min(1, ship.morale + perDay(world, r.MORALE_RECOVER_RATE * 2, h));
      ship.hunger = 0;
      ship.unrest = Math.max(0, ship.unrest - days(world, h) * 2);
      continue;
    }

    // While a revolt is under way the ship is dead in the water; resolve it when the standoff
    // ends (movement is frozen in ship.js). Stores are still eaten below.
    // 1) EAT + DRINK
    const dDay = days(world, h);
    const ate = Math.min(ship.cargo.Food || 0, foodRate(world, ship) * dDay);
    ship.cargo.Food = Math.max(0, (ship.cargo.Food || 0) - ate);
    let drank = 0;
    if ((ship.cargo.Ale || 0) > 0) { drank = Math.min(ship.cargo.Ale, aleRate(world, ship) * dDay); ship.cargo.Ale -= drank; }

    // 2) MORALE
    let dm;
    if ((ship.cargo.Food || 0) <= 0.001) { dm = -r.MORALE_NOFOOD_PER_DAY; ship.hunger += dDay; }
    else {
      ship.hunger = Math.max(0, ship.hunger - dDay * 2);
      dm = foodDaysAboard(world, ship) < r.LOW_FOOD_DAYS
        ? -r.MORALE_LOWFOOD_PER_DAY
        : r.MORALE_RECOVER_RATE * (r.MORALE_STEADY - ship.morale); // ease toward steady
    }
    if (drank > 0) dm += aleBoost(world, ship);
    // Sea fatigue: even a fed crew wearies on a long haul and pines for port — a steady drag a
    // seasoned captain (and a cask of grog) keeps at bay. Shore leave at home resets it. This is
    // the always-present pressure that makes provisioning + morale an ongoing job, not a one-off.
    dm -= r.MORALE_SEA_DRAG * (1 - skill01(ship.captain, r) * r.SEA_DRAG_SKILL);
    ship.morale = clamp(ship.morale + dm * dDay, 0, 1);

    // 3) STARVATION — a crew with no food for too long is lost with the ship.
    if (ship.hunger >= r.STARVE_DAYS) {
      logEvent(world, 'starve', `${ship.name || 'A merchant crew'} starved at sea under Capt. ${ship.captain ? ship.captain.name : '—'}, lost with all hands.`, { x: ship.x, y: ship.y });
      ship._sunk = true; lost = true; continue;
    }

    // 4) UNREST → UPRISING — merchant crews only; a pirate crew is already the mutiny.
    if (ship.pirate) continue;
    if (ship.morale < r.MUTINY_MORALE) ship.unrest += dDay; else ship.unrest = Math.max(0, ship.unrest - dDay * 1.5);
    const grace = r.MUTINY_GRACE_DAYS + skill01(ship.captain, r) * r.MUTINY_GRACE_SKILL;
    if (!ship.uprising && world.simTime >= (ship._upCd || 0) && ship.unrest >= grace) {
      ship.uprising = { until: world.simTime + r.UPRISING_STALL_SEC };
      const who = ship.captain ? `Capt. ${ship.captain.name}` : 'the captain';
      logEvent(world, 'unrest', `Aboard ${ship.name || 'a merchant ship'}, the crew turned on ${who} — ${crewGrievance(ship)}.`, { x: ship.x, y: ship.y, shipId: ship.id });
    }
    if (ship.uprising && world.simTime >= ship.uprising.until) resolveUprising(world, ship);
  }
  if (lost) world.ships = world.ships.filter((s) => !s._sunk);
}

/** The standoff resolves: the captain either faces the crew down, or loses the ship. */
function resolveUprising(world, ship) {
  const r = world.rules;
  const at = { x: ship.x, y: ship.y, shipId: ship.id }; // ship survives (new captain / new home) → focusable
  const vessel = ship.name || 'a merchant ship';
  const grievance = crewGrievance(ship);
  const name = ship.captain ? ship.captain.name : 'the captain';
  const pQuell = Math.min(0.95, r.QUELL_BASE + skill01(ship.captain, r) * r.QUELL_SKILL);

  if (streamFloat(world, 'mutiny') < pQuell) {
    logEvent(world, 'quell', `Aboard ${vessel}, the crew rose up with ${grievance} — but Capt. ${name} faced them down and held command.`, at);
  } else {
    // A desperate, victorious crew may raise the black flag instead of finding a new master.
    if (streamFloat(world, 'mutiny') < r.PIRATE_CONVERT_CHANCE && canTurnPirate(world)) {
      turnPirate(world, ship); // leaves the economy; sets its own state/voyage + logs
      return;
    }
    const target = streamFloat(world, 'mutiny') < r.DEFECT_FRACTION ? defectionTarget(world, ship) : null;
    if (target) {
      logEvent(world, 'defect', `The crew of ${vessel}, ${grievance}, threw over Capt. ${name} and defected to ${target.name}.`, at);
      ship.homeId = target.id;
    } else {
      logEvent(world, 'mutiny', `Mutiny aboard ${vessel}! The crew, ${grievance}, cast out Capt. ${name} — a green hand now commands.`, at);
      ship.captain = makeCaptain(world); // a fresh novice takes command
    }
  }
  // Order (of a sort) restored; the food crisis is NOT — abandon the old plan and run for the
  // nearest larder to actually feed the crew, then home (crew.js resupply, provisioned on dock).
  ship.morale = r.MORALE_STEADY;
  ship.unrest = 0;
  ship.uprising = null;
  ship._upCd = world.simTime + r.UPRISING_COOLDOWN_DAYS * r.SIM_DAY_SECONDS;
  const food = nearestFood(world, ship) || world.islandsById.get(ship.homeId);
  ship.voyage = { reason: 'resupply', stops: [{ islandId: food.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  ship.leg = null; ship.legIdx = 0;
  ship.targetX = food.x; ship.targetY = food.y; ship.state = 'outbound';
}

/** Nearest island (home included) holding some spare food — where a ship runs to reprovision. */
function nearestFood(world, ship) {
  let best = null, bestD = Infinity;
  for (const p of world.islands) {
    if ((p.stock.Food || 0) < 15) continue;
    const d = (p.x - ship.x) ** 2 + (p.y - ship.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Where a fed-up crew defects to: the nearest OTHER island with food to spare and fleet room. */
function defectionTarget(world, ship) {
  const r = world.rules;
  let best = null, bestD = Infinity;
  for (const p of world.islands) {
    if (p.id === ship.homeId) continue;
    if ((p.stock.Food || 0) < 20) continue;
    const owned = world.ships.reduce((n, s) => n + (s.homeId === p.id ? 1 : 0), 0);
    if (owned >= r.MAX_SHIPS_PER_ISLAND) continue;
    const d = (p.x - ship.x) ** 2 + (p.y - ship.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Should a worried captain abandon his plan and run for the nearest larder? True when food is
 *  low (skilled captains act sooner) or morale is sliding — and there's a reachable food port
 *  that isn't already his next stop. Returns that island, or null. Called from goals/ship. */
export function deviationTarget(world, ship) {
  const r = world.rules;
  if (!ship.voyage || ship.voyage.reason === 'resupply' || ship.voyage.reason === 'food') return null;
  const worryDays = r.WORRY_FOOD_DAYS + skill01(ship.captain, r) * r.WORRY_FOOD_SKILL;
  if (foodDaysAboard(world, ship) > worryDays && ship.morale > 0.4) return null;
  const nextId = ship.voyage.stops[ship.voyage.index] ? ship.voyage.stops[ship.voyage.index].islandId : null;
  let best = null, bestD = Infinity;
  for (const p of world.islands) {
    if (p.id === ship.homeId || p.id === nextId) continue;
    if ((p.stock.Food || 0) < 15) continue;
    const d = (p.x - ship.x) ** 2 + (p.y - ship.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
