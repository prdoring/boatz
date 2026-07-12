// Island governance: a magistrate, populace loyalty, and rebellion (production halts, then the
// magistrate holds power or is overthrown).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { governance, makeMagistrate, magSkill, magRank, magPersonality, retarget, installMagistrate, ambitionLabel } from '/game/sim/magistrate.js';
import { effectiveRate } from '/game/sim/island.js';

function run(w, days) {
  const steps = Math.round(days * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { governance(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}

test('makeMagistrate is deterministic and gives a name, traits, personality, portrait', () => {
  const a = makeMagistrate(makeWorld()), b = makeMagistrate(makeWorld());
  assert.equal(a.name, b.name);
  assert.deepEqual(a.traits, b.traits);
  assert.equal(typeof a.portrait, 'number');
  for (const k of ['firmness', 'generosity', 'integrity']) assert.ok(a.traits[k] >= 0 && a.traits[k] <= 1);
});

test('magSkill rises with xp; magRank climbs; magPersonality names the strongest trait', () => {
  const w = makeWorld();
  assert.equal(magSkill({ xp: 0 }, w.rules), 0);
  assert.ok(magSkill({ xp: 3000 }, w.rules) > magSkill({ xp: 300 }, w.rules));
  assert.equal(magRank({ xp: 0 }), 'Steward');
  assert.notEqual(magRank({ xp: 9000 }), 'Steward');
  assert.equal(magPersonality({ firmness: 0.95, generosity: 0.5, integrity: 0.5 }), 'Iron-fisted');
  assert.equal(magPersonality({ firmness: 0.5, generosity: 0.05, integrity: 0.5 }), 'Miserly');
  assert.equal(magPersonality({ firmness: 0.5, generosity: 0.5, integrity: 0.5 }), 'Even-handed');
});

test('a prosperous port trends loyal; famine drags loyalty down', () => {
  const w = makeWorld();
  const good = w.islands[0], starving = w.islands[1];
  good.civ = 0.7; good.stock.Food = 500; good.loyalty = 0.35; good._rebelCd = 1e9;
  starving.civ = 0.5; starving.stock.Food = 0; starving.population = 120; starving.loyalty = 0.6; starving._rebelCd = 1e9;
  run(w, 1.2);
  assert.ok(good.loyalty > 0.45, 'prosperity lifts loyalty toward a healthy steady state');
  assert.ok(starving.loyalty < 0.5, 'famine erodes loyalty');
});

test('sustained discontent erupts in rebellion, which halts production', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.loyalty = 0.05;
  isl.unrest = w.rules.REBEL_GRACE_DAYS + w.rules.REBEL_GRACE_FIRM + 5; // past any magistrate's patience
  isl._rebelCd = 0;
  const before = effectiveRate(isl, isl.primary, w.rules);
  governance(w, w.rules.SIM_STEP);
  assert.ok(isl.rebellion, 'the port rose in rebellion');
  assert.ok(before > 0 && effectiveRate(isl, isl.primary, w.rules) === 0, 'production is halted while aflame');
});

test('a magistrate governs toward an economic agenda that reshapes the island targets', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  assert.ok(isl.magistrate.ambition && typeof isl.magistrate.ambition.kind === 'string', 'every magistrate has an ambition');
  const foodBase = isl.targets.Food, weaponsBase = isl.targets.Weapons;
  // A defense agenda raises the appetite for weapons; a survival floor protects Food.
  isl.magistrate.ambition = { kind: 'fortify', progress: 0.35, milestone: false };
  retarget(isl, w.economy, w.rules);
  assert.ok(isl.targets.Weapons > weaponsBase, 'a fortify agenda raises the weapons target');
  assert.ok(isl.targets.Food >= foodBase, 'no agenda drops the Food target below its base');
  // A wealth agenda hoards coin by wanting LESS of the comforts (drives it to export them).
  isl.magistrate.ambition = { kind: 'wealth', progress: 0.35, milestone: false };
  retarget(isl, w.economy, w.rules);
  assert.ok(isl.targets.Ale < weaponsBase && isl.targets.Food >= foodBase, 'a wealth agenda lowers comfort targets but never Food');
});

test('lawlessness rises on a failing port and falls under prosperous, honest rule', () => {
  const w = makeWorld();
  const failing = w.islands[0], thriving = w.islands[1];
  failing.civ = 0.05; failing.stock.Food = 0; failing.population = 120; failing.lawlessness = 0.15; failing._rebelCd = 1e9;
  failing.magistrate = { name: 'Weak', xp: 0, traits: { firmness: 0, generosity: 0.5, integrity: 0.1 }, ambition: { kind: 'grow', progress: 0.35 } };
  thriving.civ = 0.9; thriving.stock.Food = 900; thriving.population = 100; thriving.lawlessness = 0.6; thriving._rebelCd = 1e9;
  thriving.magistrate = { name: 'Firm', xp: 6000, traits: { firmness: 0.6, generosity: 0.5, integrity: 0.9 }, ambition: { kind: 'order', progress: 0.35 } };
  run(w, 3);
  assert.ok(failing.lawlessness > 0.15, 'famine + weak, corrupt rule breeds lawlessness');
  assert.ok(thriving.lawlessness < 0.6, 'prosperity + firm honest rule (and an order agenda) restores order');
});

test('installing a magistrate seats a named ruler with an agenda and re-targets the economy', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  const m = installMagistrate(w, isl);
  assert.equal(isl.magistrate, m, 'the new magistrate takes office');
  assert.ok(m.ambition && m.ambition.kind, 'the new regime governs toward an economic agenda');
  assert.ok(ambitionLabel(m).length > 0, 'the agenda has a display label for the panel');
});

test('a rebellion resolves — loyalty resets and order (of a sort) returns', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.magistrate = { name: 'Weak', xp: 0, traits: { firmness: 0, generosity: 0.5, integrity: 0.5 } };
  isl.rebellion = { until: 0 };
  isl.loyalty = 0.1;
  w.simTime = 500; // past the standoff
  governance(w, w.rules.SIM_STEP);
  assert.equal(isl.rebellion, null, 'the fire burned out');
  assert.ok(isl.loyalty >= 0.5, 'loyalty reset');
  assert.equal(effectiveRate(isl, isl.primary, w.rules) > 0, true, 'production resumes');
});
