// Headless balance runner — `node game/sim/run-headless.mjs [days] [seed]`.
// Runs the pure sim with NO browser/server and logs per-sim-day metrics so the
// economy's stability can be eyeballed and tuned. Bare-node runnable: relative
// imports only, data loaded via fs (no engine, no loader).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWorld, stepWorld, worldTotals } from './world.js';
import { generateRoster } from './roster.js';
import { foodDays } from './island.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, '..', '..', 'data');
const economy = JSON.parse(readFileSync(path.join(dataDir, 'economy.json'), 'utf8'));

const days = Number(process.argv[2] || 30);
const seed = process.argv[3] ? Number(process.argv[3]) : 1337;
const rosterSeed = process.argv[4] ? Number(process.argv[4]) : 1; // `node run-headless.mjs [days] [simSeed] [rosterSeed]`
const roster = generateRoster(rosterSeed);
const world = buildWorld({ economy, roster, seed });
const DAY = economy.tuning.SIM_DAY_SECONDS;
const gold0 = worldTotals(world).gold;
const ships0 = world.ships.length;
const nextId0 = world.nextEntityId;

function cov(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return m ? Math.sqrt(v) / m : 0;
}
function gini(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length, sum = s.reduce((a, b) => a + b, 0);
  if (!sum) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * s[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

console.log('day  Σgold   Σpop  minFoodDays  minPop  maxStock%  CoV(pop)  Gini(gold)  runs  ships nonIdle');
for (let d = 1; d <= days; d++) {
  for (let s = 0; s < DAY; s++) stepWorld(world, 1.0);
  const totals = worldTotals(world);
  const pops = world.islands.map((i) => i.population);
  const golds = world.islands.map((i) => i.gold);
  const minFood = Math.min(...world.islands.map((i) => foodDays(i, economy.tuning)));
  const maxStockPct = Math.max(...world.islands.flatMap((i) =>
    Object.values(i.stock).map((v) => v / economy.tuning.STOCKPILE_CAP)));
  const runs = world.islands.reduce((a, i) => a + i._runs, 0);
  const nonIdle = world.ships.filter((s) => s.state !== 'idle').length;
  console.log(
    String(d).padStart(3),
    Math.round(totals.gold).toString().padStart(6),
    Math.round(totals.people).toString().padStart(5),
    minFood.toFixed(2).padStart(11),
    Math.floor(Math.min(...pops)).toString().padStart(6),
    (maxStockPct * 100).toFixed(0).padStart(8) + '%',
    cov(pops).toFixed(3).padStart(9),
    gini(golds).toFixed(3).padStart(10),
    runs.toString().padStart(5),
    world.ships.length.toString().padStart(5),
    nonIdle.toString().padStart(6),
  );
}
const yardStock = world.islands.filter((i) => i.produces.includes('Ships')).map((i) => `${i.name}:${Math.round(i.stock.Ships)}`);
const bought = world.nextEntityId - nextId0;   // ships spawned via purchase during the run
const gained = world.ships.length - ships0;
console.log(`\ngold drift: ${(worldTotals(world).gold - gold0).toFixed(4)} (conserved — should be ~0)`);
console.log(`ships: ${ships0} -> ${world.ships.length} (bought ${bought}, net ${gained >= 0 ? '+' : ''}${gained})  |  shipyard Ships stock: ${yardStock.join(', ')}`);
const byGold = world.islands.map((i) => `${i.name} ${Math.round(i.gold)}g/${Math.round(i.population)}p/civ${i.civ.toFixed(2)}/${world.ships.filter((s) => s.homeId === i.id).length}sh`).sort();
console.log('islands:', byGold.join('  |  '));
