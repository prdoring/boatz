// Event-kind metadata (game/ui/eventKinds.js) — the headline/log tier gate and the new beat kinds'
// category/colour/icon coverage, so the news crawl filter and the Story vital-stats never hit an
// unmapped kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeadline, categoryOf, eventIcon, EVENT_COLOR } from '/game/ui/eventKinds.js';

test('isHeadline: legacy/news events are headlines, log beats are not', () => {
  assert.equal(isHeadline(undefined), true, 'a nullish event is treated as a headline');
  assert.equal(isHeadline({ kind: 'plunder' }), true, 'no tier → headline (legacy)');
  assert.equal(isHeadline({ kind: 'goldenage', tier: 'news' }), true);
  assert.equal(isHeadline({ kind: 'maiden', tier: 'log' }), false, 'a log beat stays out of the crawl');
});

test('every new beat kind resolves a category, colour, and icon', () => {
  const NEW = ['maiden', 'voyages', 'promotion', 'goldenage', 'popmilestone', 'longpeace', 'neworder'];
  for (const k of NEW) {
    assert.notEqual(categoryOf(k), 'other', `${k} has a category`);
    assert.ok(k in EVENT_COLOR, `${k} has an explicit colour`);
    assert.ok(typeof eventIcon(k) === 'string' && eventIcon(k), `${k} resolves an icon`);
  }
});
