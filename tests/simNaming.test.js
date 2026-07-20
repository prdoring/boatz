// Naming at scale — a big sea should read as a sea of DISTINCT places and hulls, not
// "Oakbay / Oakbay2 / Oakbay3" and a dozen "the Salt Wraith"s. Ship uniqueness is a
// PREFERENCE (re-roll to dodge a living name, then tolerate a repeat), so we also prove it
// never loops forever or throws when the pool is exhausted. All of it stays deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoster } from '/game/sim/roster.js';
import { shipName } from '/game/sim/naming.js';
import { makeCaptain } from '/game/sim/captains.js';
import { makeMagistrate } from '/game/sim/magistrate.js';
import { makeWorld } from './helpers/simWorld.js';

const trailingDigit = (s) => /\d$/.test(s); // uniqName appends 2,3,… only when it must disambiguate

test('a 1000-island sea has unique ids and reads as distinct places (few numeric fallbacks)', () => {
  const { islands } = generateRoster(7, 1000);
  assert.equal(islands.length, 1000);
  assert.equal(new Set(islands.map((i) => i.id)).size, 1000, 'every island id is unique');
  assert.equal(new Set(islands.map((i) => i.name)).size, 1000, 'every island name is unique');
  // The uniqName backstop guarantees uniqueness, but if it fired often the names would read as
  // repeats-with-a-number. With the expanded vocabulary it should barely fire at 1000 islands.
  const forced = islands.filter((i) => trailingDigit(i.name)).length;
  assert.ok(forced / islands.length < 0.03, `too many numeric-suffix names: ${forced}/1000`);
});

test('roster naming is deterministic per seed and diverges across seeds', () => {
  const a = generateRoster(7, 1000).islands.map((i) => i.name);
  const b = generateRoster(7, 1000).islands.map((i) => i.name);
  const c = generateRoster(8, 1000).islands.map((i) => i.name);
  assert.deepEqual(a, b, 'same seed reproduces the same names');
  assert.notDeepEqual(a, c, 'a different seed gives a different sea');
});

test('starting fleet names are all distinct (dedup preference active at genesis)', () => {
  const w = makeWorld(1337);
  const names = w.ships.map((s) => s.name);
  assert.ok(names.length > 60, 'a fleet actually launched');
  assert.equal(new Set(names).size, names.length, 'no two starting hulls share a name');
  for (const n of names) assert.match(n, /^the .+ .+$/, `well-formed vessel name: ${n}`);
});

test('same seed reproduces the same fleet names', () => {
  const a = makeWorld(1337).ships.map((s) => s.name);
  const b = makeWorld(1337).ships.map((s) => s.name);
  assert.deepEqual(a, b);
});

test('ship naming prefers uniqueness but never falls over when the pool runs dry', () => {
  const world = { seed: 5, rngStreams: {}, ships: [] };
  const used = new Set();

  // First 5000 names come back unique — comfortably meeting the "5000 unique ship names" bar.
  for (let i = 0; i < 5000; i++) {
    const nm = shipName(world, used);
    assert.match(nm, /^the .+ .+$/);
  }
  assert.equal(used.size, 5000, 'the first 5000 requested names are all unique');

  // Keep pulling well past the pool's capacity: it must keep returning valid names (tolerating
  // duplicates), not throw or spin. Growth plateaus below the total ADJ×NOUN combinations.
  for (let i = 0; i < 20000; i++) {
    const nm = shipName(world, used);
    assert.match(nm, /^the .+ .+$/);
  }
  assert.ok(used.size < 25000, 'duplicates were tolerated once the pool saturated (no runaway)');
  assert.ok(used.size <= 96 * 128, 'unique count never exceeds the ADJ×NOUN namespace');
  assert.ok(used.size > 8000, 'still explored most of the ~12k-name space before saturating');
});

test('starting captains and magistrates all have distinct, well-formed names', () => {
  const w = makeWorld(1337);
  const captains = w.ships.map((s) => s.captain.name);
  assert.ok(captains.length > 60, 'the sea sailed under a full roster of captains');
  assert.equal(new Set(captains).size, captains.length, 'no two sitting captains share a name');
  for (const n of captains) assert.match(n, /^\S+ .+$/, `well-formed captain name: ${n}`);

  const mags = w.islands.map((i) => i.magistrate.name);
  assert.equal(new Set(mags).size, mags.length, 'no two sitting magistrates share a name');
  for (const n of mags) assert.match(n, /^\S+ \S+ \S+$/, `magistrate reads "Title Given Surname": ${n}`);
});

test('people naming is deterministic per seed', () => {
  const a = makeWorld(1337);
  const b = makeWorld(1337);
  assert.deepEqual(a.ships.map((s) => s.captain.name), b.ships.map((s) => s.captain.name));
  assert.deepEqual(a.islands.map((i) => i.magistrate.name), b.islands.map((i) => i.magistrate.name));
});

test('captain naming prefers uniqueness and stays graceful past its pool', () => {
  const world = { seed: 11, rngStreams: {}, ships: [] };
  const taken = new Set();
  for (let i = 0; i < 4000; i++) {
    const c = makeCaptain(world, taken);
    assert.match(c.name, /^\S+ .+$/);
  }
  assert.equal(taken.size, 4000, 'the first 4000 captains are all uniquely named');
  for (let i = 0; i < 20000; i++) makeCaptain(world, taken); // never throws / spins even when saturated
  assert.ok(taken.size > 4000 && taken.size < 24000, 'kept exploring, then tolerated repeats');
});

test('magistrate naming supports well over 1000 unique rulers', () => {
  const world = { seed: 3, rngStreams: {}, islands: [], rules: { AMBITIONS: ['grow', 'industry', 'wealth', 'fortify', 'splendor', 'order'] } };
  const taken = new Set();
  for (let i = 0; i < 2000; i++) {
    const m = makeMagistrate(world, null, taken);
    assert.match(m.name, /^\S+ \S+ \S+$/);
  }
  assert.equal(taken.size, 2000, '2000 magistrates, every one a distinct name');
});
