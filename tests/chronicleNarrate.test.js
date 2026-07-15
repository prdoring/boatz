// The chronicler (game/ui/chronicle-narrate.js) — pure, browserless. We drive it with a compact FAKE
// voice so the assertions are hermetic (the real data/chronicle-voice.json is exercised in-browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate } from '/game/ui/chronicle-narrate.js';

const VOICE = {
  version: 1,
  episode: { gapDays: 12, maxSentences: 4 },
  gapBuckets: [
    { key: 'same', maxDays: 0 }, { key: 'days', maxDays: 4 }, { key: 'week', maxDays: 12 },
    { key: 'season', maxDays: 120 }, { key: 'year', maxDays: 400 }, { key: 'long', maxDays: null },
  ],
  connectives: { same: ['SAME, '], days: ['DAYS, '], week: ['WEEK, '], season: ['SEASON, '], year: ['YEAR, '], long: ['LONG, '] },
  join: ['and '],
  ordinals: ['', 'first', 'second', 'third', 'fourth', 'fifth'],
  pronoun: { ship: { subject: 'she', elide: true }, island: { subject: 'the port', elide: true } },
  kinds: {
    plunder: { recur: { class: 'prize', phrases: [', her {ord} such prize'] } },
    pirate: { pivot: true, phrases: ['PIVOT.'] },
  },
  crossref: { ship: [' — the {ord} {foeHome} hull'] },
  frame: {
    ship: { template: 'A {home} {type}{captain}{status}.', captain: ' under Capt. {captainName}, {rank}', status: { pirate: ' — pirate', privateer: ' — hunter', default: ' — trader' } },
    island: { template: 'A {type} port{magistrate}{primary}.', magistrate: ' under {magName}', primary: ', trading in {primary}' },
  },
  coda: {
    ship: { pirate: 'To this day {name} roves{bounty}.', default: '{name} sails out of {home}.', bounty: ', {bounty}g on her head' },
    island: { haven: '{name} flies the black flag.', default: '{name} endures, {population} souls under {magName}.' },
  },
  quiet: { ship: 'QUIET-SHIP', island: 'QUIET-ISLAND' },
};

const ISLANDS = new Map([['coralbay', { name: 'Coralbay' }], ['ironpeak', { name: 'Ironpeak' }]]);
const CTX = { islandsById: ISLANDS, shipLabel: (id) => 'Ship ' + id };
const SHIP = { name: 'the Salt Wraith', type: 'brig', homeId: 'coralbay', captain: { name: 'Anne Blackwood', rank: 'Veteran' } };
const ev = (id, day, kind, text, extra) => ({ id, seq: id, day, kind, text: text || `event ${id}`, ...extra });
const prose = (m) => m.blocks.filter((b) => b.type === 'prose');
const runsText = (b) => b.runs.map((r) => r.text).join('');
// Reproduce what the InfoPanel prose renderer shows: split each run on spaces, drop empties, join
// tokens with a single space EXCEPT a token opening with clause punctuation hugs the previous word
// (game/ui/InfoPanel.js _proseLines glue rule). Lets us assert on the user-visible sentence.
const render = (m) => prose(m).map((b) => {
  let out = '';
  for (const run of b.runs) for (const w of String(run.text).split(' ')) {
    if (!w) continue;
    out += out && !/^[,.;:!?)]/.test(w) ? ' ' + w : w;
  }
  return out;
}).join(' ');

test('empty chronicle → frame + coda + a single quiet line (no "No tale yet")', () => {
  const m = narrate([], { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  assert.equal(m.frame.title, 'the Salt Wraith');
  assert.match(m.frame.epigraph, /Coralbay/);
  assert.match(m.frame.epigraph, /Veteran/);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].runs[0].role, 'quiet');
  assert.equal(m.blocks[0].runs[0].text, 'QUIET-SHIP');
  assert.match(m.coda.text, /sails out of Coralbay/);
});

test('frame drops the captain clause cleanly when there is no captain', () => {
  const m = narrate([], { kind: 'ship', id: 's1', data: { name: 'the Gull', type: 'sloop', homeId: 'coralbay' } }, VOICE, CTX);
  assert.doesNotMatch(m.frame.epigraph, /Capt\./);
  assert.match(m.frame.epigraph, /A Coralbay sloop — trader\./);
});

test('a time connective opens a later episode, chosen by the day-gap bucket', () => {
  const entries = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 200, 'plunder', 'the Salt Wraith took a prize')];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const ps = prose(m);
  assert.equal(ps.length, 2, 'a 199-day gap starts a new episode');
  assert.equal(ps[1].runs[0].role, 'connective');
  assert.equal(ps[1].runs[0].text, 'YEAR, ', 'gap 199 ∈ (120,400] → year bucket');
});

