// Serializable, sim-owned PRNG (mulberry32) + per-stream seeding (FNV-1a).
//
// PURE: imports nothing (not engine, not config) so the sim loads identically in
// Node, the browser, and tests. Unlike engine/harness/seededRandom.js (a closure,
// non-serializable, for the shot harness), the state here is a plain number, so a
// whole world — including its RNG position — round-trips through JSON.
//
// Per-system SUBSTREAMS (world.rngFor(id)) keep the draw sequence of one system
// independent of the others, so adding/reordering a SIM system does not perturb
// unrelated streams (determinism survives extension).

/** FNV-1a( seed , id ) -> uint32. Distinct id => distinct, stable stream seed. */
export function hashStream(seed, id) {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A generator is just { s } — a plain, serializable uint32 state. */
export function createRng(seed) {
  return { s: seed >>> 0 };
}

/** Advance `rng` and return a float in [0,1). Mutates rng.s. */
export function nextFloat(rng) {
  let a = (rng.s + 0x6d2b79f5) | 0;
  rng.s = a >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Draw from a named substream on `world`, creating it lazily from (seed, id).
 * The stream state lives in world.rngStreams (plain data) so it serializes.
 */
export function streamFloat(world, id) {
  let st = world.rngStreams[id];
  if (!st) st = world.rngStreams[id] = createRng(hashStream(world.seed, id));
  return nextFloat(st);
}
