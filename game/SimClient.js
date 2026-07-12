// shared.sim — the client-side simulation service. Owns the network client, the
// interpolation buffer for ships, the merge-by-id economy store, the current
// selection, connection status, and the authoritative clock. A plain object that
// SURVIVES scene switches (a future title/port/fleet scene reuses it, and a
// selection persists across scenes for free). Scenes only read from it + route input.
//
// Everything the browser knows about the world flows through here; the renderer and
// panels read snapshots, never the socket. The sim itself runs only on the server.

import { NetworkClient } from '/engine/net/NetworkClient.js';
import { StateBuffer } from '/engine/net/StateBuffer.js';
import { M, PROTOCOL_VERSION } from './protocol.js';
import { SHIP_LERP, SHIP_ANGLE, SHIP_COPY } from './sim/snapshot.js';
import { OCEAN, RENDER_DELAY } from './config.js';

export class SimClient {
  constructor({ url } = {}) {
    this.net = new NetworkClient(url);
    // Ships interpolate position/heading; everything else copies from the latest
    // snapshot. Field descriptors come from snapshot.js — the single source of
    // truth shared with the server projection (no schema drift).
    this.buffer = new StateBuffer({
      renderDelay: RENDER_DELAY, maxSnapshots: 12,
      fields: { lerp: SHIP_LERP, lerpAngle: SHIP_ANGLE, copy: SHIP_COPY },
    });

    this.islandsById = new Map();  // id -> island (static layout enriched by econ, merged by id)
    this.islands = [];             // array view (insertion order)
    this.economy = { totalGold: 0, shipCount: 0 };
    this.events = [];              // recent world events (blight/plague/wreck) for the news feed
    this._history = new Map();     // entityKey ("ship:s5"/"island:x") -> [event…] chronicle, built from the stream
    this._histSeen = 0;            // highest event id ingested (dedupe across overlapping snapshots)
    this.goods = [];
    this.raw = [];
    this.mapW = OCEAN.width;
    this.mapH = OCEAN.height;

    this.wind = { dir: 0, str: 0 }; // global wind (dir it blows toward, strength 0..1)
    this.storms = [];              // active named storm cells { id, name, x, y, r }
    this.season = null;            // { idx, name, day } — the turning year
    this.selected = null;          // { kind:'island'|'ship', id }
    this.status = 'connecting';    // 'connecting' | 'live' | 'disconnected'
    this.clientId = null;
    this.versionMismatch = false;
    this.clock = { simTime: 0, speed: 1, paused: false, dayLength: 60 };

    this._wire();
  }

  _wire() {
    this.net
      .on(M.WELCOME, (m) => this._onWelcome(m))
      .on(M.STATE_SHIPS, (m) => this._onShips(m))
      .on(M.STATE_ECON, (m) => this._onEcon(m))
      .onOpen(() => { if (this.status === 'disconnected') this.status = 'connecting'; })
      .onClose(() => { this.status = 'disconnected'; })
      .onReconnect(() => { this.status = 'connecting'; });
  }

  connect() { this.status = 'connecting'; this.net.connect(); return this; }
  close() { this.net.close(); }

  // ─── Message handlers ────────────────────────────────────────────
  _onWelcome(m) {
    this.checkVersion(m);
    this.clientId = m.clientId;
    if (m.mapW) this.mapW = m.mapW;
    if (m.mapH) this.mapH = m.mapH;
    if (Array.isArray(m.goods)) this.goods = m.goods;
    if (Array.isArray(m.raw)) this.raw = m.raw;
    if (m.dayLength) this.clock.dayLength = m.dayLength;
    // Static layout: positions/name/type/color, so islands draw before the first
    // economy snapshot arrives. Merge-by-id (never wholesale replace).
    for (const isl of (m.layout || [])) this._mergeIsland(isl);
    this.status = 'live';
  }

  checkVersion(m) {
    if (m.protocolVersion != null && m.protocolVersion !== PROTOCOL_VERSION) {
      this.versionMismatch = true;
      console.warn(`[SimClient] protocol mismatch: server v${m.protocolVersion}, client v${PROTOCOL_VERSION}. Reload for the current client.`);
    }
  }

