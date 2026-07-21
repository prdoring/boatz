// Structural soundness — the per-track ceiling (hullSound/rigSound) that erodes with damage and is
// rebuilt only by a real dry-dock. These lock the invariant (hull <= hullSound), the floor, the at-sea
// jury-rig ceiling (never a full refit), and the home-yard-vs-foreign-yard distinction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { initCondition, damageHull, damageRig, juryRig, repairAtPort, renderAid, refitGradual } from '/game/sim/repair.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, ...over });
const boat = (over = {}) => ({ id: 's1', type: 'brig', hull: 1, rig: 1, hullSound: 1, rigSound: 1, morale: 0.6, capacity: 100, cargo: { Gold: 0, People: 0, Wood: 0, Fiber: 0 }, captain: cap(), ...over });

test('initCondition seeds hull/rig AND their soundness ceilings to full', () => {
  const s = {};
  initCondition(s);
  assert.equal(s.hull, 1); assert.equal(s.rig, 1);
  assert.equal(s.hullSound, 1); assert.equal(s.rigSound, 1);
});

test('damage erodes soundness (hull faster than rig), floors at SOUNDNESS_FLOOR, and never inverts the invariant', () => {
  const w = makeWorld();
  const s = boat();
  for (let i = 0; i < 60; i++) { damageHull(s, 0.2, w.rules); damageRig(s, 0.2, w.rules); }
  assert.ok(s.hull <= s.hullSound + 1e-9, 'hull never exceeds its soundness');
  assert.ok(s.rig <= s.rigSound + 1e-9, 'rig never exceeds its soundness');
  assert.ok(s.hullSound >= w.rules.SOUNDNESS_FLOOR - 1e-9, 'hull soundness never falls below the floor');
  assert.ok(s.rigSound >= w.rules.SOUNDNESS_FLOOR - 1e-9);
  assert.ok(s.hullSound <= s.rigSound + 1e-9, 'hull soundness erodes at least as fast as rig (framing more permanent than canvas)');
});

test('OLD-SAVE compat: a ship with NO sound fields takes damage → finite, invariant holds', () => {
  const w = makeWorld();
  const s = boat(); delete s.hullSound; delete s.rigSound; // a pre-feature save
  damageHull(s, 0.4, w.rules); damageRig(s, 0.4, w.rules);
  assert.ok(Number.isFinite(s.hull) && Number.isFinite(s.hullSound), 'no NaN from a missing field');
  assert.ok(s.hull <= s.hullSound + 1e-9 && s.rig <= s.rigSound + 1e-9, 'invariant holds after backfill');
});

test('at-sea jury-rig tops out at min(soundness, REACH) — never a full refit', () => {
  const w = makeWorld();
  const s = boat({ hull: 0.1, rig: 0.1, cargo: { Gold: 0, People: 0, Wood: 999, Fiber: 999 } }); // soundness still ~1
  for (let i = 0; i < 100; i++) juryRig(w, s, w.rules.SIM_DAY_SECONDS, 3); // a day of hove-to work per call
  assert.ok(Math.abs(s.hull - w.rules.JURYRIG_REACH_HULL) < 0.02, `hull jury-rigs up to REACH (~${w.rules.JURYRIG_REACH_HULL})`);
  assert.ok(Math.abs(s.rig - w.rules.JURYRIG_REACH_RIG) < 0.02, `rig jury-rigs up to REACH (~${w.rules.JURYRIG_REACH_RIG})`);
  assert.ok(s.hull < 1 && s.rig < 1, 'never a full refit at sea');
});

test('a jury-rig cannot lift the hull above its ERODED soundness (the ceiling drops as structure wears)', () => {
  const w = makeWorld();
  const s = boat({ hull: 0.1, hullSound: 0.5, cargo: { Gold: 0, People: 0, Wood: 999, Fiber: 999 } }); // soundness eroded below REACH
  for (let i = 0; i < 100; i++) juryRig(w, s, w.rules.SIM_DAY_SECONDS, 3);
  assert.ok(s.hull <= 0.5 + 1e-9, 'capped at the eroded soundness (0.5), below the 0.55 REACH');
  assert.ok(s.hull > 0.45, 'but it did lift the hull up to that ceiling');
});

