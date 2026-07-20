// Worn-parchment texture for the HUD's paper surfaces. The panels are canvas-drawn as flat cream
// gradients (theme.js `plate()`, UIStack `Panel.draw()`); on their own they read as parchment-
// *coloured*, not aged paper. This bakes a TILEABLE "aged sheet" texture ONCE to an offscreen
// canvas and paints it as a cached repeat pattern, so a worn panel costs one clipped multiply-fill
// + one soft inner-shadow stroke per frame — no per-frame noise, no image decode, nothing that
// scales with panel count beyond a couple of cheap composites. Game-side only (no engine coupling).
//
// Node-safe: the tile is baked lazily and only when a real 2D canvas exists, so importing this in a
// test runner (no `document`) is inert and `agePaper()` becomes a silent no-op.

const TILE = 256;
const TAU = Math.PI * 2;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Local rounded-rect (a copy of UIStack's) so this module imports NOTHING — keeps it dependency-
// free (no import cycle with UIStack, which itself calls agePaper) and trivially portable.
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Deterministic PRNG — the grain is identical every session (no per-frame shimmer, and no banned
// Math.random). Seed is fixed; the sheet is a constant.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One octave of TILEABLE value noise: an n×n lattice sampled with wrapped indices + smoothstep, so
// sampling at u,v∈[0,1) wraps seamlessly at the tile edges.
function makeLattice(n, rng) { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rng(); return a; }
function sampleN(u, v, lat, n) {
  const x = u * n, y = v * n, x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (i, j) => lat[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  const ab = a + (b - a) * sx, cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}

// Draw a mark plus its 8 wrapped neighbours, so anything crossing an edge tiles seamlessly. The
// callback receives ABSOLUTE coords for each copy; compute colour/size BEFORE calling so every copy
// is identical.
function wrap(x, y, draw) {
  for (let ox = -TILE; ox <= TILE; ox += TILE)
    for (let oy = -TILE; oy <= TILE; oy += TILE)
      draw(x + ox, y + oy);
}

let _tile = null;   // baked offscreen HTMLCanvasElement (or null if no canvas env)
let _pat = null;    // cached CanvasPattern built from _tile
let _baked = false; // so a failed bake isn't retried every frame

function bakeTile() {
  _baked = true;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let cv;
  try {
    cv = document.createElement('canvas');
    cv.width = TILE; cv.height = TILE;
  } catch { return null; }
  const c = cv.getContext && cv.getContext('2d');
  if (!c) return null;
  const rng = mulberry32(0x8EA1);

  // ── Mottle: 3 octaves of wrapped value noise → warm sepia blotches that MULTIPLY-darken the
  //    sheet. Lit paper stays lit (near-white → multiply is a no-op); only the stained low patches
  //    darken, and they lose more blue than red so the shadow reads sepia, not grey. ──
  const l1 = makeLattice(6, rng), l2 = makeLattice(12, rng), l3 = makeLattice(24, rng);
  const img = c.createImageData(TILE, TILE);
  const d = img.data;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const u = x / TILE, v = y / TILE;
      const m = 0.55 * sampleN(u, v, l1, 6) + 0.3 * sampleN(u, v, l2, 12) + 0.15 * sampleN(u, v, l3, 24);
      const dark = Math.max(0, 0.52 - m) * 2.2;      // 0 on lit paper … ~1 in the deepest stain
      const i = (y * TILE + x) * 4;
      d[i] = 255 - dark * 42; d[i + 1] = 255 - dark * 55; d[i + 2] = 255 - dark * 78; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  // ── Paper fibres: faint short strokes at random angles, edge-wrapped so the repeat seam hides. ──
  c.lineCap = 'round';
  for (let i = 0; i < 54; i++) {
    const x = rng() * TILE, y = rng() * TILE, ang = rng() * Math.PI, len = 7 + rng() * 22;
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    c.strokeStyle = `rgba(74,52,26,${(0.03 + rng() * 0.03).toFixed(3)})`;
    c.lineWidth = 0.6 + rng() * 0.7;
    wrap(x, y, (px, py) => { c.beginPath(); c.moveTo(px, py); c.lineTo(px + dx, py + dy); c.stroke(); });
  }

  // ── Foxing: a handful of soft age-spots. Kept sparse + low-alpha so running text stays legible. ──
  for (let i = 0; i < 7; i++) {
    const x = rng() * TILE, y = rng() * TILE, r = 10 + rng() * 22, a = (0.06 + rng() * 0.05).toFixed(3);
    wrap(x, y, (px, py) => {
      const g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(96,60,22,${a})`);
      g.addColorStop(1, 'rgba(96,60,22,0)');
      c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
    });
  }
  return cv;
}

// ─── Burned edges (pirate-map scorch) ────────────────────────────────────────────────────────
// A charred + singed rim that's UNEVEN — heavy at the corners and a few random hotspots, absent
// along other stretches — so it reads as a naturally burnt map, not a uniform frame. It depends on
// panel size, so it can't share the one parchment tile; instead we bake it per size and LRU-cache
// it, painting each panel with a single drawImage/frame. The scorch is built from two pre-baked
// brush sprites (dark char, warm ember) stamped along the perimeter — no per-dab gradient work.

let _charB = null, _emberB = null;
function makeBrush(rgb) {
  const S = 64, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(${rgb},0.95)`); g.addColorStop(0.55, `rgba(${rgb},0.45)`); g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g; c.beginPath(); c.arc(S / 2, S / 2, S / 2, 0, TAU); c.fill();
  return cv;
}
function charBrush() { if (!_charB) _charB = makeBrush('30,17,8'); return _charB; }     // near-black scorch
function emberBrush() { if (!_emberB) _emberB = makeBrush('122,56,16'); return _emberB; } // warm singe glow

// Sample the rounded-rect perimeter as points carrying an INWARD normal + a corner flag.
function roundRectPerimeter(w, h, r, step) {
  const pts = [];
  const line = (x0, y0, x1, y1, nx, ny) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = 0; i < n; i++) { const t = i / n; pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, nx, ny, corner: false }); }
  };
  const arc = (cx, cy, a0, a1) => {
    const n = Math.max(1, Math.round((Math.abs(a1 - a0) * r) / step));
    for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, nx: -Math.cos(a), ny: -Math.sin(a), corner: true }); }
  };
  line(r, 0, w - r, 0, 0, 1);              arc(w - r, r, -Math.PI / 2, 0);
  line(w, r, w, h - r, -1, 0);             arc(w - r, h - r, 0, Math.PI / 2);
  line(w - r, h, r, h, 0, -1);             arc(r, h - r, Math.PI / 2, Math.PI);
  line(0, h - r, 0, r, 1, 0);              arc(r, r, Math.PI, Math.PI * 1.5);
  return pts;
}

