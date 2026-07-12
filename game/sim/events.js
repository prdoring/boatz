// World events — the discrete shocks that keep the economy from settling into a steady
// state. They mostly PERTURB (drop a production rate, kill some population, sink a ship)
// and let the existing systems (pricing → trade → reputation → migration) propagate the
// consequences, which is where the emergent cascades come from. Deterministic (seeded
// RNG stream) and serialisable (state lives on islands/ships + world.events). PURE.
//
//   BLIGHT   — a crop/forest/livestock island's PRIMARY production collapses for a while
//              (`effectiveRate` reads island.blight). Its exports dry up → shortage →
//              price spike → importers scramble → reputation & migration shift.
//   PLAGUE   — population dies off + production is penalised while infected; it SPREADS
//              along trade routes (ships are the vector), so trade carries prosperity AND
//              contagion. Recovers after PLAGUE_DAYS.
//   WRECK    — a ship founders at sea (odds ∝ distance sailed); the vessel + all cargo
//              (goods, coin, and any migrants aboard) are lost. A real sink.

import { streamFloat } from './rng.js';
import { foodDays } from './island.js';

const CROPS = new Set(['Grain', 'Meat', 'Fiber', 'Wood']); // organic → can blight

export function logEvent(world, kind, text, extra = {}) {
  const day = Math.floor(world.simTime / world.rules.SIM_DAY_SECONDS) + 1;
  world.events.push({ day, kind, text, ...extra });
  const max = world.rules.EVENT_LOG_MAX || 40;
  if (world.events.length > max) world.events.splice(0, world.events.length - max);
}

/** Like logEvent, but ambient/recurring kinds (famine, alliances, rivalries) are rate-limited
 *  per kind so they don't flood the ticker — they're common under the hood, only occasionally
 *  newsworthy. Returns whether it logged. */
export function logEventThrottled(world, kind, cooldownSec, text, extra = {}) {
  if (!world._evCd) world._evCd = {};
  if (world.simTime < (world._evCd[kind] || 0)) return false;
  world._evCd[kind] = world.simTime + cooldownSec;
  logEvent(world, kind, text, extra);
  return true;
}

function pick(world, pred) {
  const pool = world.islands.filter(pred);
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(streamFloat(world, 'events') * pool.length))];
}

function currentDay(world) { return Math.floor(world.simTime / world.rules.SIM_DAY_SECONDS); }

function startBlight(world, island) {
  island.blight = { res: island.primary, until: currentDay(world) + world.rules.BLIGHT_DAYS };
  logEvent(world, 'blight', `Blight strikes ${island.name}'s ${island.primary}`, { islandId: island.id });
}

function startPlague(world, island) {
  island.plague = { until: currentDay(world) + world.rules.PLAGUE_DAYS };
  logEvent(world, 'plague', `Plague breaks out on ${island.name}`, { islandId: island.id });
}

/** Plague vector: called when a ship docks. An infected port infects the ship; an
 *  infected ship can seed the plague at a healthy port. */
export function shipDockDisease(world, island, ship) {
  const t = world.rules;
  if (island.plague && !ship.infected) {
    if (streamFloat(world, 'plague') < t.PLAGUE_SHIP_INFECT) ship.infected = true;
  } else if (ship.infected && !island.plague) {
    if (streamFloat(world, 'plague') < t.PLAGUE_SPREAD) startPlague(world, island);
  }
}

/** Roll whether a moving ship founders this step (probability ∝ distance sailed). Marks
 *  the ship `_sunk` (the ship system removes it) and logs a wreck. */
export function maybeSink(world, ship, distance) {
  const t = world.rules;
  if (!t.SINK_PER_1000 || distance <= 0) return false;
  // Never sink a port's LAST ship — with no ship it couldn't even sail to buy a
  // replacement, so it would be stranded (can't import food) forever.
  let homeFleet = 0;
  for (const s of world.ships) if (s.homeId === ship.homeId) homeFleet++;
  if (homeFleet <= 1) return false;
  if (streamFloat(world, 'sink') >= t.SINK_PER_1000 * distance / 1000) return false;
  const home = world.islandsById.get(ship.homeId);
  logEvent(world, 'wreck', `A ${home ? home.name : 'merchant'} ship was lost at sea`, { x: ship.x, y: ship.y });
  ship._sunk = true; // cargo (goods + coin + migrants) goes down with it
  return true;
}

/** SIM system (once per sim-day): expire + roll blights/plagues and apply plague mortality. */
export function events(world) {
  const t = world.rules;
  const day = currentDay(world);
  if (day === world._eventDay) return;
  world._eventDay = day;

  for (const isl of world.islands) {
    if (isl.blight && day >= isl.blight.until) {
      logEvent(world, 'recover', `${isl.name}'s ${isl.blight.res} recovers`, { islandId: isl.id });
      isl.blight = null;
    }
    if (isl.plague) {
      if (day >= isl.plague.until) {
        logEvent(world, 'recover', `The plague on ${isl.name} passes`, { islandId: isl.id });
        isl.plague = null;
      } else {
        isl.population = Math.max(t.POP_FLOOR, isl.population * (1 - t.PLAGUE_MORTALITY_PER_DAY));
      }
    }
    // FAMINE — a port's larder runs dry (once per episode; clears when it recovers). Throttled
    // so a fleet-wide food crunch is one headline, not sixty.
    const fd = foodDays(isl, t);
    if (fd < t.FAMINE_FOOD_DAYS && !isl._famine && isl.population > t.POP_FLOOR * 3) {
      isl._famine = true;
      logEventThrottled(world, 'famine', t.SIM_DAY_SECONDS, `Famine grips ${isl.name}`, { islandId: isl.id });
    } else if (fd > t.FOOD_SECURITY_DAYS && isl._famine) {
      isl._famine = false;
    }
    // BOOM — a port reaches a thriving milestone (once, until it falls back).
    if (isl.civ >= t.BOOM_CIV && isl.population >= t.BOOM_POP_FRAC * isl.k && !isl._boomed) {
      isl._boomed = true;
      logEvent(world, 'boom', `${isl.name} is booming — a thriving port`, { islandId: isl.id });
    } else if (isl.civ < t.BOOM_CIV - 0.15 && isl._boomed) {
      isl._boomed = false;
    }
  }

  if (streamFloat(world, 'events') < t.BLIGHT_DAILY_CHANCE) {
    const target = pick(world, (i) => CROPS.has(i.primary) && !i.blight);
    if (target) startBlight(world, target);
  }
  if (streamFloat(world, 'events') < t.PLAGUE_SPONTANEOUS_CHANCE) {
    const target = pick(world, (i) => !i.plague && i.population > t.POP_FLOOR * 3);
    if (target) startPlague(world, target);
  }
}
