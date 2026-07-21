// Mutable island industry — the WORKSHOP MODEL foundation (Phase 1 T4 refactor). Workshops are the
// canonical source of truth (`island.produces` is a derived cache), a workshop's 0..1 condition
// scales its output, and the model round-trips through serialize — including legacy saves written
// before the field existed. PURE-sim tests (single-system stepping, per simGovernance.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, economyRaw } from './helpers/simWorld.js';
import { mutateWorkshops, workshopStaffing, slotCap } from '/game/sim/island.js';
import { produceGoods } from '/game/sim/production.js';
import { upkeep } from '/game/sim/upkeep.js';
import { serializeWorld, deserializeWorld } from '/game/sim/serialize.js';

test('every island seeds workshops from produces byte-identically (produces === workshops goods)', () => {
  const w = makeWorld();
  for (const isl of w.islands) {
    assert.ok(Array.isArray(isl.workshops), `${isl.id} has a workshops array`);
    assert.deepEqual(isl.produces, isl.workshops.map((s) => s.good), `${isl.id}: produces mirrors workshops`);
    for (const s of isl.workshops) assert.equal(s.condition, 1, 'a fresh workshop is in full condition');
  }
});

test('mutateWorkshops is the single mutator: rebuilds produces and marks the producer index dirty', () => {
  const w = makeWorld();
  const isl = w.islands.find((i) => i.workshops.length > 0);
  w._producersDirty = false;
  mutateWorkshops(w, isl, [{ good: 'LuxuryGoods', condition: 0.8 }, { good: 'Food', condition: 1 }]);
  assert.deepEqual(isl.produces, ['LuxuryGoods', 'Food'], 'produces is rebuilt from the new workshops');
  assert.equal(w._producersDirty, true, 'the per-good producer index is marked dirty for a coalesced flush');
});

test('an INDUSTRIAL workshop in disrepair makes far less; the raw-input path is unaffected', () => {
  const w = makeWorld();
  const t = w.rules;
  const gunIsl = w.islands.find((i) => i.workshops.some((s) => s.good === 'Weapons'));
  assert.ok(gunIsl, 'found a weapons-workshop island');
  const wsp = gunIsl.workshops.find((s) => s.good === 'Weapons');
  // Small pop so the population term (not an input cap) binds → condition scales output directly.
  gunIsl.population = 20;
  const run = (cond) => {
    wsp.condition = cond;
    gunIsl.stock.Iron = t.STOCKPILE_CAP; gunIsl.stock.Wood = t.STOCKPILE_CAP; gunIsl.stock.Weapons = 0;
    produceGoods(w, t.SIM_STEP);
    return gunIsl.stock.Weapons;
  };
  const madeHealthy = run(1);
  const madeDerelict = run(0.1);
  assert.ok(madeHealthy > 0, 'a healthy workshop makes weapons');
  assert.ok(madeDerelict < madeHealthy * 0.5, `derelict output (${madeDerelict}) far below healthy (${madeHealthy})`);
});

test('Food is NEVER condition-gated (survival good rides the full-rate path)', () => {
  const w = makeWorld();
  const t = w.rules;
  const foodIsl = w.islands.find((i) => i.workshops.some((s) => s.good === 'Food'));
  assert.ok(foodIsl, 'found a food-producing island');
  const fw = foodIsl.workshops.find((s) => s.good === 'Food');
  foodIsl.population = 20;
  const run = (cond) => {
    fw.condition = cond;
    foodIsl.stock.Grain = t.STOCKPILE_CAP; foodIsl.stock.Meat = t.STOCKPILE_CAP; foodIsl.stock.Food = 0;
    produceGoods(w, t.SIM_STEP);
    return foodIsl.stock.Food;
  };
  const madeFull = run(1);
  const madeStarvedShop = run(0.05); // even a "derelict" Food workshop must produce full — it's not gated
  assert.ok(madeFull > 0, 'food is produced');
  assert.equal(madeStarvedShop, madeFull, 'Food output ignores workshop condition (no famine death-spiral)');
});