// Smooth pseudo-random burn intensity around the perimeter (a few summed sines, size-seeded phases)
// plus a corner boost, so hotspots land unevenly and the corners almost always scorch.
function burnField(pts, seed) {
  const rng = mulberry32(seed);
  const p1 = rng() * TAU, p2 = rng() * TAU, p3 = rng() * TAU;
  const f1 = 3 + Math.floor(rng() * 3), f2 = 7 + Math.floor(rng() * 5), f3 = 15 + Math.floor(rng() * 8);
  const N = pts.length;
  return pts.map((pt, i) => {
    const t = i / N;
    const n = 0.55 * Math.sin(t * TAU * f1 + p1) + 0.3 * Math.sin(t * TAU * f2 + p2) + 0.18 * Math.sin(t * TAU * f3 + p3);
    return (0.5 + 0.5 * n / 1.03) * 0.9 + (pt.corner ? 0.22 : 0);
  });
}

function bakeBurn(w, h, r, dpr, intensity) {
  let cv;
  try { cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); } catch { return null; }
  const c = cv.getContext && cv.getContext('2d'); if (!c) return null;
  c.scale(dpr, dpr);
  const rr = Math.min(r, w / 2, h / 2);
  roundRect(c, 0, 0, w, h, rr); c.clip();   // keep the scorch ON the sheet; its inner edge stays ragged
  const charB = charBrush(), emberB = emberBrush();
  const pts = roundRectPerimeter(w, h, rr, 4);
  const field = burnField(pts, (0x51ED ^ Math.imul(w | 0, 73856093) ^ Math.imul(h | 0, 19349663)) >>> 0);
  const RMAX = Math.min(24, 9 + Math.min(w, h) * 0.03);
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i], hot = smoothstep(0.62, 1, field[i]) * intensity;
    if (hot <= 0.02) continue;
    const rad = 5 + RMAX * hot;
    // dark char sitting on the rim (biased slightly outward so the blackest line is the paper's edge)
    c.globalAlpha = Math.min(0.88, 0.35 + 0.6 * hot);
    c.drawImage(charB, pt.x - pt.nx * rad * 0.15 - rad, pt.y - pt.ny * rad * 0.15 - rad, rad * 2, rad * 2);
    // warm singe glow just inside the char
    const er = rad * 0.7;
    c.globalAlpha = Math.min(0.5, 0.14 + 0.4 * hot);
    c.drawImage(emberB, pt.x + pt.nx * rad * 0.5 - er, pt.y + pt.ny * rad * 0.5 - er, er * 2, er * 2);
    // a hot near-black core at the deepest spots
    if (hot > 0.55) { const kr = rad * 0.5; c.globalAlpha = (hot - 0.55) * 0.9; c.drawImage(charB, pt.x - kr, pt.y - kr, kr * 2, kr * 2); }
  }
  c.globalAlpha = 1;
  return { canvas: cv, w, h };
}