test('soundness RATCHETS DOWN across damage→repair cycles (diminishing returns) and settles at the floor', () => {
  const w = makeWorld();
  const s = boat({ cargo: { Gold: 0, People: 0, Wood: 9999, Fiber: 9999 } });
  const start = s.hullSound;
  let prev = s.hullSound;
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 6; i++) damageHull(s, 0.5, w.rules);          // beaten toward 0
    for (let i = 0; i < 50; i++) juryRig(w, s, w.rules.SIM_DAY_SECONDS, 3); // patched back to the (falling) ceiling
    assert.ok(s.hullSound <= prev + 1e-9, `cycle ${c}: soundness never ratchets back UP at sea`);
    prev = s.hullSound;
  }
  assert.ok(s.hullSound < start - 0.1, 'several cycles meaningfully eroded soundness (a repeatedly-mauled hull)');
  assert.ok(Math.abs(s.hullSound - w.rules.SOUNDNESS_FLOOR) < 1e-6, 'and it settled at the floor');
});

test('a real dry-dock (home port) REBUILDS soundness; a foreign yard only patches up to it', () => {
  const w = makeWorld();
  const home = w.islands[0], foreign = w.islands[1];
  home.haven = false; foreign.haven = false;
  home.stock = { ...(home.stock || {}), Wood: 9999, Fiber: 9999 };
  foreign.stock = { ...(foreign.stock || {}), Wood: 9999, Fiber: 9999 };
  const s = boat({ homeId: home.id, cargo: { Gold: 999999, People: 0 } });
  for (let i = 0; i < 40; i++) damageHull(s, 0.3, w.rules); // soundness → floor
  const eroded = s.hullSound;
  repairAtPort(w, foreign, s); // a FOREIGN yard
  assert.ok(Math.abs(s.hullSound - eroded) < 1e-9, 'a foreign yard leaves structural soundness untouched');
  repairAtPort(w, home, s);    // the HOME dry-dock
  assert.ok(s.hullSound > eroded + 1e-6, 'a home dry-dock rebuilds soundness toward whole');
});

test('refitGradual mends a hull in SMALL steps (not a chunk), capped by soundness, rebuilding soundness slowly', () => {
  const w = makeWorld();
  const haven = w.islands[0];
  haven.stock = { ...(haven.stock || {}), Wood: 99999, Fiber: 99999 };
  const s = boat({ hull: 0.3, rig: 0.3, hullSound: 0.6, rigSound: 0.7 });
  const dDay = w.rules.SIM_STEP / w.rules.SIM_DAY_SECONDS; // one substep's slice of a sim-day
  const before = s.hull;
  refitGradual(w, haven, s, dDay);
  const step = s.hull - before;
  assert.ok(step > 0 && step < 0.02, `one tick mends a SMALL step (${step.toFixed(4)}), not a per-dock chunk`);
  for (let i = 0; i < 6000; i++) refitGradual(w, haven, s, dDay); // loiter at the den for a while
  assert.ok(s.hull > 0.9, 'over a day or two at the den it heals up smoothly');
  assert.ok(s.hull <= s.hullSound + 1e-9, 'never above structural soundness');
  assert.ok(s.hullSound > 0.6, 'and a real dry-dock also rebuilt soundness beyond the starting 0.6');
});

test('renderAid clamps at-sea aid to the victim soundness — and never NaNs on a raw victim', () => {
  const w = makeWorld();
  const victim = boat({ id: 'v', hull: 0.3, rig: 0.1, hullSound: 0.5, rigSound: 0.6, cargo: { Gold: 0, People: 0, Food: 0 } });
  const helper = boat({ id: 'h', homeId: 1, cargo: { Gold: 0, People: 0, Wood: 999, Fiber: 999, Food: 999 } });
  renderAid(w, helper, victim);
  assert.ok(victim.hull <= victim.hullSound + 1e-9, 'ally aid cannot patch the hull above the victim soundness');
  assert.ok(victim.rig <= victim.rigSound + 1e-9, 'nor the rig');
  // A raw victim with no sound fields (older row) must not NaN through the clamp.
  const raw = { id: 'r', type: 'brig', hull: 0.2, rig: 0.05, morale: 0.5, cargo: { Food: 0 }, captain: cap() };
  renderAid(w, boat({ id: 'h2', homeId: 1, cargo: { Gold: 0, People: 0, Wood: 999, Fiber: 999, Food: 999 } }), raw);
  assert.ok(Number.isFinite(raw.hull) && Number.isFinite(raw.rig), 'no NaN with a missing soundness field');
});
