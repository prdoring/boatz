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
import { makeCaptain } from './captains.js';
import { makeMagistrate } from './magistrate.js';
import { shipName } from './naming.js';
import { GOLD, PEOPLE } from './resources.js';

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
    isl.magistrate = makeMagistrate(world);
    isl.loyalty = tuning.LOYALTY_STEADY_BASE + 0.2;
    isl.unrest = 0;
    isl.rebellion = null;
    isl._rebelCd = 0;
    isl.danger = 0;   // how pirate-haunted these waters are (0..1) — set by attacks, decays in antipiracy
    isl._privCd = 0;  // simTime before which it won't commission another privateer
  }

  for (const isl of world.islands) {
    for (let i = 0; i < tuning.START_SHIPS_PER_ISLAND; i++) {
      const s = createShip(world.nextEntityId++, isl, tuning);
      s.captain = makeCaptain(world); // every ship is run by a named, improving captain
      s.name = shipName(world);
      world.ships.push(s);
    }
  }

  // Seed every pair's reputation just above/below neutral (the diplomatic layer).
  initReputation(world, tuning.REP_INIT_SPREAD);
  initWind(world); // one drifting global wind vector



  world.totals = worldTotals(world);
  return world;
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
