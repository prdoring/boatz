// Composes a captain's head-and-shoulders portrait from layered nautical art parts
// (shoulders → head → hair → beard → face → headgear) via the brush-ink renderer
// (InkRenderer.js). A captain carries deterministic "genes" (floats 0..1 per slot, rolled in
// game/sim/captains.js); this maps each gene to a concrete art id and to a palette colour, so
// the same captain always draws the same face. Head parts share one coordinate frame; the
// shoulders sit in a frame just below. Each distinct portrait rasterises once to a cached tile
// (the ink is time-independent), then blits — cheap enough to show many at once. Never touches
// the engine.

import { inkDraw } from './InkRenderer.js';

// Head-part frame, the neck frame (necklaces sit here, over the collar), and the shoulders
// frame (offset below, larger). The head is drawn a touch bigger than a pure head-and-
// shoulders so the face reads as a closeup over richly-decorated shoulders (Ref-2 framing).
const HEAD = { dy: -0.28, r: 1.0 };
const NECK = { dy: 0.55, r: 1.0 };
const SHOULDERS = { dy: 0.88, r: 1.3 };
// A shoulder pet perches UP on the shoulder beside the neck — its own frame, higher than the
// deep shoulders frame, so a parrot/monkey sits on the shoulder rather than sliding to the hem.
const PET = { dy: 0.42, r: 1.0 };
const FRAME = {
  neckBase: HEAD, shoulders: SHOULDERS, shoulderPet: PET, neck: NECK,
  head: HEAD, hair: HEAD, beard: HEAD, face: HEAD, faceMark: HEAD, earring: HEAD, mouth: HEAD, hat: HEAD,
};
// Draw order (back → front) and which collection each gene draws from. `neckBase` (a skin neck)
// is drawn FIRST so the coat collar and the head both overlap it — bridging chin → collar so the
// head never looks severed above the shoulders.
const ORDER = ['neckBase', 'shoulders', 'shoulderPet', 'neck', 'head', 'hair', 'beard', 'face', 'faceMark', 'earring', 'mouth', 'hat'];
const COLLECTION = {
  head: 'heads', face: 'faces', hair: 'hairs', beard: 'facialHair', hat: 'headgear', shoulders: 'shoulders',
  neckBase: 'neckBases', shoulderPet: 'shoulderPets', neck: 'necks', earring: 'earrings', faceMark: 'faceMarks', mouth: 'mouths',
};

// Palettes indexed by a captain's colour genes (kept in the client — the sim stays art-agnostic).
// hat/plume/metal used to be fixed constants; they are now gene-driven for strong variance.
const SKIN = ['#f2d3b3', '#e7b892', '#d79c6d', '#c0844f', '#a06a3c', '#7f4f30', '#5f3a22', '#caa079', '#b07a4c', '#8a5a38'];
const HAIR = ['#1b1712', '#241c14', '#3a2a18', '#5a4326', '#7a5a30', '#9a7b4a', '#b08a52', '#9a9088', '#c9c1b2', '#ddd6c6', '#8a3a24', '#a8442a', '#4a4a4e'];
const COAT = ['#2c3d5e', '#1f2a44', '#6a2a24', '#4a1e1a', '#2e4a34', '#20362a', '#23252c', '#37605e', '#2a5150', '#5a3a22', '#5a2a44', '#3a4654', '#6a5a2a', '#4a2d5a'];
const ACCENT = ['#b03428', '#8a2420', '#2a5a8a', '#c8a24a', '#3a7a4a', '#2f6d5a', '#7a3a5a', '#c86a2a', '#5a3a8a', '#b0872a'];
// Hat leather/felt, feather plume, and metal (gold ↔ silver ↔ iron) — new palettes.
const HAT = ['#1e1a16', '#2a231b', '#3b2a1a', '#4a3420', '#5a4028', '#5a2420', '#25352a', '#22283a', '#3a3a40', '#6a5a44'];
const PLUME = ['#efe6cf', '#f5f0e2', '#a83228', '#7a2820', '#2f7d4a', '#2a5a8a', '#26221c', '#c8a24a', '#2f6d6a', '#6a3a7a'];
const METAL = ['#c8a24a', '#d8b45a', '#b08a3a', '#cbcbd0', '#9a9a94', '#6a6a66'];
const FIXED = { ink: '#241a12', paper: '#f2ead2' };
const DEFAULT_GENES = {
  head: 0, face: 0, hair: 0.3, beard: 0, hat: 0, shoulders: 0, skin: 0.3, hairCol: 0.2, coatCol: 0, accentCol: 0,
  hatCol: 0.2, plumeCol: 0, metalCol: 0, earring: 0, faceMark: 0, mouth: 0, neck: 0, shoulderPet: 0,
};

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
  // NOTE: the first ten draws MUST stay in this order — appending new genes below keeps every
  // existing seed's head/face/hair/beard/hat/shoulders + base colours identical; they only gain
  // the new accessory + colour-variance slots on top.
  return {
    head: rng(), face: rng(), hair: rng(), beard: rng(), hat: rng(), shoulders: rng(),
    skin: rng(), hairCol: rng(), coatCol: rng(), accentCol: rng(),
    hatCol: rng(), plumeCol: rng(), metalCol: rng(),
    earring: rng(), faceMark: rng(), mouth: rng(), neck: rng(), shoulderPet: rng(),
  };
}

