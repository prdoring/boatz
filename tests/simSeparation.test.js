// Ship-to-ship collision avoidance (separation.js): a light nudge so hulls don't stack, plus a nod to
// the rules of the road — a hull closing on another ahead eases to STARBOARD (head-on → pass
// port-to-port; crossing → the give-way vessel yields). A chase (a hull and its `_prey`) is exempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { separation } from '/game/sim/separation.js';

/** Strip the world down to just these ships, all under way and unengaged. */
function only(w, ships) {
  w.ships = ships;
  for (const s of ships) { s.pirate = false; s.privateer = false; s.state = 'outbound'; s._prey = undefined; }
}

test('two crowding hulls are nudged apart toward the separation range (not a big buffer)', () => {
  const w = makeWorld();
  const a = w.ships[0], b = w.ships[1];
  only(w, [a, b]);
  a.x = 3000; a.y = 3000; a.heading = 0;
  b.x = 3012; b.y = 3000; b.heading = 0; // 12u apart — well inside SHIP_SEPARATION_RANGE
  const d0 = Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = 0; i < 40; i++) separation(w, w.rules.SIM_STEP);
  const d1 = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(d1 > d0 + 10, `the hulls eased apart (${d0.toFixed(0)}u -> ${d1.toFixed(0)}u)`);
  assert.ok(d1 >= w.rules.SHIP_SEPARATION_RANGE * 0.7, 'they reached roughly the separation range');
});

test('meeting head-on, each hull veers to STARBOARD (passing port-to-port, like real vessels)', () => {
  const w = makeWorld();
  const a = w.ships[0], b = w.ships[1];
  only(w, [a, b]);
  // Approaching along the x-axis, ~80u apart: inside the avoid look-ahead, outside the hard shove range,
  // so ONLY the right-of-way veer acts. a faces east (+x) → its starboard is +y; b faces west → starboard -y.
  a.x = 3000; a.y = 3000; a.heading = 0;
  b.x = 3080; b.y = 3000; b.heading = Math.PI;
  for (let i = 0; i < 20; i++) separation(w, w.rules.SIM_STEP);
  assert.ok(a.y > 3000 + 3, `the eastbound hull bore off to starboard/south (y ${a.y.toFixed(1)})`);
  assert.ok(b.y < 3000 - 3, `the westbound hull bore off to starboard/north (y ${b.y.toFixed(1)})`);
});

test('a crossing GIVE-WAY vessel (other on its starboard) yields; the stand-on vessel holds', () => {
  const w = makeWorld();
  const a = w.ships[0], b = w.ships[1];
  only(w, [a, b]);
  // a heads east; b crosses from a's starboard (south) heading north → a must give way, b stands on.
  // Placed ~64u apart (inside the avoid look-ahead, outside the hard shove range) so the veer is what acts.
  a.x = 3000; a.y = 3000; a.heading = 0;               // east; starboard = +y (south)
  b.x = 3040; b.y = 3050; b.heading = -Math.PI / 2;    // to a's starboard-ahead, steaming north
  const bx0 = b.x, by0 = b.y;
  for (let i = 0; i < 15; i++) separation(w, w.rules.SIM_STEP);
  const aMoved = Math.hypot(a.x - 3000, a.y - 3000);
  const bMoved = Math.hypot(b.x - bx0, b.y - by0);
  assert.ok(aMoved > 3, `the give-way hull altered course (${aMoved.toFixed(1)}u)`);
  assert.ok(aMoved > bMoved + 2, 'the give-way hull yielded while the stand-on hull essentially held');
});

test('a chase drops the polite give-way, but the HARD FLOOR still forbids overlap (no welding)', () => {
  const w = makeWorld();
  const hunter = w.ships[0], prey = w.ships[1];
  only(w, [hunter, prey]);
  hunter._prey = prey.id;
  hunter.x = 3000; hunter.y = 3000; hunter.heading = 0;
  prey.x = 3020; prey.y = 3000; prey.heading = 0; // 20u — inside the collision floor (the old bug held them here forever)
  for (let i = 0; i < 40; i++) separation(w, w.rules.SIM_STEP);
  const d1 = Math.hypot(hunter.x - prey.x, hunter.y - prey.y);
  assert.ok(d1 >= w.rules.SHIP_COLLIDE_RANGE - 1e-6, `the boarding pair was held off the collision floor (${d1.toFixed(1)}u)`);
  assert.ok(d1 < w.rules.SHIP_SEPARATION_RANGE, 'but only to the floor, not the full separation range — the give-way stays exempt for a chase');
});

test('dead-stacked combatants never stay welded — even a whole SWARM is held off one target', () => {
  const w = makeWorld();
  const target = w.ships[0], a = w.ships[1], b = w.ships[2], c = w.ships[3];
  only(w, [target, a, b, c]);
  // Three attackers all focus-firing `target` (each has it as _prey) — the exemption is per-attacker, so
  // the old code dropped separation between the target and its ENTIRE swarm. Stack them all on its position.
  for (const s of [a, b, c]) { s._prey = target.id; s.x = 4000; s.y = 4000; }
  target.x = 4000; target.y = 4000;
  for (let i = 0; i < 60; i++) separation(w, w.rules.SIM_STEP);
  for (const s of [a, b, c]) {
    const d = Math.hypot(s.x - target.x, s.y - target.y);
    assert.ok(d >= w.rules.SHIP_COLLIDE_RANGE - 1e-6, `attacker held off the target (${d.toFixed(1)}u ≥ floor)`);
  }
});
