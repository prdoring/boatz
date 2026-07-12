// Composes a captain's head-and-shoulders portrait from layered nautical art parts
// (shoulders → head → hair → beard → face → headgear) via the brush-ink renderer
// (InkRenderer.js). A captain carries deterministic "genes" (floats 0..1 per slot, rolled in
// game/sim/captains.js); this maps each gene to a concrete art id and to a palette colour, so
// the same captain always draws the same face. Head parts share one coordinate frame; the
// shoulders sit in a frame just below. Each distinct portrait rasterises once to a cached tile
// (the ink is time-independent), then blits — cheap enough to show many at once. Never touches
// the engine.

import { inkDraw } from './InkRenderer.js';

// Head-part frame vs. the shoulders frame (offset below, slightly larger).
const HEAD = { dy: -0.30, r: 0.78 };
const SHOULDERS = { dy: 0.66, r: 1.05 };
const FRAME = { shoulders: SHOULDERS, head: HEAD, hair: HEAD, beard: HEAD, face: HEAD, hat: HEAD };
// Draw order (back → front) and which collection each gene draws from.
const ORDER = ['shoulders', 'head', 'hair', 'beard', 'face', 'hat'];
const COLLECTION = { head: 'heads', face: 'faces', hair: 'hairs', beard: 'facialHair', hat: 'headgear', shoulders: 'shoulders' };

// Palettes indexed by a captain's colour genes (kept in the client — the sim stays art-agnostic).
const SKIN = ['#e7b892', '#d79c6d', '#c0844f', '#a06a3c', '#7f4f30', '#caa079', '#b07a4c'];
const HAIR = ['#241c14', '#3a2a18', '#5a4326', '#7a5a30', '#9a9088', '#ddd6c6', '#8a3a24', '#4a4a4e'];
const COAT = ['#2c3d5e', '#6a2a24', '#2e4a34', '#23252c', '#37605e', '#5a3a22', '#5a2a44', '#3a4654'];
const ACCENT = ['#b03428', '#2a5a8a', '#c8a24a', '#3a7a4a', '#7a3a5a', '#c86a2a'];
const FIXED = { ink: '#241a12', trim: '#c8a24a', metal: '#ccc4b0', hat: '#2a231b', paper: '#f2ead2' };
const DEFAULT_GENES = { head: 0, face: 0, hair: 0.3, beard: 0, hat: 0, shoulders: 0, skin: 0.3, hairCol: 0.2, coatCol: 0, accentCol: 0 };

const CACHE_MAX = 48;
const at = (list, g) => list[Math.min(list.length - 1, Math.floor((g || 0) * list.length))];

// A captain carries a single portrait SEED int (rolled in the sim); the ten genes are derived
// from it here, so the wire stays tiny and the client owns the look. mulberry32 PRNG.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function genesFromSeed(seed) {
  const rng = mulberry32((seed >>> 0) || 1);
  return { head: rng(), face: rng(), hair: rng(), beard: rng(), hat: rng(), shoulders: rng(), skin: rng(), hairCol: rng(), coatCol: rng(), accentCol: rng() };
}

export class PortraitRenderer {
  constructor(art) { this.art = art; this._cache = new Map(); this._cacheable = undefined; }

  _pick(collection, gene) {
    const col = this.art[collection];
    if (!col) return null;
    const ids = Object.keys(col);
    return ids.length ? col[at(ids, gene)] : null;
  }

  _roles(g) {
    return { ...FIXED, skin: at(SKIN, g.skin), hair: at(HAIR, g.hairCol), coat: at(COAT, g.coatCol), accent: at(ACCENT, g.accentCol) };
  }

  /** Draw a portrait centred at (x,y), overall radius r. `spec` is a portrait seed int or a
   *  genes object. Uses a cached tile when possible. */
  draw(ctx, x, y, r, spec, now = 0) {
    const g = typeof spec === 'number' ? genesFromSeed(spec) : (spec || DEFAULT_GENES);
    if (!this._canCache()) { this._paint(ctx, x, y, r, g, now); return; }
    const rk = Math.max(1, Math.round(r));
    const dpr = this._dpr();
    const key = (typeof spec === 'number' ? spec : JSON.stringify(g)) + '|' + rk + '|' + dpr;
    const tile = this._tile(key, rk, dpr, g);
    ctx.drawImage(tile.canvas, x - tile.half, y - tile.half, tile.size, tile.size);
  }

  _paint(ctx, x, y, r, g, now) {
    const roles = this._roles(g);
    for (const slot of ORDER) {
      const def = this._pick(COLLECTION[slot], g[slot]);
      if (!def || !def.shapes || !def.shapes.length) continue;
      const fr = FRAME[slot];
      ctx.save();
      ctx.translate(x, y + fr.dy * r);
      inkDraw(ctx, fr.r * r, roles, def, 'neutral', now);
      ctx.restore();
    }
  }

  // ─── offscreen tile cache ────────────────────────────────────────
  _canCache() {
    if (this._cacheable === undefined) {
      this._cacheable = false;
      try {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          this._cacheable = !!(c && typeof c.getContext === 'function' && c.getContext('2d'));
        }
      } catch { this._cacheable = false; }
    }
    return this._cacheable;
  }

  _dpr() { return Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)); }

  _tile(key, rk, dpr, g) {
    const hit = this._cache.get(key);
    if (hit) { this._cache.delete(key); this._cache.set(key, hit); return hit; }
    // The composition reaches ~1.45·r downward (shoulders) and ~1.0·r upward (a tall hat);
    // a square half-box of 1.5·r + 6 covers it with the centre at the tile centre.
    const half = Math.ceil(1.5 * rk + 6);
    const size = half * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = canvas.width;
    const cctx = canvas.getContext('2d');
    cctx.scale(dpr, dpr);
    this._paint(cctx, half, half, rk, g, 0);
    const tile = { canvas, half, size };
    this._cache.set(key, tile);
    if (this._cache.size > CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
    return tile;
  }
}