const _burnCache = new Map();
const BURN_CACHE_MAX = 24;
// A cached burned-edge tile for (w,h,r,intensity). Sizes are quantised to 2px so a panel that jitters
// by a pixel doesn't thrash the cache; a small LRU caps memory.
function getBurnTile(w, h, r, intensity) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const qw = Math.round(w / 2) * 2, qh = Math.round(h / 2) * 2;
  const key = `${qw}x${qh}x${r}x${intensity.toFixed(2)}x${dpr}`;
  const hit = _burnCache.get(key);
  if (hit) { _burnCache.delete(key); _burnCache.set(key, hit); return hit; }  // LRU touch
  const tile = bakeBurn(qw, qh, r, dpr, intensity);
  if (!tile) return null;
  _burnCache.set(key, tile);
  if (_burnCache.size > BURN_CACHE_MAX) _burnCache.delete(_burnCache.keys().next().value);
  return tile;
}

/** The baked parchment tile as a cached repeat `CanvasPattern`, or null in a no-canvas environment.
 *  Built once; reused for every panel. */
export function parchmentPattern(ctx) {
  if (_pat) return _pat;
  if (!_baked) _tile = bakeTile();
  if (!_tile) return null;
  try { _pat = ctx.createPattern(_tile, 'repeat'); } catch { _pat = null; }
  return _pat;
}

/** Overlay the worn-parchment texture + aged/burnt edges INSIDE a rounded-rect paper panel whose
 *  cream body is already filled. Cheap and self-contained (saves/restores its own state).
 *    opts.tex    grain strength 0..1  (default 0.55)
 *    opts.edge   soft inner-rim darkness 0..1, 0 disables (default 0.4) — ignored when `burn` is on
 *    opts.burn   true → paint the uneven pirate-map scorch (cached per size) instead of the soft rim
 *    opts.burnIntensity  scorch strength 0..1 (default 1)
 *  The grain pattern is anchored to the CANVAS origin, so the sheet sits still in screen space and
 *  two panels at different positions never show the same grain. */
export function agePaper(ctx, x, y, w, h, r = 10, opts = {}) {
  const pat = parchmentPattern(ctx);
  if (!pat) return;                     // no-canvas env, or pattern unsupported → skip silently
  const tex = opts.tex ?? 0.55, edge = opts.edge ?? 0.4;
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  // Grain — multiply so lit paper is untouched and only the stains/fibres darken the sheet.
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = tex;
  ctx.fillStyle = pat;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (opts.burn) {
    // Uneven charred/singed rim (corner-heavy). Baked once per size, so this is one drawImage.
    const tile = getBurnTile(w, h, r, opts.burnIntensity ?? 1);
    if (tile) ctx.drawImage(tile.canvas, x, y, w, h);
  } else if (edge > 0) {
    // Handled, darkened edges — an inner shadow: stroke a path JUST OUTSIDE the clip so only its soft
    // blur bleeds inward (one op, hugs the rounded corners, no per-edge gradients).
    ctx.shadowColor = `rgba(56,38,16,${edge})`;
    ctx.shadowBlur = 11;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(56,38,16,0.5)';
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, r + 3);
    ctx.stroke();
  }
  ctx.restore();
}
