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
import { SpriteCache } from '/engine/render/SpriteCache.js';
import { PALETTE, PALETTE_VERSION, ISLAND_RADIUS, SHIP_RADIUS } from './config.js';
import { drawIcon } from './ui/icons.js';
import { OVERLAYS, heatColor, neutralColor, normalize, segmentInBounds } from './overlays.js';

// The data-overlay REGISTRY + colour ramp + normalisation now live in ./overlays.js (pure,
// unit-testable, shared with SimScene + the almanac). Re-exported here so existing importers
// keep resolving OVERLAYS/heatColor from WorldRenderer.
export { OVERLAYS, heatColor };

// The runtime `color` dyes a ship's SAILS (the hull keeps its own weathered-timber colour in
// the art). A pirate flies BLACK canvas (vs a merchant's home-port colour) so a raider reads
// as hostile at a glance even before the skull marker; a privateer flies naval navy — the law's
// answer, distinct from both merchant and pirate.
const PIRATE_SAIL = '#14100f';
const PRIVATEER_SAIL = '#25415e';

// Hull class reads from silhouette (1/2/3 masts, sterncastle) baked into ship-art.json; this is
// just a mild residual size cue on top — a nimble sloop rides a touch smaller, a galleon larger.
const SHIP_TYPE_SCALE = { sloop: 0.9, brig: 1.0, galleon: 1.18 };

// Overview level-of-detail thresholds (screen-space radius, px). Zoomed far enough out that
// EVERY island/ship is on-screen at once, the full procedural silhouette / declarative ship art
// is both illegible AND the dominant cost (per-island shadow-blur blobs, per-ship art). Below
// these sizes we draw a cheap flat dot instead — the overview stays smooth at 1000s of ports/ships.
// Above them the detailed path is byte-for-byte the same as before (LOD is purely additive).
const ISLE_LOD_MIN = 8;
const SHIP_LOD_MIN = 5;
// Zoom at/above which the dual hull+rig HEALTH bar is worth drawing. A base ship (r≈15) reads ~21px wide
// here, so the two thin bars are legible; below it they turn into fiddly noise, so we swap to a single
// compact damage dot instead (see _damageDot). ~0.7 is where a ship first reads clearly, not as a speck.
const HEALTHBAR_ZOOM_MIN = 0.7;
// Ships closer than this (world units, ≈ PIRATE_COMBAT_RANGE) and locked in a fight trade visible broadsides.
const COMBAT_VIS_RANGE = 175;
const COMBAT_ACTS = new Set(['hunt', 'fight', 'defend', 'assault', 'raid', 'flee']);
/** Small stable string hash → a per-ship phase offset so broadsides don't fire in lockstep. */
function hashId(id) { let x = 0; const s = String(id); for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; }

// ─── Workshops (mutable island industry, drawn as little buildings) ─────────────────────
// The server streams each island's works as isl.workshops = [{ good, cond, st }, …]. An INDUSTRIAL
// workshop carries a status byte `st` (0 running / 1 idle / 2 derelict); a survival good (Food/Ale)
// streams as just { good } with NO `st`, so `w.st != null` is the "is this a building to draw" test.
// Each industrial good has an upright art asset in data/workshop-art.json (art.workshops.<Good>); the
// status byte maps to the art STATE — running is full-ink with a chimney puff, idle is ghosted/greyed,
// disrepair CAVES the roof in (a SHAPE change, so status reads for colour-blind viewers, not a tint).
const WORKSHOP_STATE = ['running', 'idle', 'disrepair']; // st byte 0/1/2 → art state
const WORKSHOP_R = 0.26;      // building draw radius as a fraction of the island's screen radius R
const WORKSHOP_LOD_MIN = 14;  // hide buildings below this island screen radius (mirrors _town)
// The silhouettes are frame-STABLE per (good, state), so each is baked ONCE into a dedicated tiny
// sprite cache (this._workshopCache — never the LRU-pressured terrain cache) and blitted. Baked at a
// fixed reference radius, then scaled on blit (like terrain tiles scale by zoom). The running-state
// chimney smoke is FROZEN into the bake at this clock, so a building is a plain blit — no live FX.
const WORKSHOP_BAKE_R = 40;     // reference radius (px) the building is rasterised at
const WORKSHOP_BAKE_NOW = 900;  // animation clock (ms) frozen into the bake — a mid-rise smoke puff + warm forge
// Baked-tile geometry (reference px). Origin = the art's (0,0), which lands on the building's anchor at
// blit. The plume rises well ABOVE the origin (to ~y=-1.55·r), the base/shadow sit just below (~+0.65·r),
// and the walls span ~±0.8·r — pad each side for stroke/shadow bleed.
const WORKSHOP_BAKE_OX = WORKSHOP_BAKE_R * 0.95 + 3;                 // art-origin x inside the tile
const WORKSHOP_BAKE_OY = WORKSHOP_BAKE_R * 1.60 + 3;                 // art-origin y (smoke reaches near the top)
const WORKSHOP_BAKE_W = WORKSHOP_BAKE_OX + WORKSHOP_BAKE_R * 0.95 + 3;
const WORKSHOP_BAKE_H = WORKSHOP_BAKE_OY + WORKSHOP_BAKE_R * 0.72 + 3;

