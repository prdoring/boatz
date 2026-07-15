import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChronicle } from '../server/chronicle.js';
import { requestHandler, setHistoryStore } from '../server/main.js';

// A synthetic world just carries the ring-buffer fields the chronicle reads: a rosterSeed and an
// ascending-id `events` array (the shape game/sim/events.js pushes). We never run the real sim here.
function fakeWorld(rosterSeed, events) { return { rosterSeed, events }; }
const ev = (id, extra) => ({ id, day: Math.ceil(id / 3), kind: 'trade', text: `event ${id}`, ...extra });

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

test('ingest records events; queryEntity returns one entity newest-first', (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable on this runtime');
  ch.ingest(fakeWorld(7, [
    ev(1, { islandId: 'coralbay' }),
    ev(2, { islandId: 'ironpeak' }),
    ev(3, { islandId: 'coralbay' }),
    ev(4, { shipId: 's5' }),
    ev(5, { islandId: 'coralbay' }),
  ]));

  const coral = ch.queryEntity(7, 'island', 'coralbay');
  assert.deepEqual(coral.map((e) => e.seq), [5, 3, 1], 'coralbay events, newest seq first');
  assert.equal(coral[0].islandId, 'coralbay');
  assert.equal(ch.queryEntity(7, 'island', 'ironpeak').length, 1);
  assert.equal(ch.queryEntity(7, 'ship', 's5').length, 1);
  // A bad kind or unknown id yields nothing (never throws).
  assert.deepEqual(ch.queryEntity(7, 'nope', 'coralbay'), []);
  assert.deepEqual(ch.queryEntity(7, 'island', 'atlantis'), []);
  ch.close();
});

test('re-ingesting an overlapping window is idempotent (dedup by seq)', (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable');
  const w = fakeWorld(1, [ev(1, { islandId: 'a' }), ev(2, { islandId: 'a' })]);
  ch.ingest(w);
  ch.ingest(w);                                   // same window again — high-water skips it
  w.events.push(ev(3, { islandId: 'a' }));
  ch.ingest(w);                                   // window still holds 1,2,3 — only 3 is new
  assert.equal(ch.queryEntity(1, 'island', 'a').length, 3, 'no duplicate rows');
  ch.close();
});

test('queryEntity paginates with the before cursor', (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable');
  ch.ingest(fakeWorld(2, [1, 2, 3, 4, 5].map((i) => ev(i, { islandId: 'p' }))));

  const page1 = ch.queryEntity(2, 'island', 'p', { limit: 2 });
  assert.deepEqual(page1.map((e) => e.seq), [5, 4]);
  const page2 = ch.queryEntity(2, 'island', 'p', { limit: 2, before: page1[page1.length - 1].seq });
  assert.deepEqual(page2.map((e) => e.seq), [3, 2]);
  const page3 = ch.queryEntity(2, 'island', 'p', { limit: 2, before: page2[page2.length - 1].seq });
  assert.deepEqual(page3.map((e) => e.seq), [1], 'last page shorter than the limit → the end');
  ch.close();
});

test('timeline scopes by world_id and filters by kind', (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable');
  ch.ingest(fakeWorld(10, [ev(1, { kind: 'haven', islandId: 'a' }), ev(2, { kind: 'trade', islandId: 'b' })]));
  ch.ingest(fakeWorld(20, [ev(1, { kind: 'pirate', shipId: 's1' })]));

  assert.equal(ch.queryTimeline(10).length, 2, 'world 10 has 2 events');
  assert.equal(ch.queryTimeline(20).length, 1, 'world 20 is separate');
  assert.deepEqual(ch.queryTimeline(10, { kinds: ['haven'] }).map((e) => e.kind), ['haven'], 'kind filter');
  assert.equal(ch.worldId(), 20, 'worldId() tracks the most-recently-ingested sea');
  ch.close();
});

test('a structured data payload round-trips through ingest → queryEntity (JSON stored + parsed back)', (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable');
  ch.ingest(fakeWorld(5, [
    ev(1, { shipId: 's1', data: { foeName: 'the Salt Maiden', foeHome: 'Coralbay' } }),
    ev(2, { shipId: 's1' }), // no data
  ]));
  const rows = ch.queryEntity(5, 'ship', 's1');
  assert.deepEqual(rows.find((r) => r.seq === 1).data, { foeName: 'the Salt Maiden', foeHome: 'Coralbay' }, 'data comes back parsed');
  assert.equal(rows.find((r) => r.seq === 2).data, null, 'an event without data reads back as null');
  ch.close();
});

test('re-opening a DB is safe — the data-column migration is idempotent', (t) => {
  const p = path.join(os.tmpdir(), `boatz-chron-${process.pid}.db`);
  const cleanup = () => { for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f); } catch { /* ignore */ } } };
  cleanup();
  const a = createChronicle({ path: p });
  if (!a.enabled) { cleanup(); return t.skip('node:sqlite unavailable'); }
  a.ingest(fakeWorld(1, [ev(1, { shipId: 's1', data: { k: 'v' } })]));
  a.close();
  const b = createChronicle({ path: p }); // re-open → the migration runs again and must not throw
  assert.equal(b.enabled, true);
  assert.deepEqual(b.queryEntity(1, 'ship', 's1')[0].data, { k: 'v' }, 'data survives a close/reopen');
  b.close();
  cleanup();
});

test('a no-op store (no path) never throws and returns empty', () => {
  const ch = createChronicle({});                 // no path → no-op regardless of node:sqlite
  assert.equal(ch.enabled, false);
  ch.ingest(fakeWorld(1, [ev(1, { islandId: 'a' })]));
  assert.deepEqual(ch.queryEntity(1, 'island', 'a'), []);
  assert.deepEqual(ch.queryTimeline(1), []);
  ch.close();
});

test('GET /api/history is public JSON, and empty when no store is wired', async (t) => {
  const ch = createChronicle({ path: ':memory:' });
  if (!ch.enabled) return t.skip('node:sqlite unavailable');
  ch.ingest(fakeWorld(99, [ev(1, { islandId: 'coralbay' }), ev(2, { islandId: 'coralbay' })]));

  const server = http.createServer(requestHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    setHistoryStore(ch);
    // Entity query — public (no auth header), scoped to the live sea when `world` is omitted.
    const r1 = await getJson(`${base}/api/history?entity=island:coralbay`);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.entries.length, 2);
    assert.equal(r1.json.world, 99, 'echoes the live world id');
    assert.equal(r1.json.nextBefore, r1.json.entries[r1.json.entries.length - 1].seq);

    // Timeline query.
    const r2 = await getJson(`${base}/api/history?timeline=1&world=99`);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.entries.length, 2);

    // Malformed entity → 400 (not a crash).
    const r3 = await getJson(`${base}/api/history?entity=garbage`);
    assert.equal(r3.status, 400);

    // No store wired (the bare test/smoke path) → graceful empty, still 200.
    setHistoryStore(null);
    const r4 = await getJson(`${base}/api/history?entity=island:coralbay`);
    assert.equal(r4.status, 200);
    assert.deepEqual(r4.json.entries, []);
  } finally {
    setHistoryStore(null);
    ch.close();
    await new Promise((r) => server.close(r));
  }
});
