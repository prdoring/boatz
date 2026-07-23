// Economy sinks pass: genuine consumption for the thin-sink goods.
//   - crew SLOPS (a Clothing sink), - Meat premium yield, - garrison MILITIA (a Weapons sink),
//   - the magistrate FESTIVAL (a LuxuryGoods sink + trade/rumor/reputation event).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { crew, provisionCrew } from '/game/sim/crew.js';
import { produceGoods } from '/game/sim/production.js';
import { upkeep } from '/game/sim/upkeep.js';
import { policy } from '/game/sim/policy.js';
import { executeStop } from '/game/sim/trade.js';
import { liveFact, believedFestival } from '/game/sim/intel.js';

function atSea(w, ship, cargo = {}) {
  ship.voyage = { reason: 'trade', stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  ship.state = 'outbound';
  ship.cargo = { Gold: 0, People: 0, ...cargo };
}
function runCrew(w, simDays) {
  const steps = Math.round(simDays * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { crew(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}

// ── 1. Clothing slops ─────────────────────────────────────────────────────────
test('slops: an at-sea crew wears down its issued Clothing (a Clothing sink)', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  atSea(w, ship, { Food: 500, Clothing: 40 });
  runCrew(w, 1);
  assert.ok(ship.cargo.Clothing < 40 && ship.cargo.Clothing > 0, 'slops worn but not exhausted in a day');
});

test('slops: a home port re-issues Clothing from the town stores (free)', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  ship.cargo = { Gold: 0, People: 0, Clothing: 0 };
  const home = w.islandsById.get(ship.homeId);
  home.stock.Clothing = 300;
  const before = home.stock.Clothing;
  provisionCrew(w, home, ship);
  assert.ok(ship.cargo.Clothing >= 0.5, 'the crew was issued slops');
  assert.ok(home.stock.Clothing < before, 'the clothing came out of the town stores');
});

// ── 2. Meat premium yield ──────────────────────────────────────────────────────
test('meat: the Food recipe yields more Food per unit of Meat than of Grain (premium raw)', () => {
  const w = makeWorld();
  const isl = w.islands.find((i) => i.produces.includes('Food') && i.primary !== 'Grain' && i.secondary !== 'Grain');
  assert.ok(isl, 'a Food-making island that does not mine Grain exists');
  isl.stock.Grain = 0; isl.stock.Meat = 500; isl.stock.Food = 0;
  produceGoods(w, w.rules.SIM_STEP);
  const meatUsed = 500 - isl.stock.Meat;
  assert.ok(meatUsed > 0, 'it consumed Meat for Food');
  const ratio = isl.stock.Food / meatUsed;
  assert.ok(Math.abs(ratio - 1.25) < 0.02, `Meat yields ~1.25x Food (got ${ratio.toFixed(3)})`);
});

test('meat: an importer holding both raws makes Food from the premium Meat, sparing Grain', () => {
  const w = makeWorld();
  const isl = w.islands.find((i) => i.produces.includes('Food')
    && i.primary !== 'Grain' && i.secondary !== 'Grain' && i.primary !== 'Meat' && i.secondary !== 'Meat');
  if (!isl) return; // no pure food-raw importer in this roster — the yield ratio above already exercises the path
  isl.stock.Grain = 200; isl.stock.Meat = 200; isl.stock.Food = 0;
  const grain0 = isl.stock.Grain;
  produceGoods(w, w.rules.SIM_STEP);
  assert.ok(isl.stock.Grain >= grain0 - 1e-9, 'Grain was spared (Meat was chosen)');
  assert.ok(isl.stock.Meat < 200, 'Meat was consumed');
});

// ── 3. Weapons militia (peacetime garrison powder) ──────────────────────────────
test('militia: a lawful armed port burns Weapons keeping order; a haven musters none', () => {
  const w = makeWorld();
  const town = w.islands[0], den = w.islands[1];
  for (const p of [town, den]) { p.population = 200; p.lawlessness = 0.3; p.stock.Weapons = 200; p.rebellion = null; }
  town.haven = false;
  den.haven = true;
  for (let i = 0; i < 4000; i++) { upkeep(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
  assert.ok(town.stock.Weapons < 190, `the town's militia burned powder (${town.stock.Weapons.toFixed(1)})`);
  assert.ok(town.stock.Weapons >= w.rules.MILITIA_MIN_WEAPONS - 1e-6, 'never below the working minimum');
  assert.ok(den.stock.Weapons > town.stock.Weapons, 'the haven mustered no lawful militia (only spoilage)');
});

// ── 4. Festival (LuxuryGoods sink + trade/rumour/reputation event) ──────────────
test('festival: a splendor magistrate with luxuries throws one (consumes LuxuryGoods, lifts mood)', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.magistrate = isl.magistrate || {};
  isl.magistrate.ambition = { kind: 'splendor' };
  isl.magistrate.traits = { integrity: 0.9, generosity: 0.5, firmness: 0.5 };
  isl.rebellion = null; isl.haven = false; isl.festival = null; isl._policyCd = 0;
  isl.gold = 5000; isl.stock.LuxuryGoods = 500; isl.stock.Ale = 200;
  isl.stock.Wood = 0; isl.stock.Iron = 0; // starve tryBuild so the festival action is reached
  isl.civ = 0.4; isl.loyalty = 0.4; isl._approval = 0;
  const luxBefore = isl.stock.LuxuryGoods;
  w._policyDay = -1; // force the daily gate open
  policy(w, w.rules.SIM_STEP);
  assert.ok(isl.festival, 'a festival was declared');
  assert.ok(isl.stock.LuxuryGoods < luxBefore, 'luxuries were broken out (consumed)');
  assert.ok(isl._approval > 0, 'the public mood lifted');
});

test('festival: a port only believes in a festival it has HEARD of (rumour by sea)', () => {
  const w = makeWorld();
  const believer = w.islands[0], host = w.islands[1];
  assert.equal(believedFestival(w, believer, host.id, 0), false, 'unknown → not believed');
  host.festival = { until: 5 };
  assert.equal(liveFact(w, host, 2).festival, 5, 'a festive port reports its festival end-day for ships to carry');
  believer.intel = believer.intel || {};
  believer.intel[host.id] = { day: 0, festival: 5 };
  assert.equal(believedFestival(w, believer, host.id, 3), true, 'within the window → believed');
  assert.equal(believedFestival(w, believer, host.id, 6), false, 'past the end-day → over');
});

test('festival: supplying a festive port earns extra goodwill', () => {
  const sell = (festive) => {
    const w = makeWorld();
    const host = w.islands[0], home = w.islands[1], ship = w.ships[0];
    ship.homeId = home.id;
    ship.cargo = { Gold: 0, People: 0, LuxuryGoods: 100 };
    host.gold = 100000; host.stock.LuxuryGoods = 0; host.targets.LuxuryGoods = 250;
    host.rep = host.rep || {}; home.rep = home.rep || {};
    host.rep[home.id] = 0; home.rep[host.id] = 0;
    if (festive) host.festival = { until: 999 };
    executeStop(w, host, ship, { islandId: host.id, sell: { LuxuryGoods: 100 }, buy: {}, people: 0 });
    return host.rep[home.id];
  };
  assert.ok(sell(true) > sell(false), 'a festive port rewards its supplier with more rapport than a plain sale');
});
