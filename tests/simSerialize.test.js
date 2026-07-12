import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, economyRaw } from './helpers/simWorld.js';
import { stepWorld, worldTotals } from '/game/sim/world.js';
import { serializeWorld, deserializeWorld } from '/game/sim/serialize.js';

function economyClone() { return structuredClone(economyRaw); }
function snap(w) {
  return JSON.stringify({ islands: w.islands, ships: w.ships, simTime: w.simTime, rng: w.rngStreams });
}

test('fast-forward is substep-exact: one dtSim=0.5 step == ten dtSim=0.05 steps', () => {
  const a = makeWorld(1337);
  const b = makeWorld(1337);
  for (let i = 0; i < 200; i++) stepWorld(a, 0.5, 1);
  for (let i = 0; i < 200; i++) for (let k = 0; k < 10; k++) stepWorld(b, 0.05, 1);
  assert.equal(snap(a), snap(b));
});

test('serialize -> deserialize -> step deep-equals stepping the original', () => {
  const orig = makeWorld(1337);
  for (let i = 0; i < 600; i++) stepWorld(orig, 1.0);
  const clone = deserializeWorld(serializeWorld(orig), economyClone());
  for (let i = 0; i < 300; i++) { stepWorld(orig, 1.0); stepWorld(clone, 1.0); }
  assert.equal(snap(orig), snap(clone));
});

test('determinism: same seed reproduces, different seeds diverge', () => {
  const a = makeWorld(1337), b = makeWorld(1337), c = makeWorld(42);
  for (const w of [a, b, c]) for (let i = 0; i < 600; i++) stepWorld(w, 1.0);
  assert.equal(snap(a), snap(b));
  assert.notEqual(snap(a), snap(c));
});

test('gold stays a bounded, positive flow across a long run', () => {
  // Gold is no longer conserved: it is a flow (GDP income vs. upkeep/wreck sinks + a
  // per-capita hoard cap). Assert it stays finite, positive, and within the cap.
  const w = makeWorld();
  for (let i = 0; i < 5000; i++) stepWorld(w, 1.0);
  const g = worldTotals(w).gold;
  const goldCap = w.rules.GOLD_MAX_PER_POP * w.islands.reduce((a, i) => a + i.k, 0);
  assert.ok(Number.isFinite(g) && g > 0 && g <= goldCap * 1.01, `gold out of bounds: ${g}`);
});