export class WorldRenderer {
  constructor(ctx, camera, art, vfx, effectsRenderer) {
    this.ctx = ctx;
    this.camera = camera;
    this.art = art;                  // { ships:{...} } (islands are procedural)
    this.vfx = vfx;                  // VFX_DEFS
    this.effectsRenderer = effectsRenderer; // wraps the engine VFX interpreter
    this._transitions = new Map();   // ship id -> per-entity transition (keyframe clock + blend)
    this._islands = new Map();       // island id -> cached procedural layout (seeded)
    this._isleCache = new SpriteCache({ max: 128, dprCap: 2 }); // baked island terrain tiles (static per id)
    this._workshopCache = new SpriteCache({ max: 32, dprCap: 2 }); // baked workshop building silhouettes (per good+state); NEVER the terrain cache (it would evict tiles)
    this._berths = new Map();        // ship id -> { x, y } berth slot for a docked ship (recomputed each frame)
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
      const { sx, sy } = this.camera.worldToScreen(isl.x, isl.y);
      const R = rad * zoom;

      // Overview LOD: below a legible size (zoomed right out, where all N ports are on-screen)
      // draw a flat dot + a single static trouble-ring, skipping the whole procedural silhouette
      // (3 shadow-blur blobs), town, badges, dock, and animated affliction rings.
      if (R < ISLE_LOD_MIN) { this._islandDot(ctx, isl, sx, sy, R, now, highlightIslandId); continue; }

      const L = this._layout(isl.id, isl.type);
      const seed = hashSeed(isl.id);
      const breathe = 1 + 0.02 * Math.sin(now * 0.0016 + (seed % 997) * 0.0063);

      // Soft displaced shadow the landmass casts on the water (sun from the upper-left).
      ctx.save();
      ctx.fillStyle = PALETTE.foamShadow;
      ctx.shadowColor = PALETTE.foamShadow;
      ctx.shadowBlur = 8 * zoom;
      blob(ctx, sx + R * 0.10, sy + R * 0.12, L.shape, R * 1.02); ctx.fill();
      ctx.restore();

      // Shallow-water band + a broken surf line that breathes and churns around the coast.
      ctx.save();
      ctx.fillStyle = PALETTE.seaShallow; ctx.globalAlpha = 0.34;
      blob(ctx, sx, sy, L.shape, R * 1.16 * breathe); ctx.fill();
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now * 0.0016 + seed);
      ctx.strokeStyle = PALETTE.foam;
      ctx.lineWidth = Math.max(1, 1.6 * zoom);
      ctx.setLineDash([R * 0.5, R * 0.34]);
      ctx.lineDashOffset = -now * 0.02;
      blob(ctx, sx, sy, L.shape, R * 1.11 * breathe); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Baked terrain: beach gradient + inked coastline + relief-shaded, textured interior. Static
      // per id (silhouette / type / colour / radius never change), so rasterise once and blit; the
      // live sim overlays (markers / town / badges / afflictions) still draw per-frame on top.
      const half = rad * L.ext + 3;
      const tile = this._isleCache.get(`isle:${isl.id}:${Math.round(rad)}:${PALETTE_VERSION}`, half * 2, half * 2,
        (cctx, w, h) => drawIsleTerrain(cctx, w / 2, h / 2, rad, L, isl));
      if (tile) ctx.drawImage(tile.canvas, sx - half * zoom, sy - half * zoom, tile.w * zoom, tile.h * zoom);
      else drawIsleTerrain(ctx, sx, sy, R, L, isl); // Node / no-canvas fallback (screen-space)

      // Raw-material markers (primary + secondary resource) scattered on the land.
      this._markers(ctx, isl, L, sx, sy, R);
      // Town: building count grows with civilisation.
      this._town(ctx, isl, L, sx, sy, R);
      // Manufactured-goods badges in a row along the shore (the status-independent goods manifest).
      this._badges(ctx, isl, sx, sy, R);
      // Mutable-industry buildings drawn on the land, their art state reading each workshop's status.
      this._workshops(ctx, isl, L, sx, sy, R);
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
      // A port keeping a FESTIVAL — a warm glow and a ring of twinkling lanterns.
      if (isl.festival) this._festivalMark(sx, sy, Math.max(R * 1.25, 16), now, isl.id);