export class PortraitRenderer {
  constructor(art) { this.art = art; this._cache = new Map(); this._cacheable = undefined; }

  // Pick an art id from a collection by gene. When a `flavor` is given (pirate/navy/official/
  // common), restrict to parts whose `flavors` array includes it — parts with no `flavors` tag
  // are universal. If nothing matches (a sparse collection), fall back to the whole set so a
  // slot never renders empty. The gene indexes into the (possibly filtered) list.
  _pick(collection, gene, flavor) {
    const col = this.art[collection];
    if (!col) return null;
    let ids = Object.keys(col);
    if (!ids.length) return null;
    if (flavor) {
      const matching = ids.filter((id) => { const fl = col[id].flavors; return !fl || fl.includes(flavor); });
      if (matching.length) ids = matching;
    }
    return col[at(ids, gene)];
  }

  _roles(g) {
    return {
      ...FIXED,
      skin: at(SKIN, g.skin), hair: at(HAIR, g.hairCol), coat: at(COAT, g.coatCol), accent: at(ACCENT, g.accentCol),
      hat: at(HAT, g.hatCol), plume: at(PLUME, g.plumeCol),
      metal: at(METAL, g.metalCol), trim: at(METAL, g.metalCol), // trim tracks metal so buttons/braid match
    };
  }

  /** Draw a portrait centred at (x,y), overall radius r. `spec` is a portrait seed int or a
   *  genes object. `flavor` (pirate/navy/official/common) biases which parts are eligible.
   *  Uses a cached tile when possible. */
  draw(ctx, x, y, r, spec, now = 0, flavor = null) {
    const g = typeof spec === 'number' ? genesFromSeed(spec) : (spec || DEFAULT_GENES);
    if (!this._canCache()) { this._paint(ctx, x, y, r, g, now, flavor); return; }
    const rk = Math.max(1, Math.round(r));
    const dpr = this._dpr();
    const key = (typeof spec === 'number' ? spec : JSON.stringify(g)) + '|' + rk + '|' + dpr + '|' + (flavor || '');
    const tile = this._tile(key, rk, dpr, g, flavor);
    ctx.drawImage(tile.canvas, x - tile.half, y - tile.half, tile.size, tile.size);
  }

  _paint(ctx, x, y, r, g, now, flavor) {
    const roles = this._roles(g);
    for (const slot of ORDER) {
      const def = this._pick(COLLECTION[slot], g[slot], flavor);
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

  _tile(key, rk, dpr, g, flavor) {
    const hit = this._cache.get(key);
    if (hit) { this._cache.delete(key); this._cache.set(key, hit); return hit; }
    // The composition reaches ~1.34·r downward (loaded shoulders) and ~1.29·r upward (a tall
    // feather plume above the hat); a square half-box of 1.62·r + 6 covers it with margin.
    const half = Math.ceil(1.62 * rk + 6);
    const size = half * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = canvas.width;
    const cctx = canvas.getContext('2d');
    cctx.scale(dpr, dpr);
    this._paint(cctx, half, half, rk, g, 0, flavor);
    const tile = { canvas, half, size };
    this._cache.set(key, tile);
    if (this._cache.size > CACHE_MAX) this._cache.delete(this._cache.keys().next().value);
    return tile;
  }
}
