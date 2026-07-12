// Captain portraits: a captain carries a deterministic seed the client expands into ten
// portrait "genes", which index the nautical art parts in data/portrait-art.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genesFromSeed } from '/game/PortraitRenderer.js';
import portraitArt from '/data/portrait-art.json' with { type: 'json' };
import { makeCaptain } from '/game/sim/captains.js';
import { makeWorld } from './helpers/simWorld.js';

const GENE_KEYS = ['head', 'face', 'hair', 'beard', 'hat', 'shoulders', 'skin', 'hairCol', 'coatCol', 'accentCol'];

test('genesFromSeed is deterministic and yields ten genes in [0,1)', () => {
  const a = genesFromSeed(12345), b = genesFromSeed(12345), c = genesFromSeed(999);
  assert.deepEqual(a, b, 'same seed → same portrait');
  assert.notDeepEqual(a, c, 'different seed → different portrait');
  for (const k of GENE_KEYS) assert.ok(a[k] >= 0 && a[k] < 1, `${k} in range`);
});

test('a captain carries a portrait seed int (and it is deterministic per world seed)', () => {
  const a = makeCaptain(makeWorld());
  const b = makeCaptain(makeWorld());
  assert.equal(typeof a.portrait, 'number');
  assert.ok(Number.isInteger(a.portrait) && a.portrait >= 0);
  assert.equal(a.portrait, b.portrait, 'same world seed → same portrait seed');
});

test('portrait art: every part has a valid shape list', () => {
  const cols = ['heads', 'faces', 'hairs', 'facialHair', 'headgear', 'shoulders'];
  const types = new Set(['path', 'circle', 'arc', 'lines']);
  for (const col of cols) {
    assert.ok(portraitArt[col], `missing collection ${col}`);
    for (const id of Object.keys(portraitArt[col])) {
      const def = portraitArt[col][id];
      assert.ok(Array.isArray(def.shapes), `${col}.${id} needs a shapes array`);
      for (const s of def.shapes) assert.ok(types.has(s.type), `${col}.${id} bad shape type ${s.type}`);
    }
  }
});
