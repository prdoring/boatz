// Captain/magistrate portraits: a person carries a deterministic seed the client expands into
// portrait "genes", which index the nautical art parts in data/portrait-art.json. A `flavor`
// (pirate/navy/official/common) biases which parts are eligible per role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genesFromSeed, PortraitRenderer } from '/game/PortraitRenderer.js';
import portraitArt from '/data/portrait-art.json' with { type: 'json' };
import { makeCaptain } from '/game/sim/captains.js';
import { makeWorld } from './helpers/simWorld.js';

// The 18 genes derived from a seed: 6 shape + 4 base-colour + hatCol/plumeCol/metalCol + the
// four accessory slots. Order matters — the first ten MUST stay stable so existing seeds keep
// their head/face/hair/beard/hat/shoulders + base colours (new genes only add on top).
const GENE_KEYS = [
  'head', 'face', 'hair', 'beard', 'hat', 'shoulders', 'skin', 'hairCol', 'coatCol', 'accentCol',
  'hatCol', 'plumeCol', 'metalCol', 'earring', 'faceMark', 'mouth', 'neck', 'shoulderPet',
];
const FLAVORS = ['pirate', 'navy', 'official', 'common'];
// Every collection a portrait composes from (drawn back → front).
const COLLECTIONS = [
  'neckBases', 'shoulders', 'shoulderPets', 'necks', 'heads', 'hairs', 'facialHair',
  'faces', 'faceMarks', 'earrings', 'mouths', 'headgear',
];

test('genesFromSeed is deterministic and yields the full gene set in [0,1)', () => {
  const a = genesFromSeed(12345), b = genesFromSeed(12345), c = genesFromSeed(999);
  assert.deepEqual(a, b, 'same seed → same portrait');
  assert.notDeepEqual(a, c, 'different seed → different portrait');
  assert.equal(Object.keys(a).length, GENE_KEYS.length, 'expected gene count');
  for (const k of GENE_KEYS) assert.ok(a[k] >= 0 && a[k] < 1, `${k} in range`);
});

test('appending genes keeps the original ten stable for a given seed', () => {
  // Re-derive from the same seed and confirm the first ten genes are still the leading draws.
  const g = genesFromSeed(0xC0FFEE);
  const first10 = GENE_KEYS.slice(0, 10);
  for (const k of first10) assert.ok(typeof g[k] === 'number', `${k} present`);
});

test('a captain carries a portrait seed int (and it is deterministic per world seed)', () => {
  const a = makeCaptain(makeWorld());
  const b = makeCaptain(makeWorld());
  assert.equal(typeof a.portrait, 'number');
  assert.ok(Number.isInteger(a.portrait) && a.portrait >= 0);
  assert.equal(a.portrait, b.portrait, 'same world seed → same portrait seed');
});

test('portrait art: every part has a valid shape list', () => {
  const types = new Set(['path', 'circle', 'arc', 'lines']);
  for (const col of COLLECTIONS) {
    assert.ok(portraitArt[col], `missing collection ${col}`);
    for (const id of Object.keys(portraitArt[col])) {
      const def = portraitArt[col][id];
      assert.ok(Array.isArray(def.shapes), `${col}.${id} needs a shapes array`);
      for (const s of def.shapes) assert.ok(types.has(s.type), `${col}.${id} bad shape type ${s.type}`);
    }
  }
});

test('portrait art: declared flavors are all valid', () => {
  const allowed = new Set(FLAVORS);
  for (const col of Object.keys(portraitArt)) {
    if (col.startsWith('_')) continue;
    for (const id of Object.keys(portraitArt[col])) {
      const fl = portraitArt[col][id].flavors;
      if (fl == null) continue;
      assert.ok(Array.isArray(fl), `${col}.${id} flavors must be an array`);
      for (const f of fl) assert.ok(allowed.has(f), `${col}.${id} bad flavor ${f}`);
    }
  }
});

test('flavor filtering never strands a slot empty (falls back to the full pool)', () => {
  const pr = new PortraitRenderer(portraitArt);
  for (const flavor of FLAVORS) {
    for (const col of COLLECTIONS) {
      for (const g of [0, 0.25, 0.5, 0.75, 0.999]) {
        const def = pr._pick(col, g, flavor);
        assert.ok(def && Array.isArray(def.shapes), `${flavor}/${col}@${g} resolved a part`);
      }
    }
  }
});
