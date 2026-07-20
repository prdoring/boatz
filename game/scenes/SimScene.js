// The map scene: renders the interpolated world from shared.sim, routes input
// (drag/keys pan, wheel zoom, click select, space pause), and hosts the UI stack
// (InfoPanel + SimControls). It owns only transient scene state — held pan keys, the
// drag press, the wake-throttle counter, the UI stack. All world truth lives in
// shared.sim; the scene never simulates and never touches the socket directly.

import { Scene } from '/engine/core/Scene.js';
import { UIStack } from '../ui/UIStack.js';
import { InfoPanel } from '../ui/InfoPanel.js';
import { NewsPanel } from '../ui/NewsPanel.js';
import { SimControls } from '../ui/SimControls.js';
import { OverviewDashboard } from '../ui/OverviewDashboard.js';
import { OverviewControls } from '../ui/OverviewControls.js';
import { islandRadius } from '../WorldRenderer.js';
import { OVERLAYS, heatColor, overlayByKey, fmtValue } from '../overlays.js';
import { OverlayModel } from '../overlayModel.js';
import { HistoryStore, mergeChronicle } from '../history.js';
import { SPEEDS } from '../protocol.js';
import { plate, font as tfont } from '../ui/theme.js';
import { drawIcon } from '../ui/icons.js';
import { eventColor, seasonIcon } from '../ui/eventKinds.js';
import {
  PALETTE, OCEAN, SHIP_HIT, ZOOM_STEP, PAN_SPEED, WAKE_EVERY, WAKE_MIN_ZOOM,
} from '../config.js';

// How often (ms) the hover tooltip re-runs its O(N+S) hit-test while the cursor sits still. On
// cursor-move it recomputes immediately; parked, it refreshes at this cadence so a ship gliding
// underneath still updates the card — without a full island+ship scan on every one of 60 frames/s.
const HOVER_PICK_MS = 120;

const PAN_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1],
};

// Event-kind display colours (blight/plague/…) come from the shared eventKinds.eventColor() — one
// source for the crawl, the Story browser, and these HUD tooltips (the local copy was deleted).

// Which nautical FX sequence a live event fires (SimScene._fireEventFx). Reads the SAME event
// stream the ticker uses (sim.getEcon().events). SINK kinds (wreck/starve/stormloss/hunterlost/
// lost) are deliberately ABSENT — the ship-disappearance detector owns the sink visual, so we
// never double up a foundering with a second splash.
const EVENT_FX = {
  plunder: 'raidPlunder',
  fended: 'shipHit', raidfail: 'shipHit',
  raid: 'fireBroadside', assault: 'fireBroadside', pirate: 'fireBroadside', hunted: 'fireBroadside',
  contractdone: 'tradeComplete', boom: 'tradeComplete', bounty: 'tradeComplete',
};

// Short human labels for a ship's voyage purpose (the hover tooltip / quick glance).
const REASON_LABEL = {
  food: 'Fetching food', migrate: 'Carrying migrants', buyShip: 'Buying a ship',
  trade: 'Trading', scout: 'Scouting prices', aid: 'Aid convoy',
};

/** A one-word vitality descriptor from an island's fill (pop/capacity) and civ. Kept in step
 *  with InfoPanel.islandState so the hover tooltip and the panel badge never disagree. */
function islandStateWord(isl) {
  const ratio = isl.k ? (isl.population || 0) / isl.k : 0;
  const civ = isl.civ || 0;
  if (ratio < 0.35 || civ < 0.12) return 'Struggling';
  if (civ >= 0.55) return 'Prosperous';
  if (ratio >= 0.8) return 'Established';
  return 'Growing';
}

