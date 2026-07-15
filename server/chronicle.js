// Server-only durable world chronicle — a fail-soft SQLite sink for the sim's event stream.
//
// The sim (game/sim/*) stays pure, deterministic, and dependency-free. This module OBSERVES
// `world.events` (a ring buffer hard-capped at EVENT_LOG_MAX, so long-run history is otherwise
// lost) and appends the new tail to SQLite, scoped per-sea by `world_id` (= world.rosterSeed).
//
// The one invariant that keeps determinism safe: the chronicle is WRITE-ONLY from the sim's
// side (drained here by the server loop, never read back into the sim) and READ-ONLY from the
// presentation side (server/main.js `/api/history`). A DB read into the sim would break the
// simSerialize determinism gate — so it never happens.
//
// `node:sqlite` is a Node builtin (>= 22.5, still flagged experimental). It is loaded FAIL-SOFT
// and LAZILY: only when a real db path is requested (never in tests / the browser smoke, which
// pass no path), and if the runtime lacks it, createChronicle returns a no-op store. So nothing
// throws, there are zero side effects without a path, and the experimental warning never fires
// during the test suite.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let DatabaseSync;          // resolved on first real use
let sqliteTried = false;
function loadSqlite() {
  if (!sqliteTried) {
    sqliteTried = true;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { /* Node < 22.5 or built without SQLite — chronicle stays a no-op */ }
  }
  return DatabaseSync;
}

// The store shape callers rely on. The no-op satisfies it so simHost / the endpoint never
// branch on "is there a DB" — they just call through and get empty results.
const NOOP = Object.freeze({
  enabled: false,
  ingest() {},
  queryEntity() { return []; },
  queryTimeline() { return []; },
  worldId() { return null; },
  close() {},
});

const MAX_LIMIT = 100;
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(n) || 50)));
const SELECT_COLS = 'seq, day, kind, text, ship_id AS shipId, island_id AS islandId, x, y, data';

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
// Rows store `data` as a JSON string; hand it back to callers as a parsed object (null when absent).
const parseRow = (r) => (r.data != null ? { ...r, data: safeParse(r.data) } : r);

/**
 * Open a chronicle at `path`, or return a no-op store. `path === null` (the default, used by
 * tests and the smoke run) or a runtime without `node:sqlite` both yield the no-op. Pass
 * ':memory:' for an ephemeral DB (tests exercise the real store this way).
 */
export function createChronicle({ path: dbPath = null } = {}) {
  if (!dbPath) return NOOP;
  const DB = loadSqlite();
  if (!DB) return NOOP;

  let db;
  try {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DB(dbPath);
  } catch {
    return NOOP; // unwritable path / bad build — degrade rather than crash the server
  }

  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      world_id  INTEGER NOT NULL,
      seq       INTEGER NOT NULL,
      day       INTEGER,
      kind      TEXT,
      text      TEXT,
      ship_id   TEXT,
      island_id TEXT,
      x         REAL,
      y         REAL,
      data      TEXT,
      PRIMARY KEY (world_id, seq)
    );
    CREATE INDEX IF NOT EXISTS ix_events_island ON events (world_id, island_id, seq);
    CREATE INDEX IF NOT EXISTS ix_events_ship   ON events (world_id, ship_id, seq);
    CREATE INDEX IF NOT EXISTS ix_events_world  ON events (world_id, seq);
  `);
  // Migrate a DB created before the structured `data` column existed (idempotent, fail-soft — a locked
  // or older runtime just leaves it absent, and every query below still works without it).
  try {
    const cols = db.prepare('PRAGMA table_info(events)').all();
    if (!cols.some((c) => c.name === 'data')) db.exec('ALTER TABLE events ADD COLUMN data TEXT');
  } catch { /* leave the column absent */ }

  // INSERT OR IGNORE + the (world_id, seq) PK makes re-ingesting an overlapping window a no-op,
  // so the drain is idempotent even independent of the high-water mark below.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (world_id, seq, day, kind, text, ship_id, island_id, x, y, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const highWater = new Map(); // world_id -> highest seq already ingested (a sea can re-seed on restart)
  let liveWorld = null;        // most-recently-ingested world_id → the endpoint's default scope

  /** Drain the new tail of `world.events` (records with id past the high-water mark) into the DB. */
  function ingest(world) {
    if (!world || !world.events || !world.events.length) return;
    const wid = (world.rosterSeed || 0) >>> 0;
    liveWorld = wid;
    const from = highWater.get(wid) || 0;
    const fresh = [];
    let max = from;
    for (const e of world.events) {
      if (e.id > from) { fresh.push(e); if (e.id > max) max = e.id; }
    }
    if (!fresh.length) return;
    db.exec('BEGIN');
    try {
      for (const e of fresh) {
        insert.run(
          wid, e.id, e.day ?? null, e.kind ?? null, e.text ?? null,
          e.shipId != null ? String(e.shipId) : null,
          e.islandId != null ? String(e.islandId) : null,
          e.x ?? null, e.y ?? null,
          e.data != null ? JSON.stringify(e.data) : null,
        );
      }
      db.exec('COMMIT');
      highWater.set(wid, max);
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    }
  }

  const scope = (worldId) => (worldId != null && worldId !== '' ? (Number(worldId) >>> 0) : liveWorld);

  /** One entity's chronicle (kind ∈ 'island'|'ship'), newest first, paginated by `before` (a seq). */
  function queryEntity(worldId, kind, id, { before, limit } = {}) {
    const wid = scope(worldId);
    if (wid == null) return [];
    const col = kind === 'ship' ? 'ship_id' : kind === 'island' ? 'island_id' : null;
    if (!col || id == null) return [];
    const cur = before != null && before !== '' ? Number(before) : null;
    const sql = `SELECT ${SELECT_COLS} FROM events
                 WHERE world_id = ? AND ${col} = ?${cur != null ? ' AND seq < ?' : ''}
                 ORDER BY seq DESC LIMIT ?`;
    const stmt = db.prepare(sql);
    const rows = cur != null
      ? stmt.all(wid, String(id), cur, clampLimit(limit))
      : stmt.all(wid, String(id), clampLimit(limit));
    return rows.map(parseRow);
  }

  /** The world timeline, newest first, optionally filtered to a set of event `kinds`. */
  function queryTimeline(worldId, { kinds, before, limit } = {}) {
    const wid = scope(worldId);
    if (wid == null) return [];
    const ks = Array.isArray(kinds) ? kinds.filter(Boolean) : null;
    const cur = before != null && before !== '' ? Number(before) : null;
    const where = ['world_id = ?'];
    const args = [wid];
    if (ks && ks.length) { where.push(`kind IN (${ks.map(() => '?').join(',')})`); args.push(...ks); }
    if (cur != null) { where.push('seq < ?'); args.push(cur); }
    args.push(clampLimit(limit));
    const sql = `SELECT ${SELECT_COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`;
    return db.prepare(sql).all(...args).map(parseRow);
  }

  return {
    enabled: true,
    ingest,
    queryEntity,
    queryTimeline,
    worldId: () => liveWorld,
    close() { try { db.close(); } catch { /* ignore */ } },
  };
}
