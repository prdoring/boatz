// The chronicler's LOGBOOK mode (game/ui/chronicle-narrate.js) — the durable log read as a FIRST-PERSON
// book handed keeper to keeper. Driven by a compact FAKE style REGISTRY so the assertions are hermetic
// (the real data/voices/*.json are exercised in-browser). A regime-change event carries `data.regime`;
// each span narrates in the keeper's assigned style (chosen by voiceSeed % ids.length).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate } from '/game/ui/chronicle-narrate.js';

// Structural base shared by every style (gap buckets, episode sizing, frame, ordinals…).
const BASE = {
  version: 1,
  episode: { gapDays: 12, maxSentences: 4 },
  gapBuckets: [
    { key: 'same', maxDays: 0 }, { key: 'days', maxDays: 4 }, { key: 'week', maxDays: 12 },
    { key: 'season', maxDays: 120 }, { key: 'year', maxDays: 400 }, { key: 'long', maxDays: null },
  ],
  connectives: { same: ['SAME, '], days: ['DAYS, '], week: ['WEEK, '], season: ['SEASON, '], year: ['YEAR, '], long: ['LONG, '] },
  join: ['and '],
  ordinals: ['', 'first', 'second', 'third', 'fourth'],
  pronoun: { ship: { subject: 'we', first: 'We' }, island: { subject: 'we', first: 'We' } },
  frame: {
    ship: { template: 'A {home} {type}{captain}{status}.', captain: ' under Capt. {captainName}, {rank}', status: { pirate: ' — pirate', privateer: ' — hunter', default: ' — trader' } },
    island: { template: 'A {type} port{magistrate}{primary}.', magistrate: ' under {magName}', primary: ', trading in {primary}' },
  },
  kinds: { plunder: { recur: { class: 'prize', phrases: [', my {ord} such prize'] } } },
};
// Two distinct hands. Handover text is tagged with the style letter + cause so we can assert WHO wrote WHAT.
const styleFor = (L) => ({
  ...BASE,
  handover: {
    ship: { founder: L + '-FOUNDER {name}', successor: L + '-SUC {name}', mutiny: L + '-MUTINY {name}', pirate: L + '-PIRATE {name}', prize: L + '-PRIZE {name}', recovered: L + '-REC {name}' },
    island: { founder: L + '-IFOUNDER {name}', overthrow: L + '-OVER {name}', successor: L + '-ISUC {name}' },
  },
  coda: {
    ship: { pirate: L + '-PIRATE-CODA', default: L + '-CODA out of {home}', bounty: ', {bounty}g' },
    island: { haven: L + '-HAVEN-CODA', default: L + '-ICODA {population}' },
  },
  quiet: { ship: L + '-QUIET-SHIP', island: L + '-QUIET-ISLAND' },
});
// seed % 2 → A (even) / B (odd)
const REG = { base: BASE, byId: { A: styleFor('A'), B: styleFor('B') }, ids: ['A', 'B'] };

const ISLANDS = new Map([['coralbay', { name: 'Coralbay' }]]);
const CTX = { islandsById: ISLANDS };
const SHIP = { name: 'the Salt Wraith', type: 'brig', homeId: 'coralbay', pirate: true, captain: { name: 'Blackbeard', rank: 'Master', voiceSeed: 1 } };
const ev = (id, day, kind, text, extra) => ({ id, seq: id, day, kind, text: text || `event ${id}`, ...extra });
const regime = (from, to, cause) => ({ data: { regime: { from, to, cause } } });
const blocksOf = (m, type) => m.blocks.filter((b) => b.type === type);
const handovers = (m) => blocksOf(m, 'handover').map((b) => b.runs.map((r) => r.text).join(''));
// Reproduce the InfoPanel prose renderer: split runs on spaces, glue leading punctuation to the prior word.
const render = (m) => blocksOf(m, 'prose').map((b) => {
  let out = '';
  for (const run of b.runs) for (const w of String(run.text).split(' ')) {
    if (!w) continue;
    out += out && !/^[,.;:!?)]/.test(w) ? ' ' + w : w;
  }
  return out;
}).join('  ');

test('a ship log splits at a regime change: founder handover, then the new keeper takes up the book', () => {
  const entries = [
    ev(1, 1, 'plunder', 'the Salt Wraith took a prize'),
    ev(2, 5, 'prize', 'A pirate took the Salt Wraith as a PRIZE', regime({ name: 'Anne', voiceSeed: 0, rank: 'Veteran' }, { name: 'Blackbeard', voiceSeed: 1, rank: 'Master' }, 'prize')),
    ev(3, 6, 'plunder', 'the Salt Wraith took another'),
  ];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX);
  const hs = handovers(m);
  assert.equal(hs.length, 2, 'two keepers → two handover notes');
  assert.match(hs[0], /^A-FOUNDER Anne/, 'the founder writes in style A (voiceSeed 0)');
  assert.match(hs[1], /^B-PRIZE Blackbeard/, 'the prize-master writes in style B (voiceSeed 1), as a capture');
  // The founder handover precedes the prize handover (chronological hand-off).
  const order = m.blocks.filter((b) => b.type === 'handover');
  assert.equal(order[0].seed, 0);
  assert.equal(order[1].seed, 1);
});