// ─── wind display helpers ───────────────────────────────────────────
const WIND_DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
function compass8(dir) {
  const a = ((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return WIND_DIRS[Math.round(a / (Math.PI / 4)) % 8];
}
function windWord(str) { return str < 0.35 ? 'Light' : str < 0.6 ? 'Moderate' : str < 0.82 ? 'Fresh' : 'Strong'; }
function windColor(str) { return str < 0.35 ? '#7fd0e0' : str < 0.6 ? '#6fc98a' : str < 0.82 ? '#e0b24a' : '#e07a4a'; }
function moraleColor(m) { return m >= 0.6 ? '#8ee6a0' : m >= 0.4 ? '#8fc6d4' : m >= 0.28 ? '#e0b24a' : '#ff7b6b'; }

/** How the wind sits relative to a ship's heading → { label, color } for a quick read. */
function windRelation(heading, wind) {
  if (!wind || wind.str < 0.05 || heading == null) return null;
  const align = Math.cos(heading - wind.dir); // +1 tailwind … −1 headwind
  if (align > 0.35) return { label: 'Tailwind', color: '#8ee6a0' };
  if (align < -0.35) return { label: 'Headwind', color: '#ff9d5c' };
  return { label: 'Crosswind', color: '#8fc6d4' };
}

/** Trace a rounded-rect path (fill/stroke by the caller). Portable — no ctx.roundRect dep. */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class SimScene extends Scene {
  constructor(shared) {
    super();
    this.shared = shared;
    this.sim = shared.sim;
    this.keys = new Set();
    this._lastNow = 0;
    this._wakeTick = 0;
    // Two INDEPENDENT map data layers, each an on/off toggle (the toolbar buttons flip them; the
    // Almanac panel picks WHICH). A scalar OVERLAY tints ports; a LINKS overlay draws edges between
    // them — both can paint at once. `off` = that layer is hidden; `_last*` restores the prior
    // choice when a layer is toggled back on from the toolbar/hotkey.
    this._overlayKey = 'off';       // active SCALAR overlay key (heat tint), or 'off'
    this._linkKey = 'off';          // active LINKS overlay key (relational edges), or 'off'
    this._lastOverlayKey = 'wealth';    // scalar restored when [Overlays] is re-enabled
    this._lastLinkKey = 'alliances';    // links restored when [Links] is re-enabled
    this._overlayModel = new OverlayModel(); // throttled derived stats/leaderboard/edges for both layers
    this._press = null;       // drag-to-pan state
    this._world = null;       // latest interpolated snapshot (this frame)
    this._selection = null;
    this._followCancelled = false; // true once the user pans away from a followed ship
    this._view = { width: 0, height: 0 };
    this.history = new HistoryStore(); // deep chronicle reader (/api/history), scoped per sea

    // ── Client-only presentation FX state (never written onto snapshots) ──
    this._fxSeen = null;          // high-water mark of event.id fired (primed on 1st live frame)
    this._shipFx = new Map();     // ship id → expiry(now) for a transient 'damaged' overlay (from a sequence signal)
    this._sinkActors = [];        // client-owned foundering ships (copies, drawn with the 'sinking' art)
    this._lastState = null;       // ship id → last display state (for depart/arrive deltas)
    this._lastShipPos = null;     // ship id → last {x,y,heading,type,pirate,privateer,homeId} (wreck detector)

    this.ui = new UIStack();
    this.infoPanel = new InfoPanel({
      getSelection: () => this._selection,
      getContext: () => ({
        goods: this.sim.goods, raw: this.sim.raw,
        islandsById: this.sim.islandsById,
        shipsById: this._world ? this._world.entities : null,
        wind: this.sim.wind,
        portraits: this.shared.portraits,
        voices: this.shared.voices, // per-keeper writing-style catalogue → the Story tab's first-person logbook
        seasons: this.sim.seasons, seasonDays: this.sim.seasonDays, // for the Story tab's dated datelines
        getHistory: (kind, id) => this.sim.getHistory(kind, id),
        // The entity's full chronicle: deep DB pages merged with the live event tail, in narrative
        // order (oldest→newest). Kicks off the fetch on first read; returns cached rows thereafter.
        getChronicle: (kind, id) => this._chronicle(kind, id),
      }),
    });
    this.controls = new SimControls({
      onSetSpeed: (s) => this.sim.setSpeed(s),
      onTogglePause: () => this.sim.togglePause(),
      getClock: () => this.sim.getClock(),
      speeds: SPEEDS,
    });
    // The news ticker (collapsed crawl) / world-history browser (expanded). Reads live events + the
    // deep timeline; focuses events back through the scene's camera/selection.
    this.newsPanel = new NewsPanel({
      getEvents: () => this.sim.getEcon().events || [],
      getTimeline: () => this._timeline(),
      eventLoc: (e) => this._eventLoc(e),
      focus: (e) => this._focusEvent(e),
      // Pin the ticker's right edge clear of the bottom-centre control cluster (SimControls' left
      // screen edge, set in its layout). Evaluated at draw time, so .x is populated.
      getControlsLeft: () => this.controls.x,
    });
    // The world almanac (press `m`): aggregate stats + active-metric distribution + a clickable
    // fly-to leaderboard. Reads the throttled overlay model + the sim's summary, never the socket.
    this.dashboard = new OverviewDashboard({
      getModel: () => this._overlayModel,
      getScalarSpec: () => overlayByKey(this._overlayKey),
      getLinkSpec: () => overlayByKey(this._linkKey),
      getSummary: () => ({ economy: this.sim.economy, season: this.sim.season, clock: this.sim.getClock(), islandCount: this.sim.islands.length }),
      getRegistry: () => OVERLAYS,
      setOverlay: (key) => this._setOverlay(key),
      setLinks: (key) => this._setLinks(key),
      onPickIsland: (id) => this._focusIsland(id),
      nameById: (id) => { const isl = this.sim.islandsById.get(id); return isl ? isl.name : id; },
    });
    // Top-left toolbar: mouse access to the two map layers + the Almanac. Each button is a plain
    // on/off TOGGLE (click again hides the layer); WHICH metric/link a layer shows is chosen in the
    // Almanac panel (setOverlay/setLinks above). The Almanac is the picker + readout, not a layer.
    this.overviewControls = new OverviewControls({
      onOverlay: () => this._setOverlay(this._overlayKey === 'off' ? this._lastOverlayKey : 'off'),
      onLinks: () => this._setLinks(this._linkKey === 'off' ? this._lastLinkKey : 'off'),
      onAlmanac: () => this.dashboard.toggle(),
      overlayActive: () => this._overlayKey !== 'off',
      linksActive: () => this._linkKey !== 'off',
      almanacActive: () => this.dashboard.visible,
    });
    this.ui.add(this.newsPanel);
    this.ui.add(this.infoPanel);
    this.ui.add(this.controls);
    this.ui.add(this.dashboard);
    this.ui.add(this.overviewControls); // last = top of the z-stack for clicks
  }

  /** The world timeline for the NewsPanel: deep DB history merged with the live event tail, newest
   *  first, with a pager for older pages. */
  _timeline() {
    const page = this.history.ensure('timeline', '', { limit: 100 });
    const live = this.sim.getEcon().events || [];
    return {
      entries: mergeChronicle(page.entries, live, { ascending: false }),
      loading: page.loading,
      done: page.done,
      more: () => this.history.more('timeline', '', { limit: 100 }),
    };
  }

  enter() {
    this.keys.clear();
    // Fit to the best size we know now (config fallback); re-fit once the server's real
    // map dimensions arrive in WELCOME (the ocean scales with island count → not a constant).
    this._fitCamera();
    this._fitted = !!this.sim.mapW; // if already connected (re-entry), the real size is known
    this.sim.connect();
    this._layout();
  }

  /** Center + zoom-to-fit the whole ocean. Uses the server's real map size when known,
   *  else the config default. Works for any ocean/viewport size. */
  _fitCamera() {
    const { camera, canvas } = this.shared;
    const w = this.sim.mapW || OCEAN.width, h = this.sim.mapH || OCEAN.height;
    camera.x = w / 2;
    camera.y = h / 2;
    const vw = canvas.clientWidth || canvas.width || 1280;
    const vh = canvas.clientHeight || canvas.height || 720;
    camera.setZoom(Math.min(vw / w, vh / h) * 0.92);
  }

  exit() {
    // shared.sim is a cross-scene service — do NOT close the socket here. Just drop
    // this scene's transient visual state so wakes/effects don't leak on re-entry.
    this.shared.effects.stopAll();
    if (this.shared.sequences) this.shared.sequences.stopAll();
    this._shipFx.clear();
    this._sinkActors.length = 0;
    this._lastState = null;
    this._lastShipPos = null;
    this._fxSeen = null;
    this.keys.clear();
    this._press = null;
  }

  // ─── update ──────────────────────────────────────────────────────
  update(now) {
    const dt = this._lastNow ? Math.min(0.05, (now - this._lastNow) / 1000) : 0.016;
    this._lastNow = now;
    this._layout();
    this._panCamera(dt);

    const world = this.sim.getWorld(now);
    this._world = world;
    this.history.setWorld(this.sim.worldId); // adopt the live sea's id (drops cache on a re-seed)
    if (!this._fitted && this.sim.mapW) { this._fitCamera(); this._fitted = true; } // one-time fit to the real ocean size
    this._selection = this.sim.getSelected(world);
    this.infoPanel.visible = !!(this._selection && this._selection.data);
    this.controls.visible = this.sim.status === 'live';
    this.newsPanel.visible = this.sim.status === 'live';
    this.overviewControls.visible = this.sim.status === 'live';
    this._updateFollow(dt); // ease the camera to a selected ship (deadzone; cancelled by user pan)
    this._syncOverlay(now, world); // recompute the active overlay's stats/edges (throttled)

    this._emitWakes(now, world);
    this._detectWrecks(now, world);
    this._fireEventFx(now);      // combat bursts at authoritative event spots (on-screen, capped)
    this._stateFx(now, world);   // depart/arrive foam from observed sailing↔docked deltas
    this._pruneShipFx(now);      // expire the transient 'damaged' overlay
    this.shared.effects.update(now);
  }

  /** A ship present last frame but gone now foundered. Spawn a CLIENT sinking actor (a copy of the
   *  ship's primitive fields — never a snapshot reference) that renders the authored `sinking` art
   *  as she rolls under, and fire the `shipSinks` sequence (explosion + splash + smoke) at the spot.
   *  Falls back to the bare wreck splash when the sequence runner is absent (shots/headless). */
  _detectWrecks(now, world) {
    const cur = world && world.entities;
    const prev = this._lastShipPos;
    const seq = this.shared.sequences;
    if (prev && cur) {
      let n = 0;
      for (const id in prev) {
        if (!cur[id] && n < 4) { // cap so a reconnect can't trigger a splash storm
          const p = prev[id];
          const color = (this.sim.islandsById.get(p.homeId) || {}).color;
          this._sinkActors.push({
            x: p.x, y: p.y, heading: p.heading || 0, type: p.type,
            pirate: p.pirate, privateer: p.privateer, color, born: now, ttl: 1500, trans: {},
          });
          if (seq) seq.play('shipSinks', { x: p.x, y: p.y, angle: p.heading || 0 });
          else this.shared.effects.addGenericEffect(this.shared.VFX_DEFS.shipWreck, p.x, p.y, { scale: 34, now });
          n++;
        }
      }
    }
    const next = {};
    if (cur) for (const id in cur) {
      const s = cur[id];
      next[id] = { x: s.x, y: s.y, heading: s.heading, type: s.type, pirate: s.pirate, privateer: s.privateer, homeId: s.homeId };
    }
    this._lastShipPos = next;
  }

  /** Fire a combat/trade FX sequence at each NEW authoritative event (past the id high-water mark),
   *  on-screen only, ≤4/frame. Primed on the first live frame so a reconnect backlog doesn't erupt. */
  _fireEventFx(now) {
    const seq = this.shared.sequences;
    if (!seq) return;
    const events = this.sim.getEcon().events;
    if (!events || !events.length) return;
    if (this._fxSeen == null) { this._fxSeen = events[events.length - 1].id ?? 0; return; }
    const b = this.shared.camera.getVisibleBounds();
    const ents = this._world && this._world.entities;
    let maxId = this._fxSeen, fired = 0;
    for (const e of events) {
      const id = e.id ?? 0;
      if (id <= this._fxSeen) continue;
      if (id > maxId) maxId = id;
      if (fired >= 4) continue;                 // drop excess this frame, but still advance the mark
      const seqId = EVENT_FX[e.kind];
      if (!seqId) continue;
      const loc = this._eventLoc(e);
      if (!loc) continue;
      if (loc.x < b.left || loc.x > b.right || loc.y < b.top || loc.y > b.bottom) continue; // on-screen only
      const s = loc.shipId != null && ents && ents[loc.shipId];
      const angle = s ? (s.heading || 0) : 0;
      seq.play(seqId, { x: loc.x, y: loc.y, angle, shipId: loc.shipId });
      fired++;
    }
    this._fxSeen = maxId;
  }

  /** A snapshot-SAFE FX signal sink: a sequence's `signal` step lands here. It writes ONLY to the
   *  scene's client overlay maps and NEVER mutates opts.entity / the snapshot / the sim. */
  onFxSignal(name, data, opts) {
    if (name === 'markDamaged') {
      const id = opts && opts.shipId;
      if (id == null) return;
      const ttl = (data && data.ttl) || 1500;
      this._shipFx.set(id, this._lastNow + ttl); // self-healing: expires by time, no fragile clear step
    }
  }

  /** Depart/arrive foam from observed state deltas (sailing↔docked). Zoom-gated + on-screen + capped
   *  so a busy port doesn't erupt; purely cosmetic, reads live snapshot states only. */
  _stateFx(now, world) {
    const seq = this.shared.sequences;
    const cur = world && world.entities;
    if (!seq || !cur) { this._lastState = null; return; }
    const prev = this._lastState;
    const zoom = this.shared.camera.getZoom();
    if (prev && zoom >= 0.6) {
      const b = this.shared.camera.getVisibleBounds();
      let departs = 0, arrives = 0;
      for (const id in cur) {
        const s = cur[id];
        const was = prev[id];
        if (!was || was === s.state) continue;
        if (s.x < b.left || s.x > b.right || s.y < b.top || s.y > b.bottom) continue;
        if (s.state === 'sailing' && was !== 'sailing' && departs < 3) { seq.play('depart', { x: s.x, y: s.y, angle: s.heading || 0 }); departs++; }
        else if (s.state === 'docked' && was === 'sailing' && arrives < 3) { seq.play('arrive', { x: s.x, y: s.y }); arrives++; }
      }
    }
    const next = {};
    for (const id in cur) next[id] = cur[id].state;
    this._lastState = next;
  }

  /** Expire transient 'damaged' overlays whose ttl has passed. */
  _pruneShipFx(now) {
    if (!this._shipFx.size) return;
    for (const [id, until] of this._shipFx) if (until <= now) this._shipFx.delete(id);
  }

  _emitWakes(now, world) {
    this._wakeTick++;
    if (!world || !world.entities || this._wakeTick % WAKE_EVERY !== 0) return;
    if (this.shared.camera.getZoom() < WAKE_MIN_ZOOM) return; // ships are LOD dots out here — wakes would be invisible clutter
    const b = this.shared.camera.getVisibleBounds();
    for (const id in world.entities) {
      const s = world.entities[id];
      if (s.state !== 'sailing') continue;
      if (s.x < b.left || s.x > b.right || s.y < b.top || s.y > b.bottom) continue; // only visible
      this.shared.effects.emitTrail('wake:' + id, s.x, s.y, now, {}, this.shared.VFX_DEFS.shipWake);
    }
  }

  _panCamera(dt) {
    let dx = 0, dy = 0;
    for (const k of this.keys) { const v = PAN_KEYS[k]; if (v) { dx += v[0]; dy += v[1]; } }
    if (dx || dy) {
      this._followCancelled = true; // keyboard pan cancels ship-follow
      const len = Math.hypot(dx, dy) || 1;
      const zoom = this.shared.camera.getZoom();
      this.shared.camera.x += (dx / len) * PAN_SPEED * dt / zoom;
      this.shared.camera.y += (dy / len) * PAN_SPEED * dt / zoom;
      this._clampCamera();
    }
  }

  /** When a ship is selected (and the user hasn't panned away), ease the camera to keep it in a
   *  central deadzone — it can wander a box in the middle before the camera glides to catch up. */
  _updateFollow(dt) {
    const sel = this._selection;
    if (!sel || sel.kind !== 'ship' || this._followCancelled) return;
    const s = this._world && this._world.entities && this._world.entities[sel.id];
    if (!s) return;
    const cam = this.shared.camera;
    const zoom = cam.getZoom();
    const scr = cam.worldToScreen(s.x, s.y);
    const ex = scr.sx - this._view.width / 2, ey = scr.sy - this._view.height / 2;
    const dzX = this._view.width * 0.16, dzY = this._view.height * 0.16; // half-size of the no-pan box
    let tx = cam.x, ty = cam.y;
    if (Math.abs(ex) > dzX) tx = cam.x + (ex - Math.sign(ex) * dzX) / zoom;
    if (Math.abs(ey) > dzY) ty = cam.y + (ey - Math.sign(ey) * dzY) / zoom;
    const k = Math.min(1, dt * 6); // smooth exponential approach
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    this._clampCamera();
  }

  _clampCamera() {
    const cam = this.shared.camera;
    const m = 300;
    cam.x = Math.max(-m, Math.min(this.sim.mapW + m, cam.x));
    cam.y = Math.max(-m, Math.min(this.sim.mapH + m, cam.y));
  }

  /** Set the active SCALAR overlay layer ('off' hides it). Remembers the last real choice so the
   *  [Overlays] toolbar toggle / `o` hotkey can restore it. */
  _setOverlay(key) { this._overlayKey = key; if (key && key !== 'off') this._lastOverlayKey = key; }
  /** Set the active LINKS overlay layer ('off' hides it). Remembers the last real choice for the
   *  [Links] toolbar toggle / `l` hotkey. */
  _setLinks(key) { this._linkKey = key; if (key && key !== 'off') this._lastLinkKey = key; }

  /** Recompute both layers' derived data (scalar stats/leaderboard + links edges) — throttled
   *  inside the model. The heat discs, the edges, the legend, and the almanac all read the result.
   *  Skipped when both layers are off and the almanac is closed (nothing consumes it). */
  _syncOverlay(now, world) {
    if (this.sim.status !== 'live') return;
    const scalar = overlayByKey(this._overlayKey);
    const edges = overlayByKey(this._linkKey);
    const wantModel = scalar.kind === 'scalar' || edges.kind === 'edges' || (this.dashboard && this.dashboard.visible);
    if (!wantModel) return;
    const islands = this.sim.getEcon().islands;
    if (!islands || !islands.length) return;
    this._overlayModel.sync(islands, scalar, edges, world && world.entities, this.sim.islandsById, now);
  }

  // ─── input ───────────────────────────────────────────────────────
  onMousedown(sx, sy) {
    if (this.ui.onDown(sx, sy)) return; // UI consumes first
    const cam = this.shared.camera;
    this._press = { sx, sy, camX: cam.x, camY: cam.y, moved: false };
  }

  onMousemove(sx, sy) {
    this._cursor = { sx, sy };            // for the hover tooltip (recomputed each render)
    this.ui.onMove(sx, sy);
    if (!this._press) {
      if (this.shared.canvas) this.shared.canvas.style.cursor = (this.newsPanel.hitPointer(sx, sy) || this.overviewControls.hitPointer(sx, sy)) ? 'pointer' : 'default';
      return;
    }
    const dx = sx - this._press.sx, dy = sy - this._press.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) { this._press.moved = true; this._followCancelled = true; } // a drag-pan cancels ship-follow
    const zoom = this.shared.camera.getZoom();
    this.shared.camera.x = this._press.camX - dx / zoom;
    this.shared.camera.y = this._press.camY - dy / zoom;
    this._clampCamera();
  }

  onMouseup(sx, sy) {
    this.ui.onUp(sx, sy);
    // News clicks are handled by NewsPanel.onDown (via ui.onDown on mousedown); here a clean click
    // that the UI didn't consume is a world pick.
    if (this._press && !this._press.moved) this._pickAt(sx, sy);
    this._press = null;
  }

  onWheel(deltaY, sx, sy) {
    if (this.ui.onWheel(sx, sy, deltaY)) return; // a panel under the cursor scrolls instead of zooming
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.shared.camera.zoomAt(factor, sx, sy);
  }

  onKeydown(e) {
    const k = e.key;
    if (PAN_KEYS[k]) { this.keys.add(k); return; }
    if (k === ' ') { e.preventDefault(); this.sim.togglePause(); return; }
    // `o` toggles the scalar OVERLAY layer on/off (restoring the last-picked metric); pick which
    // metric in the Almanac (`m`).
    if (k === 'o' || k === 'O') { this._setOverlay(this._overlayKey === 'off' ? this._lastOverlayKey : 'off'); return; }
    // `l` toggles the relational LINKS layer on/off (restoring the last-picked link kind).
    if (k === 'l' || k === 'L') { this._setLinks(this._linkKey === 'off' ? this._lastLinkKey : 'off'); return; }
    // `h` toggles the news ticker between the compact crawl and the world-history browser.
    if (k === 'h' || k === 'H') { this.newsPanel.toggle(); return; }
    // `m` toggles the world almanac (aggregate stats + fly-to leaderboard).
    if (k === 'm' || k === 'M') { this.dashboard.toggle(); return; }
    // 1–5 select the speed presets (SPEEDS = [0.5, 1, 3, 10, 20]).
    const idx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 }[k];
    if (idx != null && SPEEDS[idx] != null) this.sim.setSpeed(SPEEDS[idx]);
  }

  onKeyup(e) { this.keys.delete(e.key); }

  /** Hit-test the world at a screen point → { kind:'island'|'ship', id } or null. SHIPS are tested
   *  first within a tight radius — a moored ship sits in a berth just off its island, so testing it
   *  before the (much larger) island is what makes a docked hull clickable at all; a click anywhere
   *  else on the island body still selects the port. Ship positions come from the renderer's berth
   *  map (shipDisplayPos) so the hit-test matches where each hull is actually drawn. The island hit
   *  radius scales with the drawn size so giant metropolises are as clickable as tiny outposts. */
  _pickTarget(sx, sy) {
    const { x, y } = this.shared.camera.screenToWorld(sx, sy);
    const wr = this.shared.worldRenderer;
    const ents = this._world && this._world.entities;
    if (ents) {
      let bs = null, bd = SHIP_HIT;
      for (const id in ents) {
        const p = wr.shipDisplayPos(id, ents[id]); // berth slot if docked, else live position
        const d = Math.hypot(x - p.x, y - p.y);
        if (d <= bd) { bd = d; bs = id; }
      }
      if (bs) return { kind: 'ship', id: bs };
    }

    const econIslands = this.sim.getEcon().islands;
    const islands = (econIslands && econIslands.length) ? econIslands : this.sim.islands;
    let bestIsl = null, bestD = Infinity;
    for (const isl of islands) {
      const hit = islandRadius(isl) + 8;
      const d = Math.hypot(x - isl.x, y - isl.y);
      if (d <= hit && d < bestD) { bestD = d; bestIsl = isl; }
    }
    if (bestIsl) return { kind: 'island', id: bestIsl.id };
    return null;
  }

  _pickAt(sx, sy) {
    const t = this._pickTarget(sx, sy);
    if (t) {
      this.sim.select(t.kind, t.id);
      if (t.kind === 'ship') this._followCancelled = false; // re-engage follow on a fresh ship pick
    } else {
      this.sim.select(null); // empty water clears the selection
    }
  }

  /** The selected entity's chronicle for the Story tab: deep DB history (fetched lazily + cached in
   *  this.history) merged with the live event tail, in narrative order (oldest→newest). */
  _chronicle(kind, id) {
    const page = this.history.ensure(kind, id, { limit: 100 });
    const live = this.sim.getHistory(kind, id);
    return {
      entries: mergeChronicle(page.entries, live, { ascending: true }),
      loading: page.loading,
      truncated: page.entries.length > 0 && !page.done, // earlier history exists beyond the first page
    };
  }

  // ─── render ──────────────────────────────────────────────────────
  render(now) {
    const { worldRenderer, effects, camera, ctx } = this.shared;
    const world = this._world;
    const live = this.sim.status === 'live' && world;

    if (live) {
      const bounds = camera.getVisibleBounds();
      const econ = this.sim.getEcon();
      // Selecting an island rings its own ships; selecting a ship rings its home island.
      const sel = this._selection;
      const highlightHome = (sel && sel.kind === 'island') ? sel.id : null;
      const highlightIsland = (sel && sel.kind === 'ship' && sel.data) ? sel.data.homeId : null;
      worldRenderer.beginFrame();
      this.shared.sea.draw(now, bounds, this.sim.wind, this.sim.season, this.sim.storms);
      worldRenderer.drawIslands(econ.islands, bounds, now, highlightIsland);
      // The two independent map layers (either/both/neither): heat tint under, relational edges over.
      const scalarSpec = overlayByKey(this._overlayKey);
      if (scalarSpec.kind === 'scalar') worldRenderer.drawOverlay(econ.islands, bounds, scalarSpec, this._overlayModel.stats, now);
      const linkSpec = overlayByKey(this._linkKey);
      if (linkSpec.kind === 'edges') worldRenderer.drawRelations(this._overlayModel.edges, bounds, linkSpec, now);
      if (camera.getZoom() >= WAKE_MIN_ZOOM) worldRenderer.drawWakes(effects.getTrails(), now); // skipped at overview (see _emitWakes)
      worldRenderer.drawStorms(this.sim.storms, bounds, now); // named tempests, under the ships
      worldRenderer.drawShips(world.entities, this.sim.islandsById, bounds, now, highlightHome, this._shipFx);
      // Client-owned foundering ships (rolled + fading) — cull the spent ones, then draw under the
      // sink splash/explosion (effects) so the burst reads on top of the going-down hull.
      if (this._sinkActors.length) {
        this._sinkActors = this._sinkActors.filter((a) => now - a.born < a.ttl);
        worldRenderer.drawSinkingActors(this._sinkActors, now);
      }
      worldRenderer.drawEffects(effects, now); // shipwreck splashes + debris
      if (this._selection) worldRenderer.drawSelection(this._selection, now);
      worldRenderer.endFrame();
      this._statusLine(ctx);
      this._windIndicator(ctx);
      this._overlayLegend(ctx); // active data-overlay key + gradient scale
      this._hoverTooltip(ctx, now); // drawn before the UI so a docked panel occludes it cleanly (incl. the news crawl)
    } else {
      this._overlay(ctx);
    }

    this.ui.draw(ctx);
  }

  /** The hover-tooltip's hit-test, memoised. Brute-force picking is O(N+S); running it on every
   *  frame even over empty water was the R4 render hotspot at scale. Recompute only when the cursor
   *  actually moved, or on a slow throttle (so a ship drifting under a parked cursor still refreshes
   *  the card). The click-path pick (`_pickAt`) stays uncached — a click always tests fresh. */
  _hoverPick(now) {
    const c = this._cursor;
    if (!c) return null;
    const lp = this._lastPickCursor;
    const moved = !lp || lp.sx !== c.sx || lp.sy !== c.sy;
    if (moved || this._hoverPickTime == null || (now - this._hoverPickTime) >= HOVER_PICK_MS) {
      this._hoverPickResult = this._pickTarget(c.sx, c.sy);
      this._lastPickCursor = { sx: c.sx, sy: c.sy };
      this._hoverPickTime = now;
    }
    return this._hoverPickResult;
  }

  /** A small quick-facts card that follows the cursor over an island or ship. Recomputed
   *  each frame from the last cursor position, so it tracks ships moving underneath it. */
  _hoverTooltip(ctx, now) {
    const c = this._cursor;
    if (!c || (this._press && this._press.moved)) return; // hidden while dragging the map
    const t = this._hoverPick(now);
    if (!t) return;
    const lines = t.kind === 'island' ? this._islandTip(t.id) : this._shipTip(t.id);
    if (!lines || !lines.length) return;

    // A ship's captain gets a little portrait tucked into the left of the card.
    let portrait = null;
    if (t.kind === 'ship' && this.shared.portraits) {
      const s = this._world && this._world.entities[t.id];
      if (s && s.captain && s.captain.portrait != null) portrait = s.captain.portrait;
    }

    ctx.save();
    const padX = 9, padY = 7, lh = 16, titleH = 2;
    const portSize = portrait != null ? 52 : 0;
    const portGap = portrait != null ? 10 : 0;
    const ICON_GUTTER = 15; // reserved column for a line's optional ink icon (a bullet glyph)
    ctx.font = tfont('small');
    let w = 0;
    for (const l of lines) {
      ctx.font = l.bold ? tfont('label') : tfont('small'); // IM Fell has no bold — title reads via the larger 'label' role
      w = Math.max(w, ctx.measureText(l.text).width + (l.icon ? ICON_GUTTER : 0));
    }
    const textH = lines.length * lh + titleH;
    const boxW = Math.ceil(w) + padX * 2 + portSize + portGap;
    const boxH = Math.max(textH, portSize) + padY * 2;
    let bx = c.sx + 16, by = c.sy + 16;
    if (bx + boxW > this._view.width - 4) bx = c.sx - boxW - 16;
    if (by + boxH > this._view.height - 4) by = c.sy - boxH - 16;
    bx = Math.max(4, bx); by = Math.max(4, by);

    roundRectPath(ctx, bx, by, boxW, boxH, 7);
    ctx.fillStyle = 'rgba(240, 232, 206, 0.96)'; // parchment card body
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = PALETTE.panelEdge;
    ctx.stroke();

    if (portrait != null) {
      const pxx = bx + padX, pyy = by + (boxH - portSize) / 2;
      ctx.save();
      roundRectPath(ctx, pxx, pyy, portSize, portSize, 8);
      ctx.fillStyle = '#e9dcbb'; ctx.fill(); ctx.clip();
      this.shared.portraits.draw(ctx, pxx + portSize / 2, pyy + portSize * 0.46, portSize * 0.34, portrait, 0);
      ctx.restore();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const textX = bx + padX + portSize + portGap;
    let ty = by + padY + Math.max(0, (portSize - textH) / 2);
    for (const l of lines) {
      const col = l.color || PALETTE.panelText;
      let tx = textX;
      if (l.icon) { drawIcon(ctx, l.icon, textX + 6, ty + lh / 2 - 1.5, 12, col); tx += ICON_GUTTER; }
      ctx.font = l.bold ? tfont('label') : tfont('small');
      ctx.fillStyle = col;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(l.text, tx, ty);
      ty += lh + (l.bold ? titleH : 0);
    }
    ctx.restore();
  }

  _islandTip(id) {
    const isl = (this.sim.getEcon().islands || []).find((i) => i.id === id);
    if (!isl) return null;
    const lines = [{ text: isl.name, bold: true }];
    const pct = Math.round((isl.population / Math.max(1, isl.k)) * 100);
    lines.push({ text: `${islandStateWord(isl)} · pop ${isl.population}/${isl.k} (${pct}%)`, color: 'rgba(90, 74, 44, 0.9)' });
    lines.push({ text: `Civ ${Math.round((isl.civ || 0) * 100)}% · ${(isl.produces || []).slice(0, 3).join(', ')}` });
    if (isl.haven) {
      lines.push({ text: `PIRATE HAVEN · grip ${Math.round((isl.haven.strength || 0) * 100)}%`, color: '#c0392b', icon: 'skull' });
    } else if (isl.magistrate) {
      lines.push(isl.rebellion
        ? { text: 'IN REBELLION', color: '#b0342a', icon: 'flame' }
        : { text: `Loyalty ${Math.round((isl.loyalty != null ? isl.loyalty : 1) * 100)}% · ${isl.magistrate.name}`, color: moraleColor(isl.loyalty != null ? isl.loyalty : 1) });
      const amb = isl.magistrate.ambition;
      if (amb && amb.label) lines.push({ text: `${amb.label} agenda · ${Math.round((amb.progress || 0) * 100)}%`, color: '#97781a', icon: 'pennant' });
    }
    if (isl.blight) lines.push({ text: `Blight: ${isl.blight}`, color: eventColor('blight'), icon: 'wheat' });
    if (isl.plague) lines.push({ text: 'Plague outbreak', color: eventColor('plague'), icon: 'skull' });
    if (isl.danger > 0.25) lines.push({ text: `Pirate danger ${Math.round(isl.danger * 100)}%`, color: '#c0392b', icon: 'pennant' });
    if (isl.lawlessness > 0.35) lines.push({ text: `Lawless ${Math.round(isl.lawlessness * 100)}%`, color: '#c0392b', icon: 'sabres' });
    if (isl.contract) lines.push({ text: `Wants ${isl.contract.good} · ${isl.contract.reward}g`, color: '#97781a', icon: 'scroll' });
    // The active data-overlay's value for this port + how it ranks against the archipelago.
    const ov = overlayByKey(this._overlayKey);
    if (ov.kind === 'scalar' && this._overlayModel.stats && this._overlayModel.stats.count) {
      const raw = ov.accessor(isl);
      if (raw != null && Number.isFinite(raw)) {
        const lb = this._overlayModel.stats.leaderboard;
        const rank = lb && lb.rankById.get(isl.id);
        const suffix = rank ? ` · ${rank}/${lb.count}` : '';
        lines.push({ text: `${ov.label}: ${fmtValue(ov, isl)}${suffix}`, color: PALETTE.accent, icon: ov.icon });
      }
    }
    return lines;
  }

  _shipTip(id) {
    const s = this._world && this._world.entities[id];
    if (!s) return null;
    const home = this.sim.islandsById.get(s.homeId);
    const dest = s.destId != null ? this.sim.islandsById.get(s.destId) : null;
    const cap = s.captain;
    const lines = [{ text: s.name || (cap ? `Capt. ${cap.name}` : (home ? `${home.name} ship` : 'Merchant ship')), bold: true }];
    if (cap) lines.push({ text: `Capt. ${cap.name} · ${cap.rank} · ${s.pirate ? 'rogue' : (home ? home.name : '—')}`, color: 'rgba(90, 74, 44, 0.9)' });
    if (s.pirate) {
      lines.push({ text: 'BLACK FLAG — PIRATE', color: '#b23a2e', bold: true, icon: 'skull' });
      if (s.bounty > 0) lines.push({ text: `Bounty ${s.bounty}g on this head`, color: '#9a7d16' });
    } else if (s.privateer) {
      lines.push({ text: 'PRIVATEER — pirate-hunter', color: '#3a6ea5', bold: true, icon: 'sabres' });
    } else lines.push({ text: REASON_LABEL[s.reason] || 'Idle', color: '#5f47a0' });
    if (dest && s.state === 'sailing') lines.push({ text: `→ ${dest.name}  (~${s.eta}s)` });
    const rel = s.state === 'sailing' ? windRelation(s.heading, this.sim.wind) : null;
    lines.push({
      text: `Cargo ${s.used}/${s.cap} · ${s.gold}g coin${rel ? '  ·  ' + rel.label : ''}`,
      color: rel ? rel.color : undefined,
    });
    if (s.cargo && s.cargo.People > 0) lines.push({ text: `${s.cargo.People} settlers aboard`, color: '#a83f6e', icon: 'anchor' });
    if (s.morale != null) {
      lines.push(s.revolt
        ? { text: 'CREW IN REVOLT', color: '#b23a2e', icon: 'sabres' }
        : { text: `Morale ${Math.round(s.morale * 100)}% · ${(s.foodDays || 0).toFixed(1)}d food`, color: moraleColor(s.morale) });
    }
    if (s.sick) lines.push({ text: 'Infected', color: eventColor('plague'), icon: 'skull' });
    return lines;
  }

  /** What an event refers to: a live ship (→ select + follow), an island (→ open its panel),
   *  or just a spot at sea (a wreck — the ship is gone, so pan there). null if unresolvable. */
  _eventLoc(e) {
    if (e.shipId != null) {
      const s = this._world && this._world.entities && this._world.entities[e.shipId];
      if (s) return { x: s.x, y: s.y, shipId: e.shipId };
    }
    if (e.islandId) { const isl = this.sim.islandsById.get(e.islandId); if (isl) return { x: isl.x, y: isl.y, islandId: e.islandId }; }
    if (e.x != null && e.y != null) return { x: e.x, y: e.y };
    return null;
  }

  /** Jump the camera to a clicked news item and select what it's about: a ship (which the
   *  camera then follows) or an island (opens its panel). A wreck just pans to the spot. */
  _focusEvent(e) {
    const loc = this._eventLoc(e);
    if (!loc) return;
    const cam = this.shared.camera;
    cam.x = loc.x; cam.y = loc.y;
    if (cam.getZoom() < 0.55) cam.setZoom(0.55);
    this._clampCamera();
    if (loc.shipId != null) {
      this.sim.focusSelect('ship', loc.shipId);
      this._followCancelled = false;              // follow the ship it named
    } else if (loc.islandId) {
      this.sim.focusSelect('island', loc.islandId);
      this._followCancelled = true;
    } else {
      this._followCancelled = true;               // an at-sea wreck — just pan to it
    }
  }

  /** Fly the camera to an island (from an almanac leaderboard click) and open its panel. Mirrors
   *  _focusEvent's camera-snap + force-select; guards a vanished id. */
  _focusIsland(id) {
    const isl = this.sim.islandsById.get(id);
    if (!isl) return;
    const cam = this.shared.camera;
    cam.x = isl.x; cam.y = isl.y;
    if (cam.getZoom() < 0.7) cam.setZoom(0.7);
    this._clampCamera();
    this.sim.focusSelect('island', id);
    this._followCancelled = true; // don't chase a port
  }

  _statusLine(ctx) {
    const econ = this.sim.getEcon();
    const ships = this._world && this._world.entities ? Object.keys(this._world.entities).length : (econ.economy.shipCount || 0);
    const title = `BOATZ   ${this.sim.islands.length} islands · ${ships} ships · ${fmtGold(econ.economy.totalGold)} gold`;
    const hint = 'click: inspect · drag/WASD: pan · scroll: zoom · space: pause · 1–5: speed · o: data · l: links · m: almanac';
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = tfont('heading'); const w1 = ctx.measureText(title).width;
    ctx.font = tfont('small');   const w2 = ctx.measureText(hint).width;
    // Framed in the chart-frame plate (light text) — legible over the deeper painted sea.
    plate(ctx, 10, 10, Math.max(w1, w2) + 24, 46, { radius: 8 });
    ctx.fillStyle = PALETTE.panelText; ctx.font = tfont('heading');
    ctx.fillText(title, 22, 17);
    ctx.fillStyle = PALETTE.panelDim; ctx.font = tfont('small');
    ctx.fillText(hint, 22, 39);
    ctx.restore();
  }

  /** Top-centre wind compass: a dial with an arrow the way the wind blows, sized/coloured by
   *  strength, plus a plain-language label. Mirrors the field of streaks drifting on the sea. */
  _windIndicator(ctx) {
    const w = this.sim.wind;
    if (!w) return;
    const dx = Math.cos(w.dir), dy = Math.sin(w.dir);
    const col = windColor(w.str);
    const label = `${windWord(w.str)} wind → ${compass8(w.dir)}`;
    const s = this.sim.season;
    const R = 15;
    ctx.save();
    // Measure the text column to size the framed pill.
    ctx.font = tfont('small'); const lw = ctx.measureText(label).width;
    const sw = s ? 16 + ctx.measureText(s.name).width : 0;
    const textCol = Math.max(lw, sw);
    const bw = 12 + 2 * R + 12 + textCol + 14, bh = 44;
    const bx = Math.round(this._view.width / 2 - bw / 2), by = 8;
    plate(ctx, bx, by, bw, bh, { radius: 8 });
    const cx = bx + 12 + R, cy = by + bh / 2;
    // Compass dial.
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = PALETTE.panelEdge; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = PALETTE.panelDim; ctx.font = '9px ' + 'system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - R - 4);
    // Arrow along the wind (points the way it blows), round-capped + tapered.
    const tipX = cx + dx * R * 0.72, tipY = cy + dy * R * 0.72;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - dx * R * 0.72, cy - dy * R * 0.72); ctx.lineTo(tipX, tipY); ctx.stroke();
    const ah = 5, pa = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(pa - 0.5) * ah, tipY - Math.sin(pa - 0.5) * ah);
    ctx.lineTo(tipX - Math.cos(pa + 0.5) * ah, tipY - Math.sin(pa + 0.5) * ah);
    ctx.closePath(); ctx.fill();
    // Label to the right of the dial; the season sits just beneath, with its ink icon.
    const tx = cx + R + 12;
    ctx.fillStyle = PALETTE.panelText; ctx.font = tfont('small');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, tx, s ? cy - 7 : cy);
    if (s) {
      drawIcon(ctx, seasonIcon(s.name), tx + 6, cy + 9, 12, PALETTE.panelDim);
      ctx.fillStyle = PALETTE.panelDim; ctx.fillText(s.name, tx + 16, cy + 9);
    }
    ctx.restore();
  }

  /** On-map legend(s) for the active data layers (below the overview toolbar): one card per active
   *  layer — the scalar overlay's heat scale and/or the links overlay's swatch key, stacked. Hidden
   *  when the Almanac is open (it carries the full legend + distribution) or both layers are off. */
  _overlayLegend(ctx) {
    if (this.dashboard && this.dashboard.visible) return; // the Almanac carries discovery when open
    const cards = [];
    const scalar = overlayByKey(this._overlayKey);
    const links = overlayByKey(this._linkKey);
    if (scalar.kind === 'scalar') cards.push(scalar);
    if (links.kind === 'edges') cards.push(links);
    if (!cards.length) return; // the toolbar buttons are the only affordance when nothing's on
    let y = 94; // first card sits just under the overview toolbar (y 62–88)
    for (const spec of cards) y = this._drawLegendCard(ctx, spec, y) + 8;
  }

  /** Draw one layer's legend card at `y`; returns its bottom edge (for stacking). */
  _drawLegendCard(ctx, spec, y) {
    const x = 12;
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const stats = this._overlayModel.stats;
    const scalar = spec.kind === 'scalar' && stats && stats.count;
    const edgeRows = spec.kind === 'edges' ? (spec.edgeKinds ? spec.edgeKinds.length : 1) : 0;
    // Framed legend: metric glyph + label, then either the heat ramp (scalar) or a swatch key (edges).
    const bw = 214, bh = scalar ? 56 : (edgeRows ? 24 + edgeRows * 15 : 40);
    plate(ctx, x, y, bw, bh, { radius: 8 });
    const ix = x + 12, iy = y + 9;
    drawIcon(ctx, spec.icon || 'hatch', ix + 6, iy + 6, 12, PALETTE.panelText);
    ctx.fillStyle = PALETTE.panelText; ctx.font = tfont('label');
    ctx.fillText(spec.label, ix + 18, iy);
    if (scalar) {
      // "typical" (median) on the right of the header — the one number to read at a glance.
      ctx.fillStyle = PALETTE.accent; ctx.font = tfont('numSmall');
      ctx.textAlign = 'right'; ctx.fillText('~' + spec.vfmt(stats.p50), x + bw - 12, iy + 1); ctx.textAlign = 'left';
      // Heat scale coloured exactly as the map paints it (low raw = left; colour shows good/bad).
      const bx = ix, by = y + 28, sw = bw - 24, sh = 9, slices = 26;
      for (let i = 0; i < slices; i++) {
        const frac = i / (slices - 1);
        ctx.fillStyle = heatColor(spec.good ? frac : 1 - frac, 1);
        ctx.fillRect(bx + (i / slices) * sw, by, sw / slices + 1, sh);
      }
      ctx.strokeStyle = PALETTE.panelInk; ctx.lineWidth = 1; ctx.strokeRect(bx, by, sw, sh);
      // Median tick, positioned by the median's place in the [lo,hi] domain.
      const mt = stats.hi > stats.lo ? (stats.p50 - stats.lo) / (stats.hi - stats.lo) : 0.5;
      const mx = bx + Math.max(0, Math.min(1, mt)) * sw;
      ctx.strokeStyle = '#2a2012'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, by - 2); ctx.lineTo(mx, by + sh + 2); ctx.stroke();
      // The live numeric endpoints (auto-ranged), replacing the old adjective-only scale.
      ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim;
      ctx.textAlign = 'left'; ctx.fillText(spec.vfmt(stats.lo), bx, by + sh + 3);
      ctx.textAlign = 'right'; ctx.fillText(spec.vfmt(stats.hi), bx + sw, by + sh + 3);
    } else if (spec.kind === 'edges') {
      // Swatch key: a coloured line stub + label per relation kind (mirrors drawRelations colours).
      const EK = { ally: ['#8ee6a0', 'ally'], rival: ['#ff7b6b', 'rival'], lane: ['#6fd0e0', 'busier lane → brighter'], aid: ['#7fe0b0', 'relief convoy'], embargo: ['#e0863a', 'embargo (trade cut)'], hunt: ['#ff5b4a', 'pirate hunt'], guard: ['#6fa8d8', 'privateer patrol'] };
      let ly = y + 26;
      ctx.lineCap = 'round';
      for (const ek of (spec.edgeKinds || [])) {
        const sw = EK[ek] || ['#8fc6d4', ek];
        ctx.strokeStyle = sw[0]; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(ix + 4, ly + 6); ctx.lineTo(ix + 30, ly + 6); ctx.stroke();
        ctx.fillStyle = PALETTE.panelDim; ctx.font = tfont('numSmall');
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(sw[1], ix + 38, ly + 6);
        ly += 15;
      }
      ctx.textBaseline = 'top';
    } else {
      // Scalar layer on, stats not computed yet — just the labelled frame (fills in next sync).
      ctx.fillStyle = PALETTE.panelDim; ctx.font = tfont('numSmall');
      ctx.textAlign = 'right'; ctx.fillText('…', x + bw - 12, iy + 1); ctx.textAlign = 'left';
    }
    ctx.restore();
    return y + bh;
  }

  _overlay(ctx) {
    const v = this._view;
    ctx.save();
    ctx.fillStyle = PALETTE.hud;
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = this.sim.status === 'disconnected'
      ? 'Lost the server — reconnecting…'
      : 'Charting the seas…';
    ctx.fillText(msg, v.width / 2, v.height / 2);
    ctx.restore();
  }

  _layout() {
    const c = this.shared.canvas;
    this._view = { width: c.clientWidth || c.width, height: c.clientHeight || c.height };
    this.ui.layout(this._view);
  }
}

function fmtGold(n) { return Math.round(n || 0).toLocaleString('en-US'); }