  _onShips(m) {
    // The whole message IS the StateBuffer snapshot: `entities` interpolates, the
    // top-level clock fields ride along (copied from the latest on interpolation).
    this.buffer.push(m);
    if (typeof m.simTime === 'number') this.clock.simTime = m.simTime;
    if (typeof m.speed === 'number') this.clock.speed = m.speed;
    if (typeof m.paused === 'boolean') this.clock.paused = m.paused;
    if (m.wind) this.wind = m.wind;
    if (m.storms) this.storms = m.storms;
    if (m.season) this.season = m.season;
    if (this.status !== 'disconnected') this.status = 'live';
  }

  _onEcon(m) {
    for (const isl of (m.islands || [])) this._mergeIsland(isl);
    if (m.economy) this.economy = m.economy;
    if (m.events) { this.events = m.events; this._ingestHistory(m.events); }
  }

  // Build each ship's/island's chronicle from the event stream (deduped by monotonic id).
  _ingestHistory(events) {
    const HIST_MAX = 40;
    for (const e of events) {
      if (e.id == null || e.id <= this._histSeen) continue;
      const push = (key) => {
        let arr = this._history.get(key);
        if (!arr) { arr = []; this._history.set(key, arr); }
        arr.push({ id: e.id, day: e.day, kind: e.kind, text: e.text });
        if (arr.length > HIST_MAX) arr.shift();
      };
      if (e.shipId != null) push('ship:' + e.shipId);
      if (e.islandId != null) push('island:' + e.islandId);
      this._histSeen = e.id;
    }
  }

  /** An entity's chronicle, newest first (empty until events for it arrive while watching). */
  getHistory(kind, id) {
    const arr = this._history.get(kind + ':' + id);
    return arr ? arr.slice().reverse() : [];
  }

  _mergeIsland(isl) {
    const cur = this.islandsById.get(isl.id);
    if (cur) { Object.assign(cur, isl); return; }
    this.islandsById.set(isl.id, { ...isl });
    this.islands = Array.from(this.islandsById.values());
  }

  // ─── Reads (called by scene / renderer / panels each frame) ──────
  /** Interpolated world snapshot `{ entities:{id:ship}, simTime, speed, paused, ... }` or null. */
  getWorld(now) { return this.buffer.getInterpolated(now); }

  getEcon() {
    return {
      islands: this.islands, islandsById: this.islandsById,
      economy: this.economy, goods: this.goods, raw: this.raw, events: this.events,
    };
  }

  /** Toggle selection: re-selecting the same thing clears it. `kind` null clears. */
  select(kind, id) {
    if (!kind || id == null) { this.selected = null; return; }
    if (this.selected && this.selected.kind === kind && this.selected.id === id) {
      this.selected = null; return;
    }
    this.selected = { kind, id };
  }

  /** Force a selection without the toggle (used by news-item focus, which should always select). */
  focusSelect(kind, id) { this.selected = (kind && id != null) ? { kind, id } : null; }

  /** Re-resolve the selected object by id every frame (ids are stable; objects aren't). */
  getSelected(world) {
    const sel = this.selected;
    if (!sel) return null;
    if (sel.kind === 'island') {
      const data = this.islandsById.get(sel.id);
      if (!data) { this.selected = null; return null; }
      return { kind: 'island', id: sel.id, data };
    }
    // ship: resolve against the interpolated world (tracks the smooth position).
    const ents = world && world.entities;
    if (!ents) return { kind: 'ship', id: sel.id, data: null }; // no snapshot yet — keep it
    const data = ents[sel.id];
    if (!data) { this.selected = null; return null; }           // ship vanished → clear cleanly
    return { kind: 'ship', id: sel.id, data };
  }

  /** Presentation clock: Day N + HH:MM derived from simTime + dayLength. */
  getClock() {
    const { simTime, speed, paused, dayLength } = this.clock;
    const day = Math.floor(simTime / dayLength) + 1;
    const frac = ((simTime % dayLength) + dayLength) % dayLength / dayLength; // 0..1 of a day
    const mins = Math.floor(frac * 24 * 60);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return { simTime, speed, paused, day, hh, mm, timeLabel: `${hh}:${mm}` };
  }

  // ─── Commands (observer/admin clock control; gated server-side) ──
  setSpeed(s) { this.net.send({ type: M.SET_SPEED, speed: s }); }
  togglePause() { this.net.send({ type: M.SET_SPEED, paused: !this.clock.paused }); }
  setPaused(p) { this.net.send({ type: M.SET_SPEED, paused: !!p }); }
}
