// Field-Manual fixes folded in with Phase 6 (piracy/haven caps). #4 (prize re-home) is asserted in
// simPiracy.test.js's PRIZE test; here: #5 (the unified pirate budget) and #14 (the at-cap exit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { pirateBudget } from '/game/sim/piracy.js';
import { havens } from '/game/sim/havens.js';

test('FM #5: ONE pirate budget — it lifts with the number of havens, then caps', () => {
  const w = makeWorld(); const t = w.rules;
  for (const i of w.islands) i.haven = false;
  const base = pirateBudget(w);
  w.islands[0].haven = true; w.islands[1].haven = true;
  const lifted = pirateBudget(w);
  assert.ok(lifted > base, `havens lift the shared budget that haven-builds, rogues, and prizes all draw from (${base} → ${lifted})`);
  for (const i of w.islands) i.haven = true; // saturate
  const capped = pirateBudget(w);
  const ceiling = Math.floor(w.ships.length * (t.PIRATE_MAX_FRAC || 0.08) * (t.HAVEN_PIRATE_LIFT_MAX || 2.5));
  assert.ok(capped <= Math.max(2, ceiling), `the lift is capped at HAVEN_PIRATE_LIFT_MAX (${capped} ≤ ${ceiling})`);
});

test('FM #14: a failing port that CANNOT fall (haven cap full) gets an exit — its lawlessness eases', () => {
  const w = makeWorld(); const t = w.rules;
  const cap = Math.max(1, Math.floor(w.islands.length * t.HAVEN_MAX_FRAC));
  const stuck = w.islands[0];
  // Fill the haven cap with OTHER islands (strong dens so they don't redeem this tick).
  let filled = 0;
  for (const isl of w.islands) {
    if (isl === stuck) continue;
    if (filled >= cap) break;
    isl.haven = true; isl.havenStrength = 0.8; filled++;
  }
  // `stuck` is wholly failing but the cap is full → it cannot collapse into a haven.
  stuck.haven = false; stuck.lawlessness = 0.9; stuck.civ = 0.1; stuck.population = 500;
  stuck._havenPressure = t.HAVEN_FALL_DAYS + 5; // well past the fall threshold
  const law0 = stuck.lawlessness;
  w.simTime += t.SIM_DAY_SECONDS;
  havens(w, t.SIM_STEP);
  assert.equal(stuck.haven, false, 'it could NOT fall — the haven cap is full');
  assert.ok(stuck.lawlessness < law0, `its lawlessness eased, an exit from the endless rebellion churn (${law0} → ${stuck.lawlessness.toFixed(2)})`);
  assert.ok((stuck._havenPressure || 0) <= t.HAVEN_FALL_DAYS, 'pressure no longer builds past the fall threshold');
});
