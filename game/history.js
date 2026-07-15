// Client-side reader for the durable world chronicle (server/chronicle.js), over the PUBLIC,
// read-only /api/history endpoint. This is deliberately separate from the WebSocket sim stream:
// history is bulk, on-demand, and paginated, so it rides plain same-origin fetch and is cached
// per subject. Presentation only — the sim never reads this back.
//
// Each subject (an entity `kind:id`, or the world `timeline`) accumulates DB pages newest-first;
// callers merge in the live event tail (SimClient._history / econ events) via mergeChronicle, so a
// panel shows deep permanent history AND the freshest events with no double-counting (the DB `seq`
// IS the live event `id`, so dedup is a single key).

export class HistoryStore {
  constructor({ worldId = null } = {}) {
    this.worldId = worldId;   // set from WELCOME → scopes queries to THIS sea
    this._cache = new Map();  // subjectKey -> { entries, nextBefore, done, loading }
  }

  /** New sea → drop everything (a restart / reconnect can re-seed the world). */
  setWorld(id) {
    if (id == null || id === this.worldId) return;
    this.worldId = id;
    this._cache.clear();
  }

  _key(kind, id) { return kind === 'timeline' ? 'timeline' : `${kind}:${id}`; }

  _entry(kind, id) {
    const k = this._key(kind, id);
    let e = this._cache.get(k);
    if (!e) { e = { entries: [], nextBefore: undefined, done: false, loading: false }; this._cache.set(k, e); }
    return e;
  }

  /** Load the first (newest) page for a subject if nothing is loaded yet. Returns the cache entry. */
  ensure(kind, id, opts) {
    const e = this._entry(kind, id);
    if (!e.entries.length && !e.loading && !e.done) this._page(e, kind, id, opts);
    return e;
  }

  /** Load the next older page — call when a view scrolls to its history edge. */
  more(kind, id, opts) {
    const e = this._entry(kind, id);
    if (!e.loading && !e.done) this._page(e, kind, id, opts);
    return e;
  }

  async _page(entry, kind, id, opts = {}) {
    entry.loading = true;
    try {
      const res = await fetch(this._url(kind, id, entry.nextBefore, opts));
      const data = await res.json();
      const rows = Array.isArray(data.entries) ? data.entries : [];
      if (this.worldId == null && data.world != null) this.worldId = data.world;
      const seen = new Set(entry.entries.map((r) => r.seq));
      for (const r of rows) if (!seen.has(r.seq)) entry.entries.push(r); // kept newest-first (DB DESC)
      entry.nextBefore = data.nextBefore;
      entry.done = rows.length === 0 || data.nextBefore == null;
    } catch {
      /* transient (offline / no chronicle) — leave done=false so a later interaction can retry */
    } finally {
      entry.loading = false;
    }
  }

  _url(kind, id, before, opts = {}) {
    const p = new URLSearchParams();
    if (this.worldId != null) p.set('world', String(this.worldId));
    if (before != null) p.set('before', String(before));
    if (opts.limit) p.set('limit', String(opts.limit));
    if (kind === 'timeline') p.set('timeline', '1'); // filtering by category is done client-side over loaded pages
    else p.set('entity', `${kind}:${id}`);
    return '/api/history?' + p.toString();
  }
}

/**
 * Merge deep DB pages (newest-first) with the live event tail (newest-first), deduped by the shared
 * monotonic id (`seq` in the DB, `id` on live records). `ascending` true reads oldest→newest (the
 * Story tab's narrative order); false is newest-first (the news timeline).
 */
export function mergeChronicle(deep, live, { ascending = true } = {}) {
  const byId = new Map();
  const put = (r) => {
    const s = r.seq != null ? r.seq : r.id;
    if (s == null || byId.has(s)) return; // deep is added first, so its richer fields win
    byId.set(s, r.seq != null ? r : { ...r, seq: s });
  };
  for (const r of deep) put(r);
  for (const r of live) put(r);
  const out = Array.from(byId.values());
  out.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
  return out;
}