test('an under-staffed workshop decays toward disrepair; a re-peopled one mends back (upkeep drift)', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands.find((i) => i.workshops.some((s) => t.INDUSTRIAL_GOODS.includes(s.good)));
  const shop = isl.workshops.find((s) => t.INDUSTRIAL_GOODS.includes(s.good));
  // Starve of LABOUR (tiny pop) with the treasury kept full so FUNDING isn't the cause.
  isl.population = 5; isl.gold = t.GOLD_MAX_PER_POP * 5; shop.condition = 1;
  assert.ok(workshopStaffing(isl, t) < 0.5, 'a 5-soul port cannot crew its works');
  for (let d = 0; d < 20; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  const decayed = shop.condition;
  assert.ok(decayed < 0.8, `understaffed workshop rotted (condition ${decayed.toFixed(2)})`);
  assert.equal(shop._st !== 0, true, 'its status byte reads idle/derelict, not running');
  // Re-people it → labour returns, condition mends.
  isl.population = 400; isl.gold = t.GOLD_MAX_PER_POP * 400;
  for (let d = 0; d < 20; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.ok(shop.condition > decayed + 0.2, `re-peopled workshop mended (condition ${shop.condition.toFixed(2)})`);
});

test('an unfunded workshop (empty treasury, income halted) also rots — funding drives disrepair', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands.find((i) => i.workshops.some((s) => t.INDUSTRIAL_GOODS.includes(s.good)));
  const shop = isl.workshops.find((s) => t.INDUSTRIAL_GOODS.includes(s.good));
  isl.population = 400;                 // fully staffed → isolate the FUNDING effect
  isl.gold = 0; isl.rebellion = { until: 1e15 }; // income halted, no coin → the bill can't be paid
  shop.condition = 1;
  assert.equal(workshopStaffing(isl, t), 1, 'staffing is full so only funding can be the cause');
  for (let d = 0; d < 25; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.ok(shop.condition < 0.5, `unfunded workshop rotted (condition ${shop.condition.toFixed(2)})`);
});

test('a Food workshop never decays or carries a status byte (survival good is not industrial)', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands.find((i) => i.workshops.some((s) => s.good === 'Food'));
  const foodShop = isl.workshops.find((s) => s.good === 'Food');
  isl.population = 5; isl.gold = 0; isl.civ = 0; // maximally starved
  for (let d = 0; d < 30; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.equal(foodShop.condition, 1, 'Food workshop condition is untouched by starvation');
  assert.equal(foodShop._st, undefined, 'Food workshop carries no industrial status byte');
});

test('slotCap: pop-tiered base + development, floored by built workshops, capped at MAX_SLOTS', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  const have = isl.workshops.filter((s) => t.INDUSTRIAL_GOODS.includes(s.good)).length;
  isl.population = 80; isl.development = 0;
  assert.equal(slotCap(isl, t), Math.max(have, t.SLOT_BASE), 'base slots at seed population');
  isl.population = t.SLOT_POP_TIERS[0] + 1;
  assert.equal(slotCap(isl, t), Math.max(have, t.SLOT_BASE + 1), 'crossing a pop tier grants a slot');
  isl.population = 1e9; isl.development = 100;
  assert.equal(slotCap(isl, t), t.MAX_SLOTS, 'capped at MAX_SLOTS regardless of pop/development');
  isl.population = 80; isl.development = 0;
  isl.workshops = Array.from({ length: t.MAX_SLOTS + 2 }, () => ({ good: 'Weapons', condition: 1 }));
  assert.equal(slotCap(isl, t), t.MAX_SLOTS + 2, 'floored by however many workshops it already runs');
});

test('workshops round-trip through serialize; a legacy save (no workshops) hydrates from produces', () => {
  const w = makeWorld();
  const isl0 = w.islands[0];

  const restored = deserializeWorld(serializeWorld(w), structuredClone(economyRaw));
  const r0 = restored.islandsById.get(isl0.id);
  assert.deepEqual(r0.workshops.map((s) => s.good), isl0.workshops.map((s) => s.good), 'workshops survive save/load');

  const blob = serializeWorld(w);
  for (const isl of blob.islands) delete isl.workshops; // simulate a pre-feature save
  const legacy = deserializeWorld(blob, structuredClone(economyRaw));
  const l0 = legacy.islandsById.get(isl0.id);
  assert.ok(Array.isArray(l0.workshops), 'legacy island re-seeds a workshops array');
  assert.deepEqual(l0.workshops.map((s) => s.good), l0.produces, 'hydrated workshops match produces');
});