test('deeds under each keeper read in the first person ("We…")', () => {
  const entries = [
    ev(1, 1, 'plunder', 'the Salt Wraith took a prize'),
    ev(2, 3, 'plunder', 'the Salt Wraith took another'),
  ];
  const text = render(narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX));
  assert.match(text, /We took a prize/, 'the ship name is folded to first person at a sentence head');
  assert.match(text, /we took another/, 'and to lowercase "we" after a soft join');
  assert.doesNotMatch(text, /the Salt Wraith took/, 'the third-person name is gone from the deeds');
});

test('recurrence callbacks survive into first person ("my second such prize")', () => {
  const entries = [
    ev(1, 1, 'plunder', 'the Salt Wraith took a prize'),
    ev(2, 2, 'plunder', 'the Salt Wraith took a prize'),
  ];
  const text = render(narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX));
  assert.match(text, /my second such prize/);
});

test('the closing coda is written by the CURRENT keeper, in their style', () => {
  const m = narrate([ev(1, 1, 'plunder', 'the Salt Wraith took a prize')], { kind: 'ship', id: 's1', data: SHIP }, REG, CTX);
  assert.match(m.coda.text, /^B-PIRATE-CODA/, 'live captain has voiceSeed 1 → style B, and the ship is a pirate');
});

test('an island log hands over on an overthrow, each ruler in their own hand', () => {
  const ISL = { name: 'Coralbay', type: 'forest', population: 3200, magistrate: { name: 'Crowe', rank: 'Governor', voiceSeed: 0 } };
  const entries = [
    ev(1, 10, 'boom', 'Coralbay prospered'),
    ev(2, 40, 'overthrow', 'Coralbay cast out Vane; Crowe seizes the port', regime({ name: 'Vane', voiceSeed: 1, rank: 'Consul' }, { name: 'Crowe', voiceSeed: 0, rank: 'Governor' }, 'overthrow')),
    ev(3, 60, 'boom', 'Coralbay prospered again'),
  ];
  const m = narrate(entries, { kind: 'island', id: 'coralbay', data: ISL }, REG, CTX);
  const hs = handovers(m);
  assert.match(hs[0], /^B-IFOUNDER Vane/, 'the cast-out founder ruled in style B (voiceSeed 1)');
  assert.match(hs[1], /^A-OVER Crowe/, 'the new ruler took power (overthrow) in style A (voiceSeed 0)');
  assert.match(m.coda.text, /^A-ICODA/, 'the coda is the sitting ruler (style A)');
});

test('an eventless entity still reads as a tale: founder handover + quiet line + coda', () => {
  const m = narrate([], { kind: 'ship', id: 's1', data: SHIP }, REG, CTX);
  assert.equal(handovers(m).length, 1, 'the sole keeper introduces the book');
  assert.match(handovers(m)[0], /^B-FOUNDER Blackbeard/);
  assert.ok(blocksOf(m, 'prose').some((b) => b.runs.some((r) => r.role === 'quiet' && /B-QUIET-SHIP/.test(r.text))));
  assert.match(m.coda.text, /^B-PIRATE-CODA/);
});

test('deterministic and prefix-stable: appending a later-episode deed never reshuffles prior blocks', () => {
  const base = [
    ev(1, 1, 'plunder', 'the Salt Wraith took a prize'),
    ev(2, 5, 'prize', 'taken as a prize', regime({ name: 'Anne', voiceSeed: 0 }, { name: 'Blackbeard', voiceSeed: 1 }, 'prize')),
    ev(3, 6, 'plunder', 'the Salt Wraith took another'),
  ];
  const a = narrate(base, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX);
  assert.deepEqual(a, narrate(base, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX), 'same input → identical output');
  const grown = [...base, ev(4, 300, 'plunder', 'the Salt Wraith took a prize')]; // big gap → a fresh episode under the same keeper
  const b = narrate(grown, { kind: 'ship', id: 's1', data: SHIP }, REG, CTX);
  assert.deepEqual(b.blocks.slice(0, a.blocks.length), a.blocks, 'prior blocks are byte-identical after an append');
});

test('with no styles loaded the registry degrades to LEGACY third-person narration', () => {
  const emptyReg = { base: { ...BASE, pronoun: { ship: { subject: 'she', elide: true } }, connectives: BASE.connectives, coda: { ship: { default: 'LEGACY-CODA', pirate: 'LEGACY-PIRATE' } }, quiet: { ship: 'LEGACY-QUIET' } }, byId: {}, ids: [] };
  const m = narrate([ev(1, 1, 'plunder', 'the Salt Wraith took a prize')], { kind: 'ship', id: 's1', data: SHIP }, emptyReg, CTX);
  assert.equal(handovers(m).length, 0, 'no handovers in legacy mode');
  const text = m.blocks.filter((b) => b.type === 'prose').map((b) => b.runs.map((r) => r.text).join('')).join(' ');
  assert.match(text, /The Salt Wraith took a prize/, 'legacy keeps the third-person name (capitalized opener)');
});
