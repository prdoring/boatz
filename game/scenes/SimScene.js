// The map scene: renders the interpolated world from shared.sim, routes input
// (drag/keys pan, wheel zoom, click select, space pause), and hosts the UI stack
// (InfoPanel + SimControls). It owns only transient scene state — held pan keys, the
// drag press, the wake-throttle counter, the UI stack. All world truth lives in
// shared.sim; the scene never simulates and never touches the socket directly.

import { Scene } from '/engine/core/Scene.js';
import { UIStack } from '../ui/UIStack.js';
import { InfoPanel } from '../ui/InfoPanel.js';
import { SimControls } from '../ui/SimControls.js';
import { islandRadius } from '../WorldRenderer.js';
import { SPEEDS } from '../protocol.js';
import {
  PALETTE, OCEAN, SHIP_HIT, ZOOM_STEP, PAN_SPEED, WAKE_EVERY,
} from '../config.js';

const PAN_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1],
};

const EVENT_COLOR = {
  blight: '#ec8a3a', plague: '#c072e0', wreck: '#8fb6c6', recover: '#8ee6a0',
  mutiny: '#ff5b4a', defect: '#e0863a', quell: '#8ee6a0', unrest: '#e0b24a', starve: '#c0503a',
  launch: '#6fd0e0', migrate: '#f2b8d0', famine: '#d98a3a', boom: '#ffd166', ally: '#8ee6a0', rival: '#e0863a',
  rebellion: '#ff5b30', overthrow: '#ff7b4a', quellReb: '#8ee6a0',
  pirate: '#ff5b4a', plunder: '#e0503a', fended: '#8ee6a0', raid: '#ff7b4a', raidfail: '#8ee6a0',
};
const NEWS_ROWS = 9; // how many recent events the ticker shows

