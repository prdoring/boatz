// Sim scaling benchmark — `node scripts/bench-sim.mjs [Ns] [warmup] [measure] [rosterSeed]`
//   Ns       comma-separated island counts (default "60,250,500,1000")
//   warmup   substeps to run before measuring, so ships are underway (default 600)
//   measure  substeps to time for the per-substep cost (default 200)
// Run with `node --expose-gc` for accurate heap numbers.
//
// Times the hot paths the perf plan targets — buildWorld, one sim substep, the two
// broadcast projections (snapshotEconomy/snapshotShips), and a full serialize — across N so
// super-linear costs (maybeSink O(S²), updateShipDemand/sightAtSea O(N·S), the O(N²) rep/
// belief broadcast summaries, and the O(N²·G) save) show up as growth vs N. PURE node
// (relative imports + fs; no engine, no loader).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWorld, stepWorld, worldTotals } from '../game/sim/world.js';
import { generateRoster } from '../game/sim/roster.js';
import { snapshotEconomy, snapshotShips } from '../game/sim/snapshot.js';
import { serializeWorld } from '../game/sim/serialize.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const economyRaw = JSON.parse(readFileSync(path.join(dir, '..', 'data', 'economy.json'), 'utf8'));

const Ns = (process.argv[2] || '60,250,500,1000').split(',').map(Number);
const WARMUP = Number(process.argv[3] || 600);
const MEASURE = Number(process.argv[4] || 200);
const ROSTER_SEED = Number(process.argv[5] || 1);
const STEP = economyRaw.tuning.SIM_STEP; // one substep

const nowNs = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
function timeIt(fn) { const a = nowNs(); const r = fn(); return { ms: ms(a, nowNs()), r }; }
function gc() { if (global.gc) { global.gc(); global.gc(); } }
function heapMB() { return process.memoryUsage().heapUsed / (1024 * 1024); }

console.log(`bench: Ns=[${Ns}] warmup=${WARMUP} measure=${MEASURE} rosterSeed=${ROSTER_SEED}`
  + (global.gc ? '' : '  (run with --expose-gc for accurate heap)'));
console.log(
  ['N', 'ships', 'build ms', 'substep µs', '@1× ms/s', '@10× ms/s', 'econ ms', 'ships ms', 'save ms', 'save MB', 'heap MB'].map((h) => h.padStart(11)).join(' '),
);

for (const N of Ns) {
  const roster = generateRoster(ROSTER_SEED, N);
  const mkEconomy = () => structuredClone(economyRaw);

  gc(); const heap0 = heapMB();
  const build = timeIt(() => buildWorld({ economy: mkEconomy(), roster, seed: 1337 }));
  const world = build.r;
  gc(); const heapBuilt = heapMB() - heap0;

  for (let i = 0; i < WARMUP; i++) stepWorld(world, STEP); // get ships underway
  const S = world.ships.length;

  const stepMs = timeIt(() => { for (let i = 0; i < MEASURE; i++) stepWorld(world, STEP); }).ms;
  const perSubstepUs = (stepMs / MEASURE) * 1000;
  const econMs = timeIt(() => snapshotEconomy(world)).ms;
  const shipsMs = timeIt(() => snapshotShips(world)).ms;
  const save = timeIt(() => serializeWorld(world));
  const saveMB = JSON.stringify(save.r).length / (1024 * 1024);

  const perSubstepMs = perSubstepUs / 1000;
  const row = [
    N, S,
    build.ms.toFixed(1),
    perSubstepUs.toFixed(1),
    (perSubstepMs * 20).toFixed(1),   // ~20 substeps/s at 1×
    (perSubstepMs * 200).toFixed(1),  // up to 200 substeps/s at 10×
    econMs.toFixed(1),
    shipsMs.toFixed(1),
    save.ms.toFixed(0),
    saveMB.toFixed(1),
    heapBuilt.toFixed(0),
  ];
  console.log(row.map((v) => String(v).padStart(11)).join(' '));
  void worldTotals; // (kept import parity with run-headless; not needed here)
}
