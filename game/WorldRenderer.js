// Draws the sim world. Ships + wakes + the selection ring go through the engine's
// declarative art/VFX interpreters (ship-art.json). ISLANDS are drawn PROCEDURALLY and
// data-drivenly — a static art asset can't react to live sim state, and the design goal
// is that an island SHOWS what it is: a seed-unique silhouette (no two alike), a size
// that grows with POPULATION, a town whose building count grows with CIVILISATION, and
// glyphs for the raw MATERIALS it mines/grows and the GOODS it manufactures.
//
// Per-entity art-transition state (ships) lives in a renderer-owned Map<id, transition>
// pruned each frame — never on the interpolated snapshot objects (Footgun #2). Per-island
// procedural layout (silhouette, town/marker spots) is cached once per id (stable, seeded).
// Everything culls by camera.getVisibleBounds() so hundreds of islands cost only what's
// on-screen.

import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';
import { PALETTE, ISLAND_RADIUS, SHIP_RADIUS } from './config.js';

// A pirate's sail is dyed a menacing dark crimson-black (vs a merchant's home-port colour),
// so a raider reads as hostile at a glance even before the skull marker is noticed. A privateer
// flies naval steel-blue — the law's answer, distinct from both merchant and pirate.
const PIRATE_HULL = '#7a1420';
const PRIVATEER_HULL = '#2f4b6e';

// Hull class reads at a glance from size: a nimble sloop is small, a brig standard, a galleon big.
const SHIP_TYPE_SCALE = { sloop: 0.82, brig: 1.0, galleon: 1.32 };

export class WorldRenderer {
  constructor(ctx, camera, art, vfx, effectsRenderer) {
    this.ctx = ctx;
    this.camera = camera;
    this.art = art;                  // { ships:{...} } (islands are procedural)
    this.vfx = vfx;                  // VFX_DEFS
    this.effectsRenderer = effectsRenderer; // wraps the engine VFX interpreter
    this._transitions = new Map();   // ship id -> per-entity transition (keyframe clock + blend)
    this._islands = new Map();       // island id -> cached procedural layout (seeded)
    this._seen = new Set();
    this._warned = new Set();
  }

  beginFrame() { this._seen.clear(); }

  endFrame() {
    for (const id of this._transitions.keys()) {
      if (!this._seen.has(id)) this._transitions.delete(id);
    }
  }