      if (zoom > 0.32) this._label(isl.name, sx, sy, R);
    }
  }

  /** Overview LOD stand-in for an island: a flat dot (shallows + interior colour, no shadow-blur)
   *  plus a single static ring for its worst affliction — the "something's wrong here" cue that the
   *  animated rings give up close, kept legible at overview zoom without their per-frame cost. */
  _islandDot(ctx, isl, sx, sy, R, now, highlightIslandId) {
    const r = Math.max(2, R);
    ctx.save();
    ctx.fillStyle = 'rgba(99, 207, 228, 0.30)'; // faint shallows so a speck still reads as land-in-water
    ctx.beginPath(); ctx.arc(sx, sy, r * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isl.color || '#8fbf5a';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Worst affliction first (haven > rebellion > plague > blight > danger) → one cheap static stroke.
    const trouble = isl.haven ? '#8a1420' : isl.rebellion ? '#ff5a1e' : isl.plague ? '#cf7bee'
      : isl.blight ? '#ff9a3c' : (isl.danger > 0.25 ? '#c0392b' : null);
    if (trouble) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = trouble; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(r + 3, 6), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (highlightIslandId && isl.id === highlightIslandId) this._homeIslandRing(sx, sy, Math.max(R * 1.35, 26), now);
  }

  /** Data overlay: tint every visible port by one auto-ranged scalar (a heatmap layer). Drawn
   *  over the islands and under the ships, so vessels stay readable. `spec` is a SCALAR OVERLAYS
   *  entry; `stats` carries the precomputed colour domain {lo,hi} (from OverlayModel — no
   *  per-island aggregation here). Ports with no data on the metric read neutral, not "worst".
   *  Below the island LOD size a flat dot replaces the gradient disc (overview stays cheap), and
   *  value badges are de-cluttered by a coarse screen grid so dense clusters don't turn to mush. */
  drawOverlay(islands, bounds, spec, stats, now) {
    if (!spec || spec.kind !== 'scalar' || !stats) return;
    const ctx = this.ctx;
    const zoom = this.camera.getZoom?.() ?? 1;
    const lo = stats.lo, hi = stats.hi;
    const cells = this._overlayBadgeCells || (this._overlayBadgeCells = new Set());
    cells.clear();
    for (const isl of islands) {
      const rad = islandRadius(isl);
      if (!inBounds(isl.x, isl.y, rad * 2, bounds)) continue;
      const { sx, sy } = this.camera.worldToScreen(isl.x, isl.y);
      const noData = !!(spec.skipEmpty && !(isl.population > 0));
      const v = noData ? null : normalize(spec.accessor(isl), lo, hi);
      const t = v == null ? null : (spec.good ? v : 1 - v); // bad-is-high metrics invert
      const R = rad * zoom;

      // Overview LOD: below a legible size, one flat dot instead of a radial gradient + ring + badge.
      if (R < ISLE_LOD_MIN) {
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = t == null ? neutralColor(0.55) : heatColor(t, 0.72);
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, R * 1.4), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        continue;
      }

      const r = Math.max(rad * zoom * 1.5, 15);
      ctx.save();
      const grad = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, r);
      if (t == null) { grad.addColorStop(0, neutralColor(0.5)); grad.addColorStop(1, neutralColor(0.04)); }
      else { grad.addColorStop(0, heatColor(t, 0.62)); grad.addColorStop(1, heatColor(t, 0.05)); }
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = t == null ? neutralColor(0.6) : heatColor(t, 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      // Value badge — only when it's legible AND its coarse grid cell is still free (de-clutter).
      if (R > 10 && zoom > 0.34) {
        const cell = (sx >> 5) + ',' + (sy >> 4);
        if (!cells.has(cell)) {
          cells.add(cell);
          const label = v == null ? '—' : spec.vfmt(spec.accessor(isl));
          if (label) {
            ctx.save();
            ctx.font = '700 12px system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,20,26,0.85)';
            ctx.strokeText(label, sx, sy - r - 9);
            ctx.fillStyle = '#f4fbff';
            ctx.fillText(label, sx, sy - r - 9);
            ctx.restore();
          }
        }
      }
    }
  }

  /** Relational overlay: draw edges BETWEEN islands — alliances/rivalries, trade lanes, aid
   *  convoys. `edges` is the precomputed positioned set from OverlayModel; each is culled in
   *  world space (AABB vs bounds) before projection, so off-screen links cost only that test.
   *  Drawn over the scalar heat and under the ships, so vessels stay readable. Endpoints inset
   *  a touch so a line reads from the coast, not out of the town. */
  drawRelations(edges, bounds, spec, now) {
    if (!edges || !edges.length) return;
    const ctx = this.ctx;
    let maxW = 1;
    for (const e of edges) if (e.weight > maxW) maxW = e.weight; // lane traffic scale
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of edges) {
      if (!segmentInBounds(e.ax, e.ay, e.bx, e.by, bounds)) continue;
      const A = this.camera.worldToScreen(e.ax, e.ay);
      const B = this.camera.worldToScreen(e.bx, e.by);
      let ax = A.sx, ay = A.sy, bx = B.sx, by = B.sy;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const inset = Math.min(16, len * 0.3), ux = dx / len, uy = dy / len;
      ax += ux * inset; ay += uy * inset; bx -= ux * inset; by -= uy * inset;
      let color, width, alpha, dash = null;
      if (e.kind === 'ally') { color = '#8ee6a0'; alpha = 0.3 + e.v * 0.45; width = 1 + e.v * 2.5; }
      else if (e.kind === 'rival') { color = '#ff7b6b'; alpha = 0.3 + e.v * 0.45; width = 1 + e.v * 2.5; }
      else if (e.kind === 'lane') { const n = e.weight / maxW; color = '#6fd0e0'; alpha = 0.22 + n * 0.5; width = 1 + n * 3.5; }
      else if (e.kind === 'aid') { color = '#7fe0b0'; alpha = 0.78; width = 2; dash = [7, 5]; }
      else if (e.kind === 'embargo') { color = '#e0863a'; alpha = 0.72; width = 2; dash = [3, 4]; } // severed trade
      else if (e.kind === 'hunt') { color = '#ff5b4a'; alpha = 0.8; width = 2; } // pirate → prey / besieged port
      else if (e.kind === 'guard') { color = '#6fa8d8'; alpha = 0.75; width = 2; } // privateer → quarry / guarded port
      else continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      if (dash) ctx.setLineDash([]);
    }
    ctx.restore();
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

  /** A warm festive glow and a ring of twinkling lanterns around a port keeping a feast-day. */
  _festivalMark(sx, sy, r, now, seed) {
    const ctx = this.ctx;
    const h = ((typeof seed === 'string' ? seed.charCodeAt(1) : seed) | 0) * 0.9;
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.004 + h);
    ctx.save();
    // warm glow over the port
    ctx.globalAlpha = 0.20 * pulse;
    ctx.fillStyle = '#ffcf5a';
    ctx.shadowColor = '#ffdf7a'; ctx.shadowBlur = r * 0.8;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // a ring of twinkling lanterns (warm reds/golds), each winking on its own phase
    const lanterns = 10;
    for (let i = 0; i < lanterns; i++) {
      const a = (i / lanterns) * Math.PI * 2 + now * 0.0006;
      const tw = 0.5 + 0.5 * Math.sin(now * 0.008 + i * 1.7 + h);
      const lx = sx + Math.cos(a) * r, ly = sy + Math.sin(a) * r;
      ctx.globalAlpha = 0.45 + 0.55 * tw;
      ctx.fillStyle = i % 3 === 0 ? '#ff8a3a' : (i % 3 === 1 ? '#ffd24a' : '#ff5a7a');
      ctx.beginPath(); ctx.arc(lx, ly, 1.5 + 0.9 * tw, 0, Math.PI * 2); ctx.fill();
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

  /** Mutable-industry buildings: draw each INDUSTRIAL workshop (survival goods ride the shore manifest
   *  `_badges`, carrying no status byte `st`, so they're skipped) as a little building whose art STATE
   *  reads its live status — running / idle / disrepair, the last a BROKEN silhouette (a shape change, so
   *  it reads for colour-blind viewers, not just a tint). Each (good,state) silhouette is baked ONCE into
   *  a dedicated sprite cache and blitted (with the running-state chimney smoke frozen into the bake), so
   *  hundreds of works cost a handful of cached tiles + a blit each. LODs away with the town below R<14. */
  _workshops(ctx, isl, L, sx, sy, R) {
    if (R < WORKSHOP_LOD_MIN) return;
    const wsArt = this.art.workshops;
    if (!wsArt || !L.workshops) return;
    const shops = (isl.workshops || []).filter((w) => w.st != null); // industrial works only
    if (!shops.length) return;
    const scale = (R * WORKSHOP_R) / WORKSHOP_BAKE_R; // baked-at-40 → this island's screen radius
    for (let i = 0; i < shops.length && i < L.workshops.length; i++) {
      const w = shops[i];
      const def = wsArt[w.good];
      if (!def) continue;
      const state = WORKSHOP_STATE[w.st] || 'running';
      const p = L.workshops[i];
      const wx = sx + p.dx * R, wy = sy + p.dy * R;
      const tile = this._workshopCache.get(`ws:${w.good}:${state}:${PALETTE_VERSION}`, WORKSHOP_BAKE_W, WORKSHOP_BAKE_H,
        (cctx) => { cctx.translate(WORKSHOP_BAKE_OX, WORKSHOP_BAKE_OY); drawUnifiedArt(cctx, WORKSHOP_BAKE_R, PALETTE.ink, def, state, WORKSHOP_BAKE_NOW, null); });
      if (!tile) continue; // no-canvas (Node) — workshops are browser-only cosmetics
      ctx.drawImage(tile.canvas, wx - WORKSHOP_BAKE_OX * scale, wy - WORKSHOP_BAKE_OY * scale, tile.w * scale, tile.h * scale);
    }
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
    // Workshop anchor spots (one per possible slot) — scattered on the interior like the town, but
    // fewer and larger; the mutable-industry buildings draw at these, filled slots up to slotCap.
    const workshops = [];
    for (let i = 0; i < 6; i++) {
      const a = rng() * Math.PI * 2, rr = 0.16 + rng() * 0.34;
      workshops.push({ dx: Math.cos(a) * rr * ax * 0.82, dy: (Math.sin(a) * rr * ay) * 0.82 - 0.06 });
    }
    // Max silhouette extent (unit-radius) → sizes the baked terrain tile tightly per island.
    let ext = 0.9;
    for (const p of shape) ext = Math.max(ext, Math.abs(p.dx), Math.abs(p.dy));
    // Dock sits on the bay if there is one, else anywhere on the coast.
    L = { shape, ext, town, markers, workshops, dockAngle: bay ? bay.at : rng() * Math.PI * 2 };
    this._islands.set(id, L);
    return L;
  }

  // ─── Wakes / Ships / Selection (declarative art) ─────────────────
  drawWakes(trails, now) { this.effectsRenderer.drawTrails(trails, now); }

  drawShips(shipsById, islandsById, bounds, now, highlightHomeId = null, presentation = null) {
    if (!shipsById) return;
    const zoom = this.camera.getZoom?.() ?? 1;
    this._computeBerths(shipsById, islandsById); // fan docked ships into berths (used for draw + picking)
    for (const id in shipsById) {
      const s = shipsById[id];
      const berth = this._berths.get(id);           // a docked ship draws in its berth, not stacked on the wharf
      const px = berth ? berth.x : s.x, py = berth ? berth.y : s.y;
      if (!inBounds(px, py, SHIP_RADIUS * 1.6, bounds)) continue;
      this._seen.add('s:' + id);
      const def = this.art.ships[s.type] || this.art.ships.ship;
      if (!def) { this._warn('ship:' + s.type, `[WorldRenderer] no ship art for type "${s.type}"`); continue; }
      const home = islandsById && islandsById.get(s.homeId);
      const color = (home && home.color) || PALETTE.accent;
      // A moored ship gets a short mooring line to its island + rides at anchor (heading toward the
      // port, sails furled) — the "docked" cue, and what lets the fleet be picked apart individually.
      if (berth && zoom > 0.4) this._mooringLine(px, py, berth.ix, berth.iy);
      // A selected island's own ships get a bright halo — clamped to a minimum screen size
      // so its whole fleet is trackable across the map even at overview zoom (where a ship
      // is only ~1px). Drawn as a filled disc glow + ring so it pops against the water.
      if (highlightHomeId && s.homeId === highlightHomeId) this._homeRing(px, py, Math.max(SHIP_RADIUS * 1.7 * zoom, 11), now);
      // Sail dye tells faction at a glance: pirate black canvas, privateer naval navy, else home port.
      const sailColor = s.pirate ? PIRATE_SAIL : s.privateer ? PRIVATEER_SAIL : color;
      const r = SHIP_RADIUS * (SHIP_TYPE_SCALE[s.type] || 1); // size reads the hull class
      const heading = berth ? Math.atan2(berth.iy - py, berth.ix - px) : (s.heading || 0); // moored: bow to the wharf
      const state = this._presentationState(id, berth, s, presentation);
      // Overview LOD: a ship shrunk to a speck draws as a flat sail-colour dot instead of full
      // declarative art. The clamped faction markers below still draw, so pirates/privateers/
      // revolts stay spottable at any zoom — only the mass of merchants become cheap dots.
      if (r * zoom < SHIP_LOD_MIN) this._shipDot(px, py, sailColor);
      else this._drawArtAt(def, px, py, r, sailColor, state, now, this._trans('s:' + id), heading);
      // A crew in open revolt (mutiny/defection standoff) — a stark pulsing marker, clamped so
      // it's spotted anywhere on the map even at overview zoom.
      if (s.revolt) this._revoltRing(px, py, Math.max(SHIP_RADIUS * 1.9 * zoom, 13), now);
      // A pirate raised the black flag — a skull marker so predators are spotted anywhere.
      else if (s.pirate) this._pirateMark(px, py, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
      // A commissioned privateer — a naval marker (the hunter) so the law is visible too.
      else if (s.privateer) this._privateerMark(px, py, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
      // A merchant blown off course & lost at sea — a pale, wallowing distress ring so it's spotted (and watchable).
      else if (s.adrift) this._distressMark(px, py, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
      // A ship HOVE TO making repairs — an ADDITIVE badge (its own check, not part of the faction chain above)
      // so a careening pirate keeps its skull AND reads as under repair; drawn warm, to diverge from the
      // cold 'adrift' distress ring (a workmanlike stop, not a helpless one).
      if (s.act === 'careen') this._careenMark(px, py, Math.max(SHIP_RADIUS * 1.9 * zoom, 12), now);
      // COMBAT is now attrition over several seconds — SHOW it: a ship locked onto a foe within gun-range
      // trades rolling broadsides (muzzle flash, cannon smoke, shot, hit spark) so a fight reads as a fight,
      // not two hulls touching then one vanishing.
      const fighting = s.act ? COMBAT_ACTS.has(s.act) : false;
      if (s.act === 'hunt' && s.actId != null) {
        const foe = shipsById[s.actId];
        if (foe && Math.hypot((foe.x || 0) - s.x, (foe.y || 0) - s.y) < COMBAT_VIS_RANGE) this._combatFx(s, foe, now);
      } else if ((s.act === 'assault' || s.act === 'raid') && s.actId != null) {
        // Bombarding an ISLAND (a privateer battering a haven, a pirate sacking a port): trade broadsides
        // with the shore — the boat fires at the walls and the batteries answer (_combatFx draws both ways).
        const isl = islandsById[s.actId];
        if (isl && Math.hypot((isl.x || 0) - s.x, (isl.y || 0) - s.y) < COMBAT_VIS_RANGE) this._combatFx(s, isl, now);
      }
      // Hull/rig condition over any ship that's damaged or in a fight — so a battle's toll is legible on the
      // map. Zoomed IN, the full dual bar; zoomed OUT, a single compact damage dot (the two thin bars turn
      // fiddly at speck size), so a hurt ship still reads at a glance either way. Healthy cruisers show nothing.
      if (fighting || (s.hull != null && s.hull < 0.985) || (s.rig != null && s.rig < 0.985)) {
        if (zoom >= HEALTHBAR_ZOOM_MIN) this._healthBar(px, py, r, s, zoom);
        else if (s.act !== 'careen') this._damageDot(px, py, r, s, zoom, now); // the careen badge stands in for the dot at LOD
      }
    }
  }

  /** Resolve the ART state for a ship: a berthed ship is 'docked'; a ship the scene has flagged as
   *  under fire (its id in the optional `presentation` map, a scene-owned overlay — never a snapshot
   *  field) is 'damaged'; otherwise its own display state. `sinking` is NOT here — a foundering ship
   *  has already vanished from the snapshot and is drawn as a client actor by drawSinkingActors(). */
  _presentationState(id, berth, s, presentation) {
    if (berth) return 'docked';
    if (s.act === 'careen') return 'careening';                   // hove-to, sails furled, jury-rigging (wins over 'damaged')
    if (presentation && presentation.has(id)) return 'damaged';   // transient hit-flash (scene overlay)
    if (s.hull != null && s.hull < 0.5) return 'damaged';         // persistent — a battered hull wears it
    return s.state || 'sailing';
  }

  /** Draw the CLIENT-owned foundering ships (copies made by the scene when a vessel vanished from the
   *  snapshot — never snapshot references). Each renders its authored `sinking` state, whose play-once
   *  clip rolls the hull onto her beam-ends, and fades out over its life so she slips beneath the swell.
   *  `actors` = [{ x, y, heading, type, pirate, privateer, born, ttl, trans }]; culling is the caller's. */
  drawSinkingActors(actors, now) {
    if (!actors || !actors.length) return;
    const zoom = this.camera.getZoom?.() ?? 1;
    const ctx = this.ctx;
    for (const a of actors) {
      const def = this.art.ships[a.type] || this.art.ships.ship;
      if (!def) continue;
      const r = SHIP_RADIUS * (SHIP_TYPE_SCALE[a.type] || 1);
      if (r * zoom < SHIP_LOD_MIN) continue; // a speck-sized wreck isn't worth the art; the splash carries it
      const life = a.ttl ? Math.max(0, 1 - (now - a.born) / a.ttl) : 1;
      const sailColor = a.pirate ? PIRATE_SAIL : a.privateer ? PRIVATEER_SAIL : (a.color || PALETTE.accent);
      ctx.save();
      ctx.globalAlpha = 0.15 + 0.85 * life; // fade as she goes down
      this._drawArtAt(def, a.x, a.y, r, sailColor, 'sinking', now, a.trans || (a.trans = {}), a.heading || 0);
      ctx.restore();
    }
  }

  /** Fan every DOCKED ship (idle at its home, or trading at a stop) into a ring of berths around its
   *  island so a busy port's fleet doesn't stack into one unclickable pile on the wharf. Recomputed
   *  each frame into this._berths (ship id → {x,y,ix,iy}); stable berth order (sorted by id) so a ship
   *  keeps its slot while the dock roster holds. Faction hulls (pirates/privateers) are never berthed —
   *  they're driven by their own AI, not moored as traders. */
  _computeBerths(shipsById, islandsById) {
    this._berths.clear();
    if (!islandsById) return;
    const byIsland = new Map(); // island id → [ship id …]
    for (const id in shipsById) {
      const s = shipsById[id];
      if (s.pirate || s.privateer) continue;
      // Berth every ship that's IN PORT. The client stream carries DISPLAY states (snapshot.js
      // displayState): a ship idle at home reads 'idle'; one trading at a stop reads 'docked' (the
      // sim's 'trading'). Under way is 'sailing'/'outbound'/'inbound' → never berthed. (Accept the raw
      // sim 'trading' too, so this is correct whether fed the wire snapshot or a sim ship directly.)
      if (s.state !== 'idle' && s.state !== 'docked' && s.state !== 'trading') continue;
      let isl = islandsById.get(s.homeId); // fast path: an idle ship rests at home
      if (!isl || Math.hypot(isl.x - s.x, isl.y - s.y) > islandRadius(isl) * 1.6) isl = this._islandAt(s.x, s.y, islandsById);
      if (!isl) continue;
      let arr = byIsland.get(isl.id); if (!arr) byIsland.set(isl.id, arr = []); arr.push(id);
    }
    for (const [islId, ids] of byIsland) {
      const isl = islandsById.get(islId); if (!isl) continue;
      ids.sort();
      const n = ids.length, R = islandRadius(isl), rr = R * 1.2;
      const phase = (isl.x * 0.013 + isl.y * 0.017); // per-island start angle so berths don't all align
      for (let i = 0; i < n; i++) {
        const a = phase + (i / n) * Math.PI * 2;
        this._berths.set(ids[i], { x: isl.x + Math.cos(a) * rr, y: isl.y + Math.sin(a) * rr, ix: isl.x, iy: isl.y });
      }
    }
  }

  /** Nearest island to (x,y) that the point is genuinely AT (docked ships snap to island centre) —
   *  the fallback for a ship docked away from its home port (trading at a stop). O(N) but only hit for
   *  the few ships not resolved by homeId. */
  _islandAt(x, y, islandsById) {
    let best = null, bd = Infinity;
    for (const isl of islandsById.values()) {
      const d = Math.hypot(isl.x - x, isl.y - y);
      if (d < bd) { bd = d; best = isl; }
    }
    return best && bd <= islandRadius(best) * 1.6 ? best : null;
  }

  /** The display position of a ship — its berth slot if docked, else its live position. Used by the
   *  scene's hit-test so a moored ship is clickable where it's actually drawn (in its berth), not
   *  buried under the island. */
  shipDisplayPos(id, ship) {
    const b = this._berths.get(id);
    return b ? { x: b.x, y: b.y } : { x: ship.x, y: ship.y };
  }

  /** A thin mooring line from a berthed ship to its island — the "made fast to the wharf" cue. */
  _mooringLine(px, py, ix, iy) {
    const a = this.camera.worldToScreen(px, py);
    const b = this.camera.worldToScreen(ix, iy);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(230, 214, 170, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    ctx.restore();
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
    drawIcon(ctx, 'sabres', sx, sy - r - 6, Math.max(11, r * 1.15), '#cfe4f6');
    ctx.restore();
  }

  /** Named storm cells — a roiling dark cloud mass over a cold sea-shadow, a scrolling rain veil,
   *  and rare, brief, LOCAL lightning (a thin jagged bolt, never a screen-wide flash). Drawn under
   *  the ships so a vessel caught inside is still visible fighting the weather. Culled by the view. */
  drawStorms(storms, bounds, now) {
    if (!storms || !storms.length) return;
    const ctx = this.ctx;
    const zoom = this.camera.getZoom?.() ?? 1;
    for (const st of storms) {
      if (!inBounds(st.x, st.y, st.r, bounds)) continue;
      const { sx, sy } = this.camera.worldToScreen(st.x, st.y);
      const r = st.r * zoom;
      const seed = hashSeed(st.name || (st.x + ',' + st.y));
      ctx.save();

      // 1) Sea-shadow — the water beneath the cell goes dark and cold (kept translucent at the
      //    core so a ship inside stays readable).
      const shadow = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, r);
      shadow.addColorStop(0, 'rgba(4, 20, 30, 0.48)');
      shadow.addColorStop(0.65, 'rgba(6, 26, 36, 0.32)');
      shadow.addColorStop(1, 'rgba(8, 32, 44, 0)');
      ctx.fillStyle = shadow;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();

      // 2) Rain veil — thin streaks clipped to the cell, scrolling down on a slight lean.
      ctx.save();
      ctx.beginPath(); ctx.arc(sx, sy, r * 0.92, 0, Math.PI * 2); ctx.clip();
      const rain = mulberry(seed ^ 0x51ed);
      const lean = r * 0.32;
      const drift = (now * 0.22) % (r * 2);
      ctx.strokeStyle = 'rgba(176, 202, 226, 0.15)';
      ctx.lineWidth = Math.max(0.6, zoom * 0.9);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 46; i++) {
        const bx = sx - r + rain() * r * 2;
        const span = r * (0.12 + rain() * 0.16);
        const by = sy - r + ((rain() * r * 2 + drift) % (r * 2));
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + lean * (span / r), by + span);
      }
      ctx.stroke();
      ctx.restore();

      // 3) Roiling cloud mass — overlapping dark lobes slowly turning, each with a top-lit roil
      //    highlight, over a denser dark core.
      const spin = now * 0.00006;
      const cloud = mulberry(seed ^ 0x9e37);
      for (let i = 0; i < 7; i++) {
        const a0 = cloud() * Math.PI * 2;
        const dist = r * (0.1 + cloud() * 0.5);
        const a = a0 + spin * (i % 2 ? 1 : -1);
        const lx = sx + Math.cos(a) * dist;
        const ly = sy + Math.sin(a) * dist;
        const pulse = 1 + 0.12 * Math.sin(now * 0.0008 + i * 1.7);
        const lr = r * (0.3 + cloud() * 0.22) * pulse;
        const g = ctx.createRadialGradient(lx, ly, lr * 0.12, lx, ly, lr);
        g.addColorStop(0, 'rgba(22, 28, 42, 0.82)');
        g.addColorStop(0.55, 'rgba(28, 36, 52, 0.46)');
        g.addColorStop(1, 'rgba(34, 44, 62, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill();
        // A tight, brighter roil highlight on the sunlit shoulder so each billow reads.
        const hx = lx - lr * 0.28, hy = ly - lr * 0.32;
        const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, lr * 0.5);
        hg.addColorStop(0, 'rgba(138, 156, 184, 0.34)');
        hg.addColorStop(0.5, 'rgba(120, 138, 166, 0.16)');
        hg.addColorStop(1, 'rgba(120, 138, 166, 0)');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(hx, hy, lr * 0.5, 0, Math.PI * 2); ctx.fill();
      }
      const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.5);
      core.addColorStop(0, 'rgba(16, 20, 30, 0.58)');
      core.addColorStop(1, 'rgba(16, 20, 30, 0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(sx, sy, r * 0.5, 0, Math.PI * 2); ctx.fill();

      // 4) Rare, brief, LOCAL lightning — a thin jagged bolt with a small glow at the strike,
      //    fired only in short windows and offset per storm so cells don't flash in unison.
      const strobe = Math.sin(now * 0.0016 + (seed % 360) * (Math.PI / 180));
      if (strobe > 0.985) {
        const intensity = Math.min(1, (strobe - 0.985) / 0.012);
        const bolt = mulberry((seed ^ 0xb0175) + Math.floor(now / 240));
        const ox = sx + (bolt() - 0.5) * r * 0.8;
        const oy = sy - r * (0.15 + bolt() * 0.3);
        ctx.save();
        ctx.globalAlpha = intensity;
        const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, r * 0.5);
        glow.addColorStop(0, 'rgba(210, 228, 255, 0.5)');
        glow.addColorStop(1, 'rgba(210, 228, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(ox, oy, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(226, 238, 255, 0.95)';
        ctx.lineWidth = Math.max(1, zoom * 1.4);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.shadowColor = 'rgba(180, 210, 255, 0.9)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        let px = ox, py = oy;
        ctx.moveTo(px, py);
        for (let i = 1; i <= 5; i++) {
          px += (bolt() - 0.5) * r * 0.28;
          py += (r * 0.5) / 5;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Label — the ink storm glyph + the cell's name, above the mass.
      const lbl = 'Storm ' + st.name;
      const fs = Math.round(Math.max(11, r * 0.13));
      ctx.fillStyle = 'rgba(214, 224, 238, 0.92)';
      ctx.font = `${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(lbl).width, isz = fs + 3;
      drawIcon(ctx, 'storm', sx - tw / 2 - isz * 0.55, sy - r - 8, isz, 'rgba(214, 224, 238, 0.92)');
      ctx.fillText(lbl, sx - tw / 2 + isz * 0.35, sy - r - 8);
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
    drawIcon(ctx, 'skull', sx, sy - r - 6, Math.max(12, r * 1.25), '#f4f0e6'); // bone-white skull
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
    // crossed-sabres mark above the ring
    ctx.globalAlpha = pulse;
    drawIcon(ctx, 'sabres', sx, sy - r - 6, Math.max(11, r * 0.95), '#ffd166');
    ctx.restore();
  }

  _distressMark(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.005); // slow, wallowing — a ship helpless in the swell
    ctx.save();
    ctx.globalAlpha = 0.2 + 0.12 * pulse;
    ctx.fillStyle = '#8fb6c6';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = '#b6d0dc';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(sx, sy, r * (0.9 + 0.14 * pulse), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.7 + 0.3 * pulse;
    drawIcon(ctx, 'anchor', sx, sy - r - 6, Math.max(11, r * 1.05), '#cfe0e8'); // adrift — no bearings
    ctx.restore();
  }

  /** A ship HOVE TO making repairs — a warm ochre badge (mallet glyph + a solid, steady ring), deliberately
   *  UNLIKE the cold, dashed, slowly-wallowing 'adrift' distress ring: this is a workmanlike stop, under
   *  control, not a helpless one. A slow, faint work-glow pulse so it reads as active labour. */
  _careenMark(wx, wy, r, now) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.004);
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.1 * pulse;
    ctx.fillStyle = '#c98a3a';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#e0a24a';       // SOLID ring (distress is dashed) — a steady, deliberate stop
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.95, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.75 + 0.25 * pulse;
    drawIcon(ctx, 'mallet', sx, sy - r - 6, Math.max(11, r * 1.05), '#f0cd8a'); // shipwright's maul — making repairs
    ctx.restore();
  }

  /** A running gunnery duel between two ships (world coords): both trade rolling broadsides so a fight is
   *  visibly a fight over its several seconds — the client cadence mirrors the sim's ~1.2s combat round. */
  _combatFx(hunter, foe, now) {
    const a = this.camera.worldToScreen(hunter.x, hunter.y);
    const b = this.camera.worldToScreen(foe.x, foe.y);
    const zoom = this.camera.getZoom?.() ?? 1;
    this._broadside(a.sx, a.sy, b.sx, b.sy, now, hunter.id, zoom); // the hunter fires…
    this._broadside(b.sx, b.sy, a.sx, a.sy, now, foe.id, zoom);    // …and the foe returns fire
  }

  /** One ship's side of the duel: a muzzle flash + drifting cannon smoke at the gun, a shot crossing the
   *  gap, and a spark where it strikes — cycling on a per-ship phase so the two hulls hammer out of step. */
  _broadside(sx, sy, tx, ty, now, seed, zoom) {
    const ctx = this.ctx;
    const dx = tx - sx, dy = ty - sy;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const sc = Math.max(0.7, Math.min(1.6, zoom));
    const phase = (hashId(seed) % 1000) / 1000;
    const cyc = (((now || 0) / 1000 / 1.15) + phase) % 1; // 0..1 within a ~1.15s broadside round
    ctx.save();
    // The shot in flight — a glowing ball racing across the first half of the round, with a faint tracer.
    if (cyc < 0.5) {
      const p = cyc / 0.5;
      const bx = sx + dx * p, by = sy + dy * p;
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = '#ffcf8a'; ctx.lineWidth = 1.4 * sc;
      ctx.beginPath(); ctx.moveTo(sx + ux * 8 * sc, sy + uy * 8 * sc); ctx.lineTo(bx, by); ctx.stroke();
      ctx.globalAlpha = 0.85 * (1 - p * 0.25);
      ctx.fillStyle = '#ffd982';
      ctx.beginPath(); ctx.arc(bx, by, 2.1 * sc, 0, Math.PI * 2); ctx.fill();
    }
    // Muzzle flash at the gun, a bright bloom in the first sliver of the round.
    const flash = cyc < 0.12 ? 1 - cyc / 0.12 : 0;
    if (flash > 0) {
      const mx = sx + ux * 9 * sc, my = sy + uy * 9 * sc;
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, 9 * sc);
      g.addColorStop(0, 'rgba(255,244,200,' + (0.95 * flash).toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(255,178,74,' + (0.7 * flash).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.globalAlpha = 1; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(mx, my, 9 * sc, 0, Math.PI * 2); ctx.fill();
    }
    // Cannon smoke drifting off the gun, growing and fading across the round.
    const smoke = cyc < 0.65 ? cyc / 0.65 : 0;
    if (smoke > 0) {
      const px = sx + ux * 11 * sc - uy * 3 * sc, py = sy + uy * 11 * sc + ux * 3 * sc;
      ctx.globalAlpha = 0.2 * (1 - smoke);
      ctx.fillStyle = '#cbd0d6';
      ctx.beginPath(); ctx.arc(px, py, (4 + 9 * smoke) * sc, 0, Math.PI * 2); ctx.fill();
    }
    // The hit — a spark on the target as the ball lands.
    if (cyc >= 0.46 && cyc < 0.58) {
      const hit = 1 - Math.abs(cyc - 0.52) / 0.06;
      ctx.globalAlpha = 0.55 * hit; ctx.fillStyle = '#ff7a3a';
      ctx.beginPath(); ctx.arc(tx, ty, 8 * sc, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9 * hit; ctx.fillStyle = '#ffe6a0';
      ctx.beginPath(); ctx.arc(tx, ty, 4 * sc, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** A compact HULL (green→amber→red) + RIG (teal) bar floating over a damaged or fighting ship, so a
   *  running battle's toll is legible right on the map without opening the panel. */
  _healthBar(px, py, r, s, zoom) {
    const { sx, sy } = this.camera.worldToScreen(px, py);
    const ctx = this.ctx;
    const hull = Math.max(0, Math.min(1, s.hull != null ? s.hull : 1));
    const rig = Math.max(0, Math.min(1, s.rig != null ? s.rig : 1));
    const hullSound = Math.max(0, Math.min(1, s.hullSound != null ? s.hullSound : 1));
    const rigSound = Math.max(0, Math.min(1, s.rigSound != null ? s.rigSound : 1));
    const w = Math.max(15, r * 2 * zoom);
    const x = sx - w / 2, y = sy - Math.max(r * zoom, 8) - 10, bh = 2.6;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 1, y - 1, w + 2, bh * 2 + 4);
    // "Lost capacity" wash from soundness→full (only a dry-dock rebuilds it) — drawn under the health fill.
    ctx.fillStyle = 'rgba(150,72,42,0.7)';
    if (hullSound < 0.995) ctx.fillRect(x + w * hullSound, y, w * (1 - hullSound), bh);
    if (rigSound < 0.995) ctx.fillRect(x + w * rigSound, y + bh + 1, w * (1 - rigSound), bh);
    ctx.fillStyle = hull > 0.6 ? '#5fd06a' : hull > 0.3 ? '#e6b84a' : '#e0503a';
    ctx.fillRect(x, y, w * hull, bh);
    ctx.fillStyle = '#6fb8e0';
    ctx.fillRect(x, y + bh + 1, w * rig, bh);
    ctx.restore();
  }

  /** The zoomed-OUT counterpart to _healthBar: a single small pulsing dot hovering over a hurt ship —
   *  amber when lightly damaged, red when badly (by the worse of hull/rig) — so trouble still reads at a
   *  glance across the map without the fiddly two-bar widget that only earns its keep up close. */
  _damageDot(px, py, r, s, zoom, now) {
    const { sx, sy } = this.camera.worldToScreen(px, py);
    const ctx = this.ctx;
    const hull = Math.max(0, Math.min(1, s.hull != null ? s.hull : 1));
    const rig = Math.max(0, Math.min(1, s.rig != null ? s.rig : 1));
    const sev = Math.min(hull, rig);                 // the worse of the two drives the colour
    const col = sev < 0.4 ? '#e0503a' : '#e6b84a';   // red = badly hurt, amber = lightly (matches the bar)
    const pulse = 0.55 + 0.45 * Math.sin(now * 0.009); // a gentle, unhurried throb
    const y = sy - Math.max(r * zoom, 7) - 6;        // just above the hull, mirroring the bar's offset
    const rad = 2.6;
    ctx.save();
    ctx.globalAlpha = pulse * 0.32;                  // soft halo
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(sx, y, rad * 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55 + 0.4 * pulse;            // solid core with a matching glow
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(sx, y, rad, 0, Math.PI * 2); ctx.fill();
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

  /** Overview LOD stand-in for a ship: a small flat hull-colour dot (no heading, no art interpreter). */
  _shipDot(wx, wy, color) {
    const { sx, sy } = this.camera.worldToScreen(wx, wy);
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
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

/** #rrggbb → rgba() with an alpha (relief overlays lerp toward transparent). */
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Paint an island's static terrain into a tile (world-radius px): damp→dry beach gradient, an
 *  inked coastline, then a grass interior with a sun-corner rim light, an interior/coast shadow
 *  (fakes a domed landmass), and a seeded per-type ground texture. No animation, no shadowBlur —
 *  the animated foam ring + water-shadow are drawn per-frame around this by drawIslands. */
function drawIsleTerrain(cctx, cx, cy, rad, L, isl) {
  // Beach: damp waterline sand at the rim → dry sand inland.
  const beach = cctx.createRadialGradient(cx, cy, rad * 0.5, cx, cy, rad);
  beach.addColorStop(0, PALETTE.beachDry);
  beach.addColorStop(1, PALETTE.beachWet);
  cctx.fillStyle = beach;
  blob(cctx, cx, cy, L.shape, rad); cctx.fill();
  // Inked coastline (ties the world to the captain-portrait linework).
  cctx.save();
  cctx.globalAlpha = 0.55; cctx.strokeStyle = PALETTE.ink; cctx.lineWidth = Math.max(1.4, rad * 0.028);
  blob(cctx, cx, cy, L.shape, rad); cctx.stroke();
  cctx.restore();
  // Grass interior + relief, clipped to the inner silhouette.
  cctx.save();
  blob(cctx, cx, cy, L.shape, rad * 0.8); cctx.clip();
  const bx = cx - rad * 2.4, by = cy - rad * 2.4, bs = rad * 4.8;
  cctx.fillStyle = isl.color || '#8fbf5a';
  cctx.fillRect(bx, by, bs, bs);
  isleTexture(cctx, cx, cy, rad, isl);
  // Sun from the upper-left: a rim light, then a rim shadow that darkens toward the coast.
  const rim = cctx.createLinearGradient(cx - rad, cy - rad, cx + rad * 0.4, cy + rad * 0.5);
  rim.addColorStop(0, rgba(PALETTE.grassRim, 0.55));
  rim.addColorStop(0.6, rgba(PALETTE.grassRim, 0));
  cctx.fillStyle = rim; cctx.fillRect(bx, by, bs, bs);
  const shade = cctx.createRadialGradient(cx - rad * 0.15, cy - rad * 0.15, rad * 0.15, cx, cy, rad * 0.85);
  shade.addColorStop(0, rgba(PALETTE.grassShade, 0));
  shade.addColorStop(1, rgba(PALETTE.grassShade, 0.5));
  cctx.fillStyle = shade; cctx.fillRect(bx, by, bs, bs);
  cctx.restore();
}

/** Seeded, per-type ground texture under the live markers: forest canopy, mining rock, plantation
 *  furrows, ranch pasture, else a faint mottle. Cheap (≤14 dabs), deterministic by island id. */
function isleTexture(cctx, cx, cy, rad, isl) {
  const rng = mulberry(hashSeed(isl.id) ^ 0x9e3779b9);
  const TAU = Math.PI * 2;
  cctx.save();
  switch (isl.type) {
    case 'forest':
      cctx.fillStyle = 'rgba(38,88,50,0.5)';
      for (let i = 0; i < 14; i++) { const a = rng() * TAU, r = rng() * rad * 0.6; cctx.beginPath(); cctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad * (0.08 + rng() * 0.06), 0, TAU); cctx.fill(); }
      break;
    case 'mining':
      cctx.fillStyle = 'rgba(92,98,106,0.5)';
      for (let i = 0; i < 11; i++) { const a = rng() * TAU, r = rng() * rad * 0.55, s = rad * (0.07 + rng() * 0.06); cctx.fillRect(cx + Math.cos(a) * r - s / 2, cy + Math.sin(a) * r - s / 2, s, s); }
      break;
    case 'plantation':
      cctx.strokeStyle = 'rgba(92,120,52,0.4)'; cctx.lineWidth = Math.max(1, rad * 0.03);
      for (let i = -3; i <= 3; i++) { cctx.beginPath(); cctx.moveTo(cx - rad * 0.55, cy + i * rad * 0.16); cctx.lineTo(cx + rad * 0.55, cy + i * rad * 0.16); cctx.stroke(); }
      break;
    case 'ranch':
      cctx.fillStyle = 'rgba(152,172,92,0.28)'; cctx.beginPath(); cctx.ellipse(cx, cy, rad * 0.5, rad * 0.36, 0, 0, TAU); cctx.fill();
      break;
    default:
      cctx.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 6; i++) { const a = rng() * TAU, r = rng() * rad * 0.5; cctx.beginPath(); cctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad * 0.1, 0, TAU); cctx.fill(); }
  }
  cctx.restore();
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
