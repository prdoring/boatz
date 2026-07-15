// The living sea — a painterly water surface drawn UNDER the islands each frame (inserted in
// SimScene.render between beginFrame() and drawIslands). Three cheap SCREEN-SPACE passes, so the
// whole thing costs O(viewport), independent of the 9600×6800 ocean and the island count:
//   A. a radial "sun-pool" depth gradient (open sea reads deeper than the sunlit band)
//   B. a wind-driven field of short inked crest strokes (skipped when zoomed out)
//   C. drifting sun-glitter, reusing the engine BackgroundRenderer (retuned OCEAN_LAYERS)
// Plus an optional, tasteful atmosphere tint (season + storms).
//
// This lives in game/ (the sea, wind and seasons are game concepts); the engine
// BackgroundRenderer stays a generic parallax tiler, injected here for the glitter. It takes an
// explicit ctx so the shot harness (whose "canvas" is a plain {width,height}) can reuse it.

import { PALETTE, SEA } from './config.js';

const SEASON_TINT = { Spring: '#d8f0c0', Summer: '#ffe6a8', Autumn: '#f0b070', Winter: '#bfe0ea' };

export class SeaRenderer {
  /** @param camera Camera (logical _vw/_vh) · @param ctx 2D context · @param background BackgroundRenderer|null (glitter) */
  constructor(camera, ctx, background) {
    this.camera = camera;
    this.ctx = ctx;
    this.background = background || null;
  }

  /** Paint the sea for this frame. `wind` = { dir, str }, `season` = { name }, `storms` = [...]. */
  draw(now, _bounds, wind, season, storms) {
    const ctx = this.ctx;
    const W = this.camera._vw ? this.camera._vw() : this.camera.canvas.width;
    const H = this.camera._vh ? this.camera._vh() : this.camera.canvas.height;
    const zoom = this.camera.getZoom ? this.camera.getZoom() : 1;

    // ── Pass A: depth gradient (sun-pool high, deep at the edges) ──
    ctx.save();
    const g = ctx.createRadialGradient(W * 0.5, H * 0.28, 0, W * 0.5, H * 0.28, Math.hypot(W, H) * 0.72);
    g.addColorStop(0, PALETTE.seaMid);
    g.addColorStop(0.55, PALETTE.seaDeep);
    g.addColorStop(1, PALETTE.seaAbyss);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // ── Optional atmosphere: season tint + a cool overcast when storms are abroad ──
    if (SEA.atmosphere) {
      const tint = season && SEASON_TINT[season.name];
      if (tint) { ctx.save(); ctx.globalAlpha = 0.05; ctx.fillStyle = tint; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      const n = storms ? storms.length : 0;
      if (n >= 3) { ctx.save(); ctx.globalAlpha = Math.min(0.07, 0.02 + n * 0.008); ctx.fillStyle = '#39485a'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    }

    // ── Pass B: wind crest field ──
    this._waves(now, wind, W, H, zoom);

    // ── Pass C: sun glitter (engine parallax specks) ──
    if (this.background) this.background.draw(now);
  }

  /** Short bowed crest strokes on a stable screen-cell grid, in a wind-aligned rotated frame so
   *  they run ALONG the crests (⊥ to the wind) and scroll downwind. Faded out toward WAVE_MIN_ZOOM. */
  _waves(now, wind, W, H, zoom) {
    if (zoom < SEA.WAVE_MIN_ZOOM || !wind || wind.str < 0.05) return;
    const ctx = this.ctx;
    const lodK = Math.min(1, Math.max(0, (zoom - SEA.WAVE_MIN_ZOOM) / 0.2)); // cross-fade 0.3→0.5
    const str = Math.min(1, wind.str);
    const cell = SEA.WAVE_CELL;
    const D = Math.hypot(W, H) / 2 + cell; // cover the rotated viewport
    const drift = (now / 1000) * SEA.WAVE_DRIFT * (0.35 + 0.65 * str);
    const span = 2 * D;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((wind.dir || 0) + Math.PI / 2); // strokes ⊥ to the wind
    ctx.lineCap = 'round';
    for (let gx = -D; gx <= D; gx += cell) {
      const ix = Math.round(gx / cell);
      for (let gy = -D; gy <= D; gy += cell) {
        const iy = Math.round(gy / cell);
        const r1 = hash2(ix, iy), r2 = hash2(ix + 53, iy - 17);
        // scroll along the wind axis (the rotated y), wrapped seamlessly
        let y = (gy - drift) % span; if (y < -D) y += span; if (y > D) y -= span;
        const x = gx + (r1 - 0.5) * cell * 0.6;
        y += (r2 - 0.5) * cell * 0.5;
        const len = SEA.WAVE_LEN * (0.7 + r1 * 0.6);
        const bow = (r2 - 0.5) * len * 0.5;
        const phase = ix * 12.9 + iy * 7.3;
        // A baseline so even light airs texture the water; wind strength adds on top.
        const a = SEA.WAVE_ALPHA * (0.4 + 0.6 * str) * lodK * (0.65 + 0.35 * Math.sin(now * 0.0016 + phase));
        if (a <= 0.012) continue;
        // trough (dark ink, nudged down) then the lit crest on top
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 1.6;
        crest(ctx, x - len / 2, y + 1.6, x + len / 2, y + 1.6, bow);
        ctx.globalAlpha = a;
        ctx.strokeStyle = r1 > 0.72 ? PALETTE.seaGlint : PALETTE.foam; ctx.lineWidth = 1.2;
        crest(ctx, x - len / 2, y, x + len / 2, y, bow);
      }
    }
    ctx.restore();
  }
}

function crest(ctx, x0, y0, x1, y1, bow) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - bow, x1, y1);
  ctx.stroke();
}

// Stable 0..1 hash of two integer cell indices (no per-frame shimmer).
function hash2(a, b) {
  const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