  // ─── Islands (procedural, data-driven) ───────────────────────────
  drawIslands(islands, bounds, now, highlightIslandId = null) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const ctx = this.ctx;
    for (const isl of islands) {
      const rad = islandRadius(isl);
      if (!inBounds(isl.x, isl.y, rad * 1.5, bounds)) continue;
      this._seen.add('i:' + isl.id);
      const L = this._layout(isl.id, isl.type);
      const { sx, sy } = this.camera.worldToScreen(isl.x, isl.y);
      const R = rad * zoom;

      // Shallows halo.
      ctx.save();
      ctx.fillStyle = 'rgba(99, 207, 228, 0.35)';
      ctx.shadowColor = 'rgba(99, 207, 228, 0.5)';
      ctx.shadowBlur = 16 * zoom;
      blob(ctx, sx, sy, L.shape, R * 1.16); ctx.fill();
      ctx.restore();

      // Sandy landmass (seed-unique silhouette).
      ctx.save();
      ctx.fillStyle = '#f2ddaa';
      ctx.strokeStyle = '#e0c078';
      ctx.lineWidth = Math.max(1, 2 * zoom);
      ctx.shadowColor = 'rgba(20, 40, 55, 0.18)';
      ctx.shadowBlur = 6 * zoom;
      blob(ctx, sx, sy, L.shape, R); ctx.fill(); ctx.stroke();
      ctx.restore();

      // Interior tinted by the island's colour.
      ctx.save();
      ctx.fillStyle = isl.color || '#8fbf5a';
      ctx.globalAlpha = 0.92;
      blob(ctx, sx, sy, L.shape, R * 0.76); ctx.fill();
      ctx.restore();

      // Raw-material markers (primary + secondary resource) scattered on the land.
      this._markers(ctx, isl, L, sx, sy, R);
      // Town: building count grows with civilisation.
      this._town(ctx, isl, L, sx, sy, R);
      // Manufactured-goods badges in a row along the shore.
      this._badges(ctx, isl, sx, sy, R);
      // Dock.
      drawDock(ctx, sx, sy, R, L.dockAngle);

      // Selected ship's home port gets a bright halo (clamped so it reads when zoomed out).
      if (highlightIslandId && isl.id === highlightIslandId) this._homeIslandRing(sx, sy, Math.max(R * 1.35, 26), now);

      // Event afflictions — a pulsing coloured ring, clamped to a minimum screen size so
      // it's obvious even at overview zoom (where the island itself is a dot).
      if (isl.blight) this._statusRing(sx, sy, Math.max(R * 1.3, 17), '#ff9a3c', now, true);
      if (isl.plague) this._statusRing(sx, sy, Math.max(R * 1.55, 21), '#cf7bee', now, false);
      // A port in open rebellion is aflame — flickering embers, unmistakable at any zoom.
      if (isl.rebellion) this._fireRing(sx, sy, Math.max(R * 1.15, 16), now, isl.id);
      // A pirate HAVEN — a dark menacing ring and the black flag flying over the wharves.
      if (isl.haven) this._havenMark(sx, sy, Math.max(R * 1.35, 18), now);
      // Pirate-haunted waters — a faint crimson haze that deepens with the danger.
      if (isl.danger > 0.25) this._dangerHaze(sx, sy, Math.max(R * 1.7, 24), isl.danger, now);

      if (zoom > 0.32) this._label(isl.name, sx, sy, R);
    }
  }

  /** Faint crimson haze over pirate-threatened waters — a soft ring that deepens with danger. */
  _dangerHaze(sx, sy, r, danger, now) {
    const ctx = this.ctx;
    const d = Math.min(1, danger);
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.004);
    ctx.save();
    ctx.globalAlpha = 0.12 * d * pulse;
    ctx.fillStyle = '#b03030';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.35 * d;
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /** A pirate haven — a dark blood-red ring and a small black flag flying over the port. */
  _havenMark(sx, sy, r, now) {
    const ctx = this.ctx;
    const pulse = 0.55 + 0.45 * Math.sin(now * 0.005);
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#2a0308';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.45 * pulse;
    ctx.strokeStyle = '#8a1420'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // Black flag on a staff planted above the island.
    ctx.save();
    const fx = sx, fy = sy - r - 3;
    ctx.strokeStyle = '#141414'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 15); ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.moveTo(fx, fy - 15); ctx.lineTo(fx + 13, fy - 12); ctx.lineTo(fx, fy - 9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e8e0d0'; // a pale skull dot on the flag
    ctx.beginPath(); ctx.arc(fx + 4.5, fy - 12, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** Flickering ring of flames around a port in revolt — a hot glow disc + licking tongues. */
  _fireRing(sx, sy, r, now, seed) {
    const ctx = this.ctx;
    const h = ((typeof seed === 'string' ? seed.charCodeAt(1) : seed) | 0) * 0.7;
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.011 + h);
    ctx.save();
    // hot glow
    ctx.globalAlpha = 0.28 * pulse;
    ctx.fillStyle = '#ff5a1e';
    ctx.shadowColor = '#ff7a2a'; ctx.shadowBlur = r * 0.9;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    // licking flames
    ctx.globalAlpha = 0.9;
    const flames = 9;
    for (let i = 0; i < flames; i++) {
      const a = (i / flames) * Math.PI * 2 + now * 0.001;
      const flick = 0.7 + 0.5 * Math.sin(now * 0.02 + i * 2.1 + h);
      const bx = sx + Math.cos(a) * r, by = sy + Math.sin(a) * r;
      const tipR = r + r * 0.45 * flick;
      const tx = sx + Math.cos(a) * tipR, ty = sy + Math.sin(a) * tipR;
      const wob = 0.35;
      ctx.fillStyle = i % 2 ? '#ffd24a' : '#ff6a1e';
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a - wob) * r, sy + Math.sin(a - wob) * r);
      ctx.lineTo(tx, ty);
      ctx.lineTo(sx + Math.cos(a + wob) * r, sy + Math.sin(a + wob) * r);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  _statusRing(sx, sy, r, color, now, dashed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.35 * Math.sin(now * 0.006);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  _homeIslandRing(sx, sy, r, now) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.7 + 0.25 * Math.sin(now * 0.005);
    ctx.strokeStyle = PALETTE.selection;
    ctx.lineWidth = 3;
    ctx.shadowColor = PALETTE.selection;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw one-shot generic effects + debris (e.g. a shipwreck splash) from EffectsManager. */
  drawEffects(effectsManager, now) {
    this.effectsRenderer.drawGenericEffects(effectsManager.getGenericEffects(now), now);
    this.effectsRenderer.drawDebris(effectsManager.getDebris(now));
  }

  _markers(ctx, isl, L, sx, sy, R) {
    if (R < 12) return; // too small to read
    const s = R * 0.16;
    for (let i = 0; i < L.markers.length; i++) {
      const m = L.markers[i];
      const res = i === L.markers.length - 1 && isl.secondary ? isl.secondary : isl.primary;
      drawRawGlyph(ctx, res, sx + m.dx * R, sy + m.dy * R, s);
    }
  }

  _town(ctx, isl, L, sx, sy, R) {
    if (R < 14) return;
    const civ = Math.max(0, Math.min(1, isl.civ || 0));
    const n = Math.round(civ * L.town.length);
    const hs = R * 0.13;
    for (let i = 0; i < n; i++) {
      const t = L.town[i];
      drawHouse(ctx, sx + t.dx * R, sy + t.dy * R, hs * t.s, t.hue);
    }
  }

  _badges(ctx, isl, sx, sy, R) {
    const goods = isl.produces || [];
    if (!goods.length || R < 16) return;
    const s = R * 0.2;
    const gap = s * 2.2;
    let x = sx - (goods.length - 1) * gap / 2;
    const y = sy + R * 0.52;
    for (const g of goods) { drawGoodBadge(ctx, g, x, y, s); x += gap; }
  }

  _label(text, sx, sy, R) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const y = sy + R + 4;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(240, 252, 255, 0.85)';
    ctx.strokeText(text, sx, y);
    ctx.fillStyle = PALETTE.hud;
    ctx.fillText(text, sx, y);
    ctx.restore();
  }

  /** Seeded, cached procedural layout for one island (stable across frames). The
   *  silhouette is built from directional stretch + a few coherent radial harmonics
   *  (low frequencies = broad lobes/bays, high = a craggy coast) + an optional harbor
   *  inlet, with per-TYPE character so a jagged mining rock, a long plantation and a
   *  bayed shipyard read as genuinely different islands — not lumpy circles. */
  _layout(id, type) {
    let L = this._islands.get(id);
    if (L) return L;
    const rng = mulberry(hashSeed(id));
    const ch = SHAPE_CHARACTER[type] || SHAPE_CHARACTER.default;

    const ax = ch.axMin + rng() * (ch.axMax - ch.axMin);   // directional stretch
    const ay = ch.ayMin + rng() * (ch.ayMax - ch.ayMin);
    const rot = rng() * Math.PI * 2;
    const nH = ch.harmMin + Math.floor(rng() * (ch.harmMax - ch.harmMin + 1));
    const harm = [];
    for (let i = 0; i < nH; i++) {
      harm.push({ f: 1 + Math.floor(rng() * ch.maxFreq), a: ch.ampMin + rng() * (ch.ampMax - ch.ampMin), p: rng() * Math.PI * 2 });
    }
    const bay = ch.bay && rng() < ch.bay
      ? { at: rng() * Math.PI * 2, depth: 0.28 + rng() * 0.26, width: 0.5 + rng() * 0.45 }
      : null;

    const N = 30;
    const shape = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      let rad = 0.82;
      for (const h of harm) rad += Math.sin(a * h.f + h.p) * h.a;
      if (bay) { const d = angDist(a, bay.at); if (d < bay.width) rad -= bay.depth * (1 - d / bay.width); }
      rad = Math.max(0.34, Math.min(1.32, rad));
      const px = Math.cos(a) * rad * ax, py = Math.sin(a) * rad * ay;
      const c = Math.cos(rot), s = Math.sin(rot);
      shape.push({ dx: px * c - py * s, dy: px * s + py * c });
    }

    // Town spots (up to 16) inside the silhouette; render count scales with civ.
    const town = [];
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2, rr = 0.1 + rng() * 0.4;
      town.push({ dx: Math.cos(a) * rr * ax * 0.9, dy: (Math.sin(a) * rr * ay - 0.04) * 0.9, s: 0.7 + rng() * 0.7, hue: rng() });
    }
    // Raw-material marker spots (2-3).
    const markers = [];
    const mc = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < mc; i++) {
      const a = rng() * Math.PI * 2, rr = 0.32 + rng() * 0.26;
      markers.push({ dx: Math.cos(a) * rr * ax * 0.85, dy: Math.sin(a) * rr * ay * 0.85 });
    }
    // Dock sits on the bay if there is one, else anywhere on the coast.
    L = { shape, town, markers, dockAngle: bay ? bay.at : rng() * Math.PI * 2 };
    this._islands.set(id, L);
    return L;
  }

  // ─── Wakes / Ships / Selection (declarative art) ─────────────────
  drawWakes(trails, now) { this.effectsRenderer.drawTrails(trails, now); }

  drawShips(shipsById, islandsById, bounds, now, highlightHomeId = null) {
    if (!shipsById) return;
    const zoom = this.camera.getZoom?.() ?? 1;
    for (const id in shipsById) {
      const s = shipsById[id];
      if (!inBounds(s.x, s.y, SHIP_RADIUS * 1.6, bounds)) continue;
      this._seen.add('s:' + id);
      const def = this.art.ships[s.type] || this.art.ships.ship;
      if (!def) { this._warn('ship:' + s.type, `[WorldRenderer] no ship art for type "${s.type}"`); continue; }
      const home = islandsById && islandsById.get(s.homeId);
      const color = (home && home.color) || PALETTE.accent;
      // A selected island's own ships get a bright halo — clamped to a minimum screen size
      // so its whole fleet is trackable across the map even at overview zoom (where a ship
      // is only ~1px). Drawn as a filled disc glow + ring so it pops against the water.
      if (highlightHomeId && s.homeId === highlightHomeId) this._homeRing(s.x, s.y, Math.max(SHIP_RADIUS * 1.7 * zoom, 11), now);
      // Hull tint tells faction at a glance: pirate crimson-black, privateer naval blue, else home.
      const hull = s.pirate ? PIRATE_HULL : s.privateer ? PRIVATEER_HULL : color;
      const r = SHIP_RADIUS * (SHIP_TYPE_SCALE[s.type] || 1); // size reads the hull class
      this._drawArtAt(def, s.x, s.y, r, hull, s.state || 'sailing', now, this._trans('s:' + id), s.heading || 0);
      // A crew in open revolt (mutiny/defection standoff) — a stark pulsing marker, clamped so
      // it's spotted anywhere on the map even at overview zoom.
      if (s.revolt) this._revoltRing(s.x, s.y, Math.max(SHIP_RADIUS * 1.9 * zoom, 13), now);
      // A pirate raised the black flag — a skull marker so predators are spotted anywhere.
      else if (s.pirate) this._pirateMark(s.x, s.y, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
      // A commissioned privateer — a naval marker (the hunter) so the law is visible too.
      else if (s.privateer) this._privateerMark(s.x, s.y, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
    }
  }

  /** A privateer's mark: a steel-blue disc + crossed-sabres, the sanctioned pirate-hunter. */
  _privateerMark(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.7 + 0.3 * Math.sin(now * 0.006);
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#2f4b6e';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#6fa8d8';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#cfe4f6';
    ctx.shadowColor = '#0a1a2a'; ctx.shadowBlur = 5;
    ctx.font = `${Math.round(Math.max(11, r * 0.95))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚔', sx, sy - r - 6);
    ctx.restore();
  }

  /** Named storm cells — dark swirling clouds drifting over the sea. Drawn under the ships so a
   *  vessel caught inside is still visible fighting the weather. Culled by the view bounds. */
  drawStorms(storms, bounds, now) {
    if (!storms || !storms.length) return;
    const ctx = this.ctx;
    const zoom = this.camera.getZoom?.() ?? 1;
    for (const st of storms) {
      if (!inBounds(st.x, st.y, st.r, bounds)) continue;
      const { sx, sy } = this.camera.worldToScreen(st.x, st.y);
      const r = st.r * zoom;
      ctx.save();
      const grad = ctx.createRadialGradient(sx, sy, r * 0.1, sx, sy, r);
      grad.addColorStop(0, 'rgba(38,46,62,0.52)');
      grad.addColorStop(0.7, 'rgba(48,56,74,0.34)');
      grad.addColorStop(1, 'rgba(60,70,90,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      // slow-rotating swirl arcs
      ctx.strokeStyle = 'rgba(206,216,232,0.38)';
      ctx.lineWidth = 2;
      const rot = now * 0.0006;
      for (let i = 0; i < 3; i++) { const a = rot + i * (Math.PI * 2 / 3); ctx.beginPath(); ctx.arc(sx, sy, r * 0.55, a, a + Math.PI * 0.8); ctx.stroke(); }
      // occasional lightning flicker
      if ((Math.sin(now * 0.02 + sx) > 0.94)) { ctx.globalAlpha = 0.5; ctx.fillStyle = '#dfe7f2'; ctx.beginPath(); ctx.arc(sx, sy, r * 0.9, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.fillStyle = 'rgba(222,230,242,0.9)';
      ctx.font = `${Math.round(Math.max(11, r * 0.13))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⛈ Storm ' + st.name, sx, sy - r - 8);
      ctx.restore();
    }
  }

  /** The black flag: a dark disc + skull that hovers over a pirate vessel — menacing, and
   *  clamped to a minimum screen size so a raider is trackable across the map at any zoom. */
  _pirateMark(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.7 + 0.3 * Math.sin(now * 0.008);
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#0b0b10';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#1c1c24';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#f4f0e6'; // bone white
    ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
    ctx.font = `${Math.round(Math.max(12, r * 1.1))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('☠', sx, sy - r - 6);
    ctx.restore();
  }

  _revoltRing(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.012); // fast, alarming
    ctx.save();
    ctx.globalAlpha = pulse * 0.3;
    ctx.fillStyle = '#ff4d3d';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#ff5b4a';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#ff4d3d';
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(sx, sy, r * (0.9 + 0.15 * pulse), 0, Math.PI * 2); ctx.stroke();
    // crossed-swords tick marks around the ring
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#ffd166';
    ctx.font = `${Math.round(Math.max(11, r * 0.9))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚔', sx, sy - r - 6);
    ctx.restore();
  }

  _homeRing(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.65 + 0.3 * Math.sin(now * 0.006);
    ctx.save();
    ctx.globalAlpha = pulse * 0.28;
    ctx.fillStyle = PALETTE.selection;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = PALETTE.selection;
    ctx.lineWidth = 2;
    ctx.shadowColor = PALETTE.selection;
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  drawSelection(sel, now) {
    if (!sel || !sel.data) return;
    const ring = this.vfx.selectionRing;
    if (!ring) return;
    const r = sel.kind === 'island' ? islandRadius(sel.data) * 1.3 : SHIP_RADIUS * 2.0;
    this.effectsRenderer.drawEffectAt(ring, sel.data.x, sel.data.y, null, r, now);
  }

  _drawArtAt(def, wx, wy, r, color, state, now, transition, rotation = 0) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(zoom, zoom);
    if (rotation) ctx.rotate(rotation);
    drawUnifiedArt(ctx, r, color, def, state, now, transition);
    ctx.restore();
  }

  _trans(id) {
    let t = this._transitions.get(id);
    if (!t) { t = {}; this._transitions.set(id, t); }
    return t;
  }

  _warn(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(msg);
  }
}

// ─── module helpers ──────────────────────────────────────────────
// Per-type silhouette character: stretch range, how many radial harmonics and how high
// their frequency (low = broad lobes, high = jagged coast), amplitude, and bay chance.
const SHAPE_CHARACTER = {
  plantation: { axMin: 0.72, axMax: 1.55, ayMin: 0.6, ayMax: 1.0, harmMin: 2, harmMax: 3, maxFreq: 3, ampMin: 0.06, ampMax: 0.16, bay: 0.15 }, // long fields
  ranch:      { axMin: 0.92, axMax: 1.4, ayMin: 0.82, ayMax: 1.32, harmMin: 2, harmMax: 3, maxFreq: 2, ampMin: 0.05, ampMax: 0.14, bay: 0.1 },  // broad
  forest:     { axMin: 0.8, axMax: 1.2, ayMin: 0.8, ayMax: 1.2, harmMin: 3, harmMax: 4, maxFreq: 5, ampMin: 0.09, ampMax: 0.2, bay: 0.15 },     // bumpy
  mining:     { axMin: 0.68, axMax: 1.28, ayMin: 0.68, ayMax: 1.28, harmMin: 3, harmMax: 5, maxFreq: 8, ampMin: 0.13, ampMax: 0.28, bay: 0.1 }, // craggy rock
  shipyard:   { axMin: 0.82, axMax: 1.18, ayMin: 0.82, ayMax: 1.18, harmMin: 2, harmMax: 3, maxFreq: 4, ampMin: 0.08, ampMax: 0.18, bay: 0.95 },// harbour bay
  default:    { axMin: 0.75, axMax: 1.3, ayMin: 0.75, ayMax: 1.3, harmMin: 2, harmMax: 4, maxFreq: 5, ampMin: 0.08, ampMax: 0.2, bay: 0.3 },
};

function angDist(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function inBounds(x, y, r, b) {
  return x + r >= b.left && x - r <= b.right && y + r >= b.top && y - r <= b.bottom;
}

/** Island draw radius reflects the island's LAND / carrying capacity (max population) —
 *  tiny outposts are markedly smaller than huge metropolises. Uses a gentle power so the
 *  spread is dramatic but the giants don't swallow the map. Stable (doesn't flicker with
 *  live population); variety also comes from the seed-unique silhouette. Exported so
 *  hit-testing (click/hover) matches the drawn size. */
export function islandRadius(isl) {
  const k = isl.k || 120;
  const scale = Math.pow(k / 130, 0.62);
  return ISLAND_RADIUS * Math.max(0.4, Math.min(1.85, scale));
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth closed blob through unit-radius points, scaled and centred. */
function blob(ctx, cx, cy, pts, scale) {
  const n = pts.length;
  ctx.beginPath();
  const first = pts[n - 1], second = pts[0];
  ctx.moveTo(cx + (first.dx + second.dx) / 2 * scale, cy + (first.dy + second.dy) / 2 * scale);
  for (let i = 0; i < n; i++) {
    const cur = pts[i], next = pts[(i + 1) % n];
    const ex = cx + (cur.dx + next.dx) / 2 * scale;
    const ey = cy + (cur.dy + next.dy) / 2 * scale;
    ctx.quadraticCurveTo(cx + cur.dx * scale, cy + cur.dy * scale, ex, ey);
  }
  ctx.closePath();
}

function drawDock(ctx, sx, sy, R, angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const x0 = sx + dx * R * 0.6, y0 = sy + dy * R * 0.6;
  const x1 = sx + dx * R * 1.05, y1 = sy + dy * R * 1.05;
  ctx.save();
  ctx.strokeStyle = '#a9793f';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, R * 0.08);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.restore();
}

function drawHouse(ctx, x, y, s, hue) {
  ctx.save();
  const wall = hue < 0.5 ? '#e7d2a6' : '#d9b98a';
  ctx.fillStyle = wall;
  ctx.fillRect(x - s, y - s * 0.5, s * 2, s * 1.3);
  ctx.fillStyle = '#9c5a3c'; // roof
  ctx.beginPath();
  ctx.moveTo(x - s * 1.2, y - s * 0.5);
  ctx.lineTo(x, y - s * 1.4);
  ctx.lineTo(x + s * 1.2, y - s * 0.5);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Raw-material glyphs (primary/secondary resource).
function drawRawGlyph(ctx, res, x, y, s) {
  ctx.save();
  ctx.lineCap = 'round';
  switch (res) {
    case 'Grain': { // wheat stalks
      ctx.strokeStyle = '#d9b23a'; ctx.lineWidth = Math.max(1, s * 0.18);
      for (const o of [-s * 0.5, 0, s * 0.5]) { ctx.beginPath(); ctx.moveTo(x + o, y + s); ctx.lineTo(x + o, y - s * 0.7); ctx.stroke(); }
      ctx.fillStyle = '#e8c95a';
      for (const o of [-s * 0.5, 0, s * 0.5]) { ctx.beginPath(); ctx.ellipse(x + o, y - s * 0.8, s * 0.28, s * 0.5, 0, 0, 7); ctx.fill(); }
      break;
    }
    case 'Wood': { // pine tree
      ctx.strokeStyle = '#7a5230'; ctx.lineWidth = Math.max(1, s * 0.3);
      ctx.beginPath(); ctx.moveTo(x, y + s); ctx.lineTo(x, y + s * 0.2); ctx.stroke();
      ctx.fillStyle = '#3f8f4f';
      ctx.beginPath(); ctx.moveTo(x, y - s * 1.1); ctx.lineTo(x + s * 0.9, y + s * 0.3); ctx.lineTo(x - s * 0.9, y + s * 0.3); ctx.closePath(); ctx.fill();
      break;
    }
    case 'Meat': { // livestock
      ctx.fillStyle = '#8a5a3c';
      ctx.beginPath(); ctx.ellipse(x, y, s * 0.95, s * 0.6, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x + s * 0.9, y - s * 0.2, s * 0.4, 0, 7); ctx.fill();
      break;
    }
    case 'Fiber': { // tuft
      ctx.strokeStyle = '#8fb24a'; ctx.lineWidth = Math.max(1, s * 0.16);
      for (const a of [-0.5, -0.2, 0.1, 0.4]) { ctx.beginPath(); ctx.moveTo(x, y + s); ctx.lineTo(x + Math.sin(a) * s * 1.3, y - s); ctx.stroke(); }
      break;
    }
    case 'Iron': { // ore chunk
      ctx.fillStyle = '#6b7079'; ctx.strokeStyle = '#4a4f57'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.4); ctx.lineTo(x - s * 0.4, y - s); ctx.lineTo(x + s * 0.7, y - s * 0.5);
      ctx.lineTo(x + s, y + s * 0.6); ctx.lineTo(x - s * 0.2, y + s); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#aab0b8'; ctx.beginPath(); ctx.arc(x - s * 0.2, y - s * 0.2, s * 0.2, 0, 7); ctx.fill();
      break;
    }
    case 'PreciousMetal': { // gem
      ctx.fillStyle = '#e7f6ff'; ctx.strokeStyle = '#8fd6e8'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.8, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.8, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
      break;
    }
    default: {
      ctx.fillStyle = '#c9b98a'; ctx.beginPath(); ctx.arc(x, y, s * 0.5, 0, 7); ctx.fill();
    }
  }
  ctx.restore();
}

// Manufactured-goods badges (produces).
function drawGoodBadge(ctx, good, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (good) {
    case 'Food': // loaf
      ctx.fillStyle = '#d8a441'; ctx.beginPath(); ctx.ellipse(0, 0, s * 0.9, s * 0.55, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = '#a9781f'; ctx.lineWidth = Math.max(1, s * 0.12);
      for (const o of [-s * 0.4, 0, s * 0.4]) { ctx.beginPath(); ctx.moveTo(o, -s * 0.4); ctx.lineTo(o, s * 0.4); ctx.stroke(); }
      break;
    case 'Ale': // barrel
      ctx.fillStyle = '#8a5a2c'; ctx.fillRect(-s * 0.6, -s * 0.8, s * 1.2, s * 1.6);
      ctx.strokeStyle = '#d9c07a'; ctx.lineWidth = Math.max(1, s * 0.14);
      ctx.beginPath(); ctx.moveTo(-s * 0.6, -s * 0.3); ctx.lineTo(s * 0.6, -s * 0.3); ctx.moveTo(-s * 0.6, s * 0.3); ctx.lineTo(s * 0.6, s * 0.3); ctx.stroke();
      break;
    case 'Clothing': // folded cloth
      ctx.fillStyle = '#d06a9a'; ctx.fillRect(-s * 0.8, -s * 0.7, s * 1.6, s * 1.4);
      ctx.strokeStyle = '#f0c0d8'; ctx.lineWidth = Math.max(1, s * 0.12);
      ctx.beginPath(); ctx.moveTo(-s * 0.8, 0); ctx.lineTo(s * 0.8, 0); ctx.stroke();
      break;
    case 'Weapons': // anvil
      ctx.fillStyle = '#4b5058';
      ctx.fillRect(-s * 0.8, -s * 0.2, s * 1.6, s * 0.5);
      ctx.fillRect(-s * 0.3, s * 0.3, s * 0.6, s * 0.5);
      ctx.beginPath(); ctx.moveTo(-s * 0.9, -s * 0.2); ctx.lineTo(-s * 0.5, -s * 0.6); ctx.lineTo(s * 0.2, -s * 0.6); ctx.lineTo(s * 0.2, -s * 0.2); ctx.closePath(); ctx.fill();
      break;
    case 'LuxuryGoods': // bright gem
      ctx.fillStyle = '#ffe36a'; ctx.strokeStyle = '#c9a13a'; ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, -s * 0.2); ctx.lineTo(0, s); ctx.lineTo(-s * 0.9, -s * 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.moveTo(-s * 0.9, -s * 0.2); ctx.lineTo(0, -s * 0.2); ctx.lineTo(0, -s); ctx.stroke();
      break;
    case 'Ships': // little boat
      ctx.fillStyle = '#c8a06a'; ctx.strokeStyle = '#7c5324'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-s * 0.9, 0); ctx.lineTo(s * 0.9, 0); ctx.lineTo(s * 0.5, s * 0.6); ctx.lineTo(-s * 0.5, s * 0.6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#eef3f7'; ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.55, -s * 0.1); ctx.lineTo(0, -s * 0.1); ctx.closePath(); ctx.fill();
      break;
    default:
      ctx.fillStyle = '#cfe0b0'; ctx.beginPath(); ctx.arc(0, 0, s * 0.6, 0, 7); ctx.fill();
  }
  ctx.restore();
}