test('recurrence callback appears on the 3rd same-class deed, not the 1st', () => {
  const entries = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 2, 'plunder', 'the Salt Wraith took a prize'), ev(3, 3, 'plunder', 'the Salt Wraith took a prize')];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const all = prose(m).flatMap((b) => b.runs);
  const callbacks = all.filter((r) => r.role === 'callback');
  assert.ok(callbacks.some((r) => /third/.test(r.text)), 'the 3rd prize is called out as the third');
  // The very first clause carries no callback.
  const firstClauseIdx = all.findIndex((r) => r.role === 'clause' || r.role === 'pivot');
  assert.notEqual(all[firstClauseIdx].role, 'callback');
});

test('pronoun elision: a non-first clause beginning with the ship name becomes "she"', () => {
  const entries = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 2, 'plunder', 'the Salt Wraith took another')];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const text = prose(m).map(runsText).join(' ');
  assert.match(text, /she took another/, 'second clause elides the name to "she"');
  assert.match(text, /^The Salt Wraith took a prize/, 'the first clause keeps the full name, capitalized as a sentence opener');
});

test('composed prose reads cleanly — no doubled/floating periods, sentence breaks capitalized', () => {
  // The sim emits full sentences ending in a period; the composer must not double or orphan them.
  const entries = [
    ev(1, 1, 'plunder', 'the Salt Wraith took a rich prize.'),
    ev(2, 1, 'plunder', 'the Salt Wraith took another.'),
    ev(3, 1, 'trade', 'Coralbay opened fire on a raider.'), // does NOT start with the ship name → its own sentence
  ];
  const text = render(narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX));
  assert.doesNotMatch(text, / \. |\.\./, 'no floating or doubled period');
  assert.doesNotMatch(text, /\.\s*,|\s,/, 'no orphaned comma');
  assert.doesNotMatch(text, /\.\s+[a-z]/, 'every sentence break is capitalized');
  assert.match(text, /^The Salt Wraith/, 'the tale opens on a capital');
  assert.match(text, /\.$/, 'the tale closes on a full stop');
  assert.match(text, /another, her second such prize/, 'the recurrence callback hugs its comma');
});

test('a pivot kind replaces the factual text with the reversal sentence', () => {
  const entries = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 5, 'pirate', 'Black flag! the Salt Wraith turned pirate')];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const all = prose(m).flatMap((b) => b.runs);
  assert.ok(all.some((r) => r.role === 'pivot' && r.text === 'PIVOT.'), 'the turn-pirate beat pivots');
  assert.ok(!all.some((r) => /turned pirate/.test(r.text)), 'the raw text is dropped in favor of the pivot');
});

test('pirate coda includes the bounty; island coda uses population + magistrate', () => {
  const pirate = { ...SHIP, pirate: true, bounty: 500 };
  const ms = narrate([], { kind: 'ship', id: 's1', data: pirate }, VOICE, CTX);
  assert.match(ms.coda.text, /500g on her head/);
  const isl = { name: 'Coralbay', type: 'forest', population: 3200, magistrate: { name: 'Governor Ashcombe', rank: 'Governor' }, primary: 'Wood' };
  const mi = narrate([], { kind: 'island', id: 'coralbay', data: isl }, VOICE, CTX);
  assert.match(mi.coda.text, /3,200 souls under Governor Ashcombe/);
  assert.match(mi.frame.epigraph, /A forest port under Governor Ashcombe, trading in Wood\./);
});

test('the filtered subset drives the tally (composer sees only what it is given)', () => {
  const entries = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 2, 'plunder', 'the Salt Wraith took a prize')];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const cbs = prose(m).flatMap((b) => b.runs).filter((r) => r.role === 'callback');
  assert.ok(cbs.some((r) => /second/.test(r.text)));
  assert.ok(!cbs.some((r) => /third/.test(r.text)), 'only two entries → tally never reaches three');
});

test('Layer C: a repeated foe (structured data) yields a cross-actor callback', () => {
  const entries = [
    ev(1, 1, 'plunder', 'the Salt Wraith took the Iron Gull', { data: { foeHome: 'Ironpeak', foeName: 'the Iron Gull' } }),
    ev(2, 3, 'plunder', 'the Salt Wraith took the Salt Maiden', { data: { foeHome: 'Ironpeak', foeName: 'the Salt Maiden' } }),
  ];
  const m = narrate(entries, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  const cbs = prose(m).flatMap((b) => b.runs).filter((r) => r.role === 'callback');
  assert.ok(cbs.some((r) => /second Ironpeak hull/.test(r.text)), 'the second Ironpeak victim is called out');
});

test('deterministic and prefix-stable: appending a new (episode-starting) event never reshuffles prior blocks', () => {
  const base = [ev(1, 1, 'plunder', 'the Salt Wraith took a prize'), ev(2, 2, 'plunder', 'the Salt Wraith took a prize')];
  const a = narrate(base, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  assert.deepEqual(a, narrate(base, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX), 'same input → identical output');
  const grown = [...base, ev(3, 500, 'plunder', 'the Salt Wraith took a prize')]; // big gap → a fresh episode
  const b = narrate(grown, { kind: 'ship', id: 's1', data: SHIP }, VOICE, CTX);
  assert.deepEqual(b.blocks.slice(0, a.blocks.length), a.blocks, 'prior blocks are byte-identical after an append');
});
