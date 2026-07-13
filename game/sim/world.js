// World construction + the fixed-timestep substep driver. PURE (no engine/config
// import): the host injects the deep-cloned economy + roster + seed.
//
// stepWorld runs the SIM pipeline in fixed SIM_STEP (0.05s) substeps: `dtSim`
// (= speed*realDt, from the clock) sets the NUMBER of substeps, never the step
// size. So 10x fast-forward is literally ten 1x steps — identical dynamics and
// determinism at every speed, and the stability math holds in the played regime.

import { streamFloat } from './rng.js';
import { createIsland } from './island.js';
import { createShip } from './ship.js';
import { SIM_SYSTEMS } from './systems.js';
import { initReputation } from './reputation.js';
import { initWind } from './wind.js';
import { initWeather } from './weather.js';
import { makeCaptain } from './captains.js';
import { installMagistrate } from './magistrate.js';
import { turnPirate } from './piracy.js';
import { shipName } from './naming.js';
import { REFERENCE_ISLANDS } from './roster.js';
import { GOLD, PEOPLE } from './resources.js';

/** Scale the count-dependent caps to the SIZE of the sea, relative to the REFERENCE_ISLANDS (60)
 *  baseline the economy was tuned at — so density stays constant as the island count grows: the
 *  global fleet cap tracks the fleet (else a 250-island sea starts over-cap and its fleet only
 *  decays → ports can't replace lost ships → famine), and pirate presence keeps pace (else the
 *  seeded rogues + the at-large floor are lost in a far bigger ocean). A NO-OP at N ≤ REFERENCE
 *  (max/guard keeps the tuned values), so seeded 60-island tests stay byte-identical. Mutates the
 *  per-world tuning clone (the host deep-clones the economy per world, so this is once-per-world). */
export function scaleTuningForCount(tuning, n) {
  const f = n / REFERENCE_ISLANDS;
  if (f <= 1) return; // small seas keep the tuned constants exactly
  // The global fleet cap tracks the sea so a bigger world isn't born already over-cap — otherwise its
  // fleet can only DECAY (the cap forbids replacement), ports can't rebuild lost hulls, and remote
  // outposts starve into abandonment. NOTE we deliberately do NOT raise START_SHIPS_PER_ISLAND with N:
  // adding ships globally never reaches an orphaned outpost (it keeps 0 ships homed either way) and only
  // adds crew-food demand + upkeep drain — measured, it makes the starving-island tail slightly WORSE.
  tuning.MAX_SHIPS_TOTAL = Math.max(tuning.MAX_SHIPS_TOTAL, Math.round(n * tuning.START_SHIPS_PER_ISLAND * 2.2));
  // Pirate presence keeps pace with the sea so the seeded rogues + at-large floor aren't lost in it.
  tuning.START_PIRATES = Math.round((tuning.START_PIRATES || 0) * f);
  tuning.MIN_PIRATES_AT_LARGE = Math.round((tuning.MIN_PIRATES_AT_LARGE || 0) * f);
}

/** A starting hull for a port's fleet, reflecting its size: big ports launch brigs and the odd
 *  galleon; modest ports run fast little sloops — with seeded variety so no two fleets are alike. */
function startingHull(world, isl, tuning) {
  const types = tuning.SHIP_TYPES;
  if (!types) return tuning.SHIP_DEFAULT_TYPE || 'ship';
  const roll = streamFloat(world, 'init');
  const big = (isl.k || 120) >= 125;
  if (big) return roll < 0.3 ? 'galleon' : roll < 0.85 ? 'brig' : 'sloop';
  return roll < 0.5 ? 'sloop' : roll < 0.9 ? 'brig' : 'galleon';
}

/** Prepare derived lookups on the (cloned) economy so systems stay allocation-free. */
export function prepareEconomy(economy) {
  economy._recipeByOut = {};
  for (const r of economy.recipes) economy._recipeByOut[r.out] = r;
  economy._tradeables = [...economy.raw, ...economy.goods];
  return economy;
}

