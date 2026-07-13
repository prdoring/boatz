// Steering geometry (steering.js) — the pure helpers behind a pirate blockading a port and a
// privateer patrolling one: orbit a centre, and open the range from a threat. Deterministic + pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbitPoint, orbitStep, orbitDir, awayPoint } from '/game/sim/steering.js';

const R = (x, y) => Math.hypot(x, y);

test('orbitPoint returns a point on the circle of the given radius', () => {
  const p = orbitPoint(100, 100, 250, 100, 80, 1, 0.1); // from due-east of centre
  assert.ok(Math.abs(R(p.x - 100, p.y - 100) - 80) < 1e-9, 'lands exactly on the radius-80 circle');
});

test('orbitPoint advances the bearing around the centre (it circles, never sits still)', () => {
  const cx = 0, cy = 0, rad = 100;
  let x = 100, y = 0; // start on the circle, due east
  const a0 = Math.atan2(y - cy, x - cx);
  const p = orbitPoint(cx, cy, x, y, rad, 1, 0.2);
  const a1 = Math.atan2(p.y - cy, p.x - cx);
  assert.ok(a1 > a0, 'ccw dir advances the angle');
  const q = orbitPoint(cx, cy, x, y, rad, -1, 0.2);
  assert.ok(Math.atan2(q.y - cy, q.x - cx) < a0, 'the opposite dir advances the other way');
});

test('orbitPoint from OFF the circle pulls the ship toward the ring (it spirals in)', () => {
  const p = orbitPoint(0, 0, 300, 0, 100, 1, 0.05); // far outside a radius-100 ring
  assert.ok(Math.abs(R(p.x, p.y) - 100) < 1e-9, 'target sits on the ring regardless of start distance');
});

test('orbitStep keeps the step bounded and scaled to speed/radius', () => {
  assert.ok(orbitStep(120, 800, 0.05) > 0 && orbitStep(120, 800, 0.05) <= 0.35, 'in (0, cap]');
  assert.equal(orbitStep(120, 0.5, 0.05), 0.3, 'degenerate tiny radius clamps to a fixed step');
  assert.ok(orbitStep(300, 800, 0.05) > orbitStep(120, 800, 0.05), 'faster hull sweeps a wider arc');
});

test('orbitDir is deterministic and splits ships by id parity', () => {
  assert.equal(orbitDir('s2'), orbitDir('s4'), 'even ids share a direction');
  assert.equal(orbitDir('s1'), orbitDir('s3'), 'odd ids share a direction');
  assert.notEqual(orbitDir('s1'), orbitDir('s2'), 'odd vs even circle opposite ways');
});

test('awayPoint opens the range directly away from a threat', () => {
  const p = awayPoint(0, 0, 10, 0, 100); // fleeing east, away from a threat at the origin
  assert.ok(p.x > 10 && Math.abs(p.y) < 1e-9, 'runs further east, straight away');
  assert.ok(R(p.x, p.y) > R(10, 0), 'ends farther from the threat than it started');
});