// Short human labels for a ship's voyage purpose (the hover tooltip / quick glance).
const REASON_LABEL = {
  food: 'Fetching food', migrate: 'Carrying migrants', buyShip: 'Buying a ship',
  trade: 'Trading', scout: 'Scouting prices',
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
    this._press = null;       // drag-to-pan state
    this._world = null;       // latest interpolated snapshot (this frame)
    this._selection = null;
    this._followCancelled = false; // true once the user pans away from a followed ship
    this._newsRows = [];      // clickable ticker row rects (rebuilt each render)
    this._view = { width: 0, height: 0 };

    this.ui = new UIStack();
    this.infoPanel = new InfoPanel({
      getSelection: () => this._selection,
      getContext: () => ({
        goods: this.sim.goods, raw: this.sim.raw,
        islandsById: this.sim.islandsById,
        shipsById: this._world ? this._world.entities : null,
        wind: this.sim.wind,
        portraits: this.shared.portraits,
        getHistory: (kind, id) => this.sim.getHistory(kind, id),
      }),
    });
    this.controls = new SimControls({
      onSetSpeed: (s) => this.sim.setSpeed(s),
      onTogglePause: () => this.sim.togglePause(),
      getClock: () => this.sim.getClock(),
      speeds: SPEEDS,
    });
    this.ui.add(this.infoPanel);
    this.ui.add(this.controls);
  }

  enter() {
    this.keys.clear();
    const { camera, canvas } = this.shared;
    camera.x = OCEAN.width / 2;
    camera.y = OCEAN.height / 2;
    // Fit the whole archipelago on entry (works for any ocean/viewport size).
    const vw = canvas.clientWidth || canvas.width || 1280;
    const vh = canvas.clientHeight || canvas.height || 720;
    camera.setZoom(Math.min(vw / OCEAN.width, vh / OCEAN.height) * 0.92);
    this.sim.connect();
    this._layout();
  }

  exit() {
    // shared.sim is a cross-scene service — do NOT close the socket here. Just drop
    // this scene's transient visual state so wakes/effects don't leak on re-entry.
    this.shared.effects.stopAll();
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
    this._selection = this.sim.getSelected(world);
    this.infoPanel.visible = !!(this._selection && this._selection.data);
    this.controls.visible = this.sim.status === 'live';
    this._updateFollow(dt); // ease the camera to a selected ship (deadzone; cancelled by user pan)

    this._emitWakes(now, world);
    this._detectWrecks(now, world);
    this.shared.effects.update(now);
  }

  /** A ship that was present last frame but is gone now foundered — splash where it sank. */
  _detectWrecks(now, world) {
    const cur = world && world.entities;
    const prev = this._lastShipPos;
    if (prev && cur) {
      let n = 0;
      for (const id in prev) {
        if (!cur[id] && n < 4) { // cap so a reconnect can't trigger a splash storm
          const p = prev[id];
          this.shared.effects.addGenericEffect(this.shared.VFX_DEFS.shipWreck, p.x, p.y, { scale: 34, now });
          n++;
        }
      }
    }
    const next = {};
    if (cur) for (const id in cur) next[id] = { x: cur[id].x, y: cur[id].y };
    this._lastShipPos = next;
  }

  _emitWakes(now, world) {
    this._wakeTick++;
    if (!world || !world.entities || this._wakeTick % WAKE_EVERY !== 0) return;
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
      if (this.shared.canvas) this.shared.canvas.style.cursor = this._newsHit(sx, sy) ? 'pointer' : 'default';
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
    if (this._press && !this._press.moved) {
      const e = this._newsHit(sx, sy);
      if (e) this._focusEvent(e);   // click a news item → snap the view to it
      else this._pickAt(sx, sy);    // otherwise a normal select
    }
    this._press = null;
  }

  onWheel(deltaY, sx, sy) {
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.shared.camera.zoomAt(factor, sx, sy);
  }

  onKeydown(e) {
    const k = e.key;
    if (PAN_KEYS[k]) { this.keys.add(k); return; }
    if (k === ' ') { e.preventDefault(); this.sim.togglePause(); return; }
    // 1/2/3 select the speed presets (SPEEDS = [1,3,10]).
    const idx = { '1': 0, '2': 1, '3': 2 }[k];
    if (idx != null && SPEEDS[idx] != null) this.sim.setSpeed(SPEEDS[idx]);
  }

  onKeyup(e) { this.keys.delete(e.key); }

  /** Hit-test the world at a screen point → { kind:'island'|'ship', id } or null. Islands
   *  win over ships (bigger, foreground intent); the island hit radius scales with the drawn
   *  size so the giant metropolises are as clickable at their edges as the tiny outposts. */
  _pickTarget(sx, sy) {
    const { x, y } = this.shared.camera.screenToWorld(sx, sy);
    const econIslands = this.sim.getEcon().islands;
    const islands = (econIslands && econIslands.length) ? econIslands : this.sim.islands;
    let bestIsl = null, bestD = Infinity;
    for (const isl of islands) {
      const hit = islandRadius(isl) + 8;
      const d = Math.hypot(x - isl.x, y - isl.y);
      if (d <= hit && d < bestD) { bestD = d; bestIsl = isl; }
    }
    if (bestIsl) return { kind: 'island', id: bestIsl.id };

    const ents = this._world && this._world.entities;
    if (ents) {
      let bs = null, bd = SHIP_HIT;
      for (const id in ents) {
        const d = Math.hypot(x - ents[id].x, y - ents[id].y);
        if (d <= bd) { bd = d; bs = id; }
      }
      if (bs) return { kind: 'ship', id: bs };
    }
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
      worldRenderer.drawIslands(econ.islands, bounds, now, highlightIsland);
      worldRenderer.drawWakes(effects.getTrails(), now);
      worldRenderer.drawShips(world.entities, this.sim.islandsById, bounds, now, highlightHome);
      worldRenderer.drawEffects(effects, now); // shipwreck splashes + debris
      if (this._selection) worldRenderer.drawSelection(this._selection, now);
      worldRenderer.endFrame();
      this._statusLine(ctx);
      this._windIndicator(ctx);
      this._newsFeed(ctx);
      this._hoverTooltip(ctx); // drawn before the UI so a docked panel occludes it cleanly
    } else {
      this._overlay(ctx);
    }

    this.ui.draw(ctx);
  }

  /** A small quick-facts card that follows the cursor over an island or ship. Recomputed
   *  each frame from the last cursor position, so it tracks ships moving underneath it. */
  _hoverTooltip(ctx) {
    const c = this._cursor;
    if (!c || (this._press && this._press.moved)) return; // hidden while dragging the map
    const t = this._pickTarget(c.sx, c.sy);
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
    ctx.font = '12px system-ui, sans-serif';
    let w = 0;
    for (const l of lines) {
      ctx.font = (l.bold ? 'bold ' : '') + '12px system-ui, sans-serif';
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    const textH = lines.length * lh + titleH;
    const boxW = Math.ceil(w) + padX * 2 + portSize + portGap;
    const boxH = Math.max(textH, portSize) + padY * 2;
    let bx = c.sx + 16, by = c.sy + 16;
    if (bx + boxW > this._view.width - 4) bx = c.sx - boxW - 16;
    if (by + boxH > this._view.height - 4) by = c.sy - boxH - 16;
    bx = Math.max(4, bx); by = Math.max(4, by);

    roundRectPath(ctx, bx, by, boxW, boxH, 7);
    ctx.fillStyle = 'rgba(14, 26, 34, 0.94)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150, 200, 220, 0.28)';
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
      ctx.font = (l.bold ? 'bold ' : '') + '12px system-ui, sans-serif';
      ctx.fillStyle = l.color || 'rgba(228, 240, 246, 0.92)';
      ctx.fillText(l.text, textX, ty);
      ty += lh + (l.bold ? titleH : 0);
    }
    ctx.restore();
  }

  _islandTip(id) {
    const isl = (this.sim.getEcon().islands || []).find((i) => i.id === id);
    if (!isl) return null;
    const lines = [{ text: isl.name, bold: true }];
    const pct = Math.round((isl.population / Math.max(1, isl.k)) * 100);
    lines.push({ text: `${islandStateWord(isl)} · pop ${isl.population}/${isl.k} (${pct}%)`, color: 'rgba(190, 210, 220, 0.85)' });
    lines.push({ text: `Civ ${Math.round((isl.civ || 0) * 100)}% · ${(isl.produces || []).slice(0, 3).join(', ')}` });
    if (isl.magistrate) {
      lines.push(isl.rebellion
        ? { text: '🔥 IN REBELLION', color: '#ff5b30' }
        : { text: `Loyalty ${Math.round((isl.loyalty != null ? isl.loyalty : 1) * 100)}% · ${isl.magistrate.name}`, color: moraleColor(isl.loyalty != null ? isl.loyalty : 1) });
    }
    if (isl.blight) lines.push({ text: `⚠ Blight: ${isl.blight}`, color: EVENT_COLOR.blight });
    if (isl.plague) lines.push({ text: '☠ Plague outbreak', color: EVENT_COLOR.plague });
    return lines;
  }

  _shipTip(id) {
    const s = this._world && this._world.entities[id];
    if (!s) return null;
    const home = this.sim.islandsById.get(s.homeId);
    const dest = s.destId != null ? this.sim.islandsById.get(s.destId) : null;
    const cap = s.captain;
    const lines = [{ text: s.name || (cap ? `Capt. ${cap.name}` : (home ? `${home.name} ship` : 'Merchant ship')), bold: true }];
    if (cap) lines.push({ text: `Capt. ${cap.name} · ${cap.rank} · ${s.pirate ? 'rogue' : (home ? home.name : '—')}`, color: 'rgba(190, 210, 220, 0.85)' });
    if (s.pirate) lines.push({ text: '☠ BLACK FLAG — PIRATE', color: '#ff5b4a', bold: true });
    else lines.push({ text: REASON_LABEL[s.reason] || 'Idle', color: '#c8b3ff' });
    if (dest && s.state === 'sailing') lines.push({ text: `→ ${dest.name}  (~${s.eta}s)` });
    const rel = s.state === 'sailing' ? windRelation(s.heading, this.sim.wind) : null;
    lines.push({
      text: `Cargo ${s.used}/${s.cap} · ${s.gold}g coin${rel ? '  ·  ' + rel.label : ''}`,
      color: rel ? rel.color : undefined,
    });
    if (s.cargo && s.cargo.People > 0) lines.push({ text: `⚓ ${s.cargo.People} settlers aboard`, color: '#f2b8d0' });
    if (s.morale != null) {
      lines.push(s.revolt
        ? { text: '⚔ CREW IN REVOLT', color: '#ff5b4a' }
        : { text: `Morale ${Math.round(s.morale * 100)}% · ${(s.foodDays || 0).toFixed(1)}d food`, color: moraleColor(s.morale) });
    }
    if (s.sick) lines.push({ text: '☠ Infected', color: EVENT_COLOR.plague });
    return lines;
  }

  _newsFeed(ctx) {
    const events = this.sim.getEcon().events || [];
    this._newsRows = [];
    if (!events.length) return;
    const recent = events.slice(-NEWS_ROWS);
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const x = 16, lh = 18;
    let y = this._view.height - 30; // vertical centre of the newest (bottom) row
    const cur = this._cursor;
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      const loc = this._eventLoc(e);
      const label = `Day ${e.day}  ·  ${e.text}`;
      const dot = loc ? 11 : 0;
      const w = Math.min(this._view.width - 30, ctx.measureText(label).width + dot + 12);
      const rx = x - 6, ry = y - lh / 2;
      const hovered = loc && cur && cur.sx >= rx && cur.sx <= rx + w && cur.sy >= ry && cur.sy <= ry + lh;
      const col = EVENT_COLOR[e.kind] || PALETTE.hudDim;
      if (hovered) { roundRectPath(ctx, rx, ry, w, lh, 5); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill(); }
      ctx.globalAlpha = hovered ? 1 : Math.max(0.42, 1 - (recent.length - 1 - i) * 0.07);
      if (loc) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); } // clickable locator
      ctx.fillStyle = hovered ? '#ffffff' : col;
      ctx.fillText(label, x + dot, y);
      ctx.globalAlpha = 1;
      if (loc) this._newsRows.push({ x: rx, y: ry, w, h: lh, e });
      y -= lh;
    }
    ctx.restore();
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

  _newsHit(sx, sy) {
    const rows = this._newsRows;
    if (!rows) return null;
    for (const r of rows) if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r.e;
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

  _statusLine(ctx) {
    const econ = this.sim.getEcon();
    const ships = this._world && this._world.entities ? Object.keys(this._world.entities).length : (econ.economy.shipCount || 0);
    ctx.save();
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = PALETTE.hud;
    ctx.fillText(`BOATZ   ${this.sim.islands.length} islands · ${ships} ships · ${fmtGold(econ.economy.totalGold)} gold`, 14, 12);
    ctx.fillStyle = PALETTE.hudDim;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('click island/ship: inspect   ·   drag or WASD: pan   ·   scroll: zoom   ·   space: pause', 14, 33);
    ctx.restore();
  }

  /** Top-centre wind compass: a dial with an arrow the way the wind blows, sized/coloured by
   *  strength, plus a plain-language label. Mirrors the field of streaks drifting on the sea. */
  _windIndicator(ctx) {
    const w = this.sim.wind;
    if (!w) return;
    const cx = Math.round(this._view.width / 2), cy = 30, R = 16;
    const dx = Math.cos(w.dir), dy = Math.sin(w.dir);
    const col = windColor(w.str);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(8, 49, 59, 0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = PALETTE.hudDim; ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - R - 5);
    // Arrow along the wind (points the way it blows).
    const tipX = cx + dx * R * 0.72, tipY = cy + dy * R * 0.72;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - dx * R * 0.72, cy - dy * R * 0.72); ctx.lineTo(tipX, tipY); ctx.stroke();
    const ah = 5, pa = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(pa - 0.5) * ah, tipY - Math.sin(pa - 0.5) * ah);
    ctx.lineTo(tipX - Math.cos(pa + 0.5) * ah, tipY - Math.sin(pa + 0.5) * ah);
    ctx.closePath(); ctx.fill();
    // Label to the right of the dial.
    ctx.fillStyle = PALETTE.hud; ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${windWord(w.str)} wind → ${compass8(w.dir)}`, cx + R + 9, cy);
    ctx.restore();
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