export function buildWorld({ economy, roster, seed = 1337 }) {
  prepareEconomy(economy);
  const tuning = economy.tuning;
  scaleTuningForCount(tuning, roster.islands.length); // count-dependent caps scale with the sea (no-op at N≤60)

  const world = {
    seed: seed >>> 0,
    rngStreams: {},
    simTime: 0,
    tick: 0,
    mapW: roster.ocean.width,
    mapH: roster.ocean.height,
    speed: 1,
    paused: false,
    dtSim: 0,
    controls: { allowTimeScale: true },
    rules: tuning,
    economy,
    agents: { npc: { kind: 'npc' } },
    intents: [],
    nextEntityId: 1,
    islands: [],
    islandsById: new Map(),
    ships: [],
    spatialIndex: null, // reserved for a grid/regional index at scale
    totals: { gold: 0, people: 0 },
    events: [],         // rolling world event log (blight/plague/wreck) for the news feed
    _eventDay: -1,
  };

  for (const spec of roster.islands) {
    const isl = createIsland(spec, economy, tuning);
    world.islands.push(isl);
    world.islandsById.set(isl.id, isl);
  }

  // Small seeded jitter so different seeds diverge (and same seed reproduces).
  for (const isl of world.islands) {
    isl.population = tuning.START_POP * (0.9 + 0.2 * streamFloat(world, 'init'));
    isl.stock[isl.primary] = tuning.STOCKPILE_CAP * 0.15 * (0.8 + 0.4 * streamFloat(world, 'init'));
    // A starting larder so the fleet can victual from day one (Food is otherwise produced from
    // scratch, which would starve every crew before production ramps — a cold-start mass mutiny).
    isl.stock.Food = 190 * (0.8 + 0.4 * streamFloat(world, 'init'));
    // Governance: a magistrate rules each island; the populace starts reasonably loyal.
    isl.loyalty = tuning.LOYALTY_STEADY_BASE + 0.2;
    isl.lawlessness = tuning.LAWLESS_BASE; // civil (dis)order, 0..1 — the seed of pirate havens
    isl.unrest = 0;
    isl.rebellion = null;
    isl._rebelCd = 0;
    isl.danger = 0;   // how pirate-haunted these waters are (0..1) — set by attacks, decays in antipiracy
    isl._privCd = 0;  // simTime before which it won't commission another privateer
    installMagistrate(world, isl); // seat a named magistrate with an economic agenda; retargets the economy
  }

  for (const isl of world.islands) {
    for (let i = 0; i < tuning.START_SHIPS_PER_ISLAND; i++) {
      const s = createShip(world.nextEntityId++, isl, tuning, startingHull(world, isl, tuning));
      s.captain = makeCaptain(world); // every ship is run by a named, improving captain
      s.name = shipName(world);
      world.ships.push(s);
    }
  }

  // A few RAIDERS already at large when the world boots. Piracy otherwise only emerges once crews
  // start to mutiny (rare until food runs thin) or a haven forms (mid-game), so the early seas would
  // be empty of any black flag for a long while. Seed a handful of rogues out on the water under
  // fearsome captains, so there's a threat to see (and privateers to answer it) from day one — the
  // usual fleet-fraction cap + privateers keep it self-limiting from there.
  seedStartPirates(world, tuning);

  // Seed every pair's reputation just above/below neutral (the diplomatic layer).
  initReputation(world, tuning.REP_INIT_SPREAD);
  initWeather(world); // season + storms (before wind, which reads the prevailing trade winds)
  initWind(world);    // one drifting global wind vector, biased by the season's prevailing set



  world.totals = worldTotals(world);
  return world;
}

/** Drop START_PIRATES rogue sloops onto the open sea at genesis (deterministic). Each is a fresh
 *  pirate under a fearsome captain, homed to a random port only as a label; they begin hunting at
 *  once. Bounded by START_PIRATES (small) and thereafter by the usual PIRATE_MAX_FRAC cap. */
function seedStartPirates(world, tuning) {
  const n = tuning.START_PIRATES || 0;
  for (let k = 0; k < n; k++) {
    const anchor = world.islands[Math.floor(streamFloat(world, 'init') * world.islands.length)] || world.islands[0];
    if (!anchor) break;
    // A fearsome BRIG, not a flimsy sloop: seeded pirates must survive armed merchants fending them
    // off AND the privateers ports commission within a day, or they're wiped before ever being seen.
    const s = createShip(world.nextEntityId++, anchor, tuning, 'brig');
    s.x = streamFloat(world, 'init') * world.mapW; // scattered across open water, not sitting in a port
    s.y = streamFloat(world, 'init') * world.mapH;
    s.cargo.Food = tuning.CREW_FOOD_PER_DAY * tuning.PROVISION_DAYS * 3; // enough to hunt before it must raid
    const spec = tuning.SHIP_TYPES && tuning.SHIP_TYPES.brig;
    s.cargo.Weapons = spec ? spec.weaponCap * 0.7 : 14; // a full fighting complement of guns
    s.captain = makeCaptain(world);
    s.name = shipName(world);
    world.ships.push(s);
    turnPirate(world, s); // raise the black flag (fresh pirate captain + hunting state; logs 'pirate')
  }
}

/** Conserved totals — the invariant probe for tests. */
export function worldTotals(world) {
  let gold = 0, people = 0;
  for (const isl of world.islands) { gold += isl.gold; people += isl.population; }
  for (const s of world.ships) { gold += s.cargo[GOLD] || 0; people += s.cargo[PEOPLE] || 0; }
  return { gold, people };
}

/**
 * Advance the world by `dtSim` sim-seconds, in fixed SIM_STEP substeps.
 * `tick` is the authoritative loop tick (for systems that want it).
 */
export function stepWorld(world, dtSim, tick = world.tick + 1) {
  world.tick = tick;
  if (dtSim <= 0) return; // paused (or zero speed)
  const H = world.rules.SIM_STEP;
  let n = Math.ceil(dtSim / H);
  if (n > world.rules.MAX_SUBSTEPS) n = world.rules.MAX_SUBSTEPS;
  if (n < 1) n = 1;
  const h = dtSim / n;
  for (let i = 0; i < n; i++) {
    for (const sys of SIM_SYSTEMS) sys(world, h, tick);
    world.simTime += h;
  }
}

export { SIM_SYSTEMS };
