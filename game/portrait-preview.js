// Dev-only harness (NOT shipped in the game). Renders a grid of portraits so the nautical
// vector art in data/portrait-art.json can be iterated visually: one row per role flavor
// (pirate / navy / official / common), one column per seed — the SAME seed across a column,
// so role-biasing (how a hat/coat/accessory pool shifts by flavor) is easy to eyeball.
// Draws each cell exactly as the InfoPanel does (clipped parchment swatch, portrait centred).

import portraitArt from '/data/portrait-art.json' with { type: 'json' };
import { PortraitRenderer } from '/game/PortraitRenderer.js';

const FLAVORS = ['pirate', 'navy', 'official', 'common'];
const COLS = 14;
const CELL = 108;      // grid cell (px)
const SWATCH = 88;     // the in-game portrait swatch size
const LABEL_W = 92;    // left gutter for the flavor label
const HEAD_H = 26;     // top strip for seed labels

const portraits = new PortraitRenderer(portraitArt);
const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');

// Same rounded-rect the panel uses to frame a portrait.
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Deterministic per-column seed, mixed with a page-level base so Reseed shows fresh faces.
function seedFor(base, col) {
  return (Math.imul(col + 1, 2654435761) ^ base) >>> 0;
}

function render(base) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = LABEL_W + COLS * CELL + 8;
  const H = HEAD_H + FLAVORS.length * CELL + 8;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Column headers (seed, hex).
  ctx.fillStyle = '#b9ad93';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let col = 0; col < COLS; col++) {
    const x = LABEL_W + col * CELL + CELL / 2;
    ctx.fillText('#' + seedFor(base, col).toString(16).slice(0, 6), x, HEAD_H / 2);
  }

  FLAVORS.forEach((flavor, row) => {
    const cy = HEAD_H + row * CELL;
    // Row label.
    ctx.fillStyle = '#e9dcbb';
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(flavor, 8, cy + CELL / 2);

    for (let col = 0; col < COLS; col++) {
      const seed = seedFor(base, col);
      const x = LABEL_W + col * CELL + (CELL - SWATCH) / 2;
      const y = cy + (CELL - SWATCH) / 2;
      ctx.save();
      roundRect(ctx, x, y, SWATCH, SWATCH, 10);
      ctx.fillStyle = '#e9dcbb';
      ctx.fill();
      ctx.clip();
      portraits.draw(ctx, x + SWATCH / 2, y + SWATCH * 0.53, SWATCH * 0.40, seed, 0, flavor);
      ctx.restore();
      roundRect(ctx, x, y, SWATCH, SWATCH, 10);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });
}

let base = 0x1a2b3c;
render(base);

// Deterministic-ish reseed for manual iteration (LCG step).
function reseed() { base = (Math.imul(base, 1103515245) + 12345) >>> 0; render(base); }
document.getElementById('reseed').addEventListener('click', reseed);
window.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); reseed(); } });

// Expose for the headless screenshot helper to force a known base.
window.__renderPortraits = (b) => { base = b >>> 0; render(base); };

// Detail mode: one flavor, big swatches, many seeds — for close inspection of accessories.
window.__detail = (flavor, b = base) => {
  base = b >>> 0;
  const cols = 8, rows = 3, cell = 200, sw = 176;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cols * cell + 16, H = 34 + rows * cell + 16;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#2a2622'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e9dcbb'; ctx.font = '16px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('flavor: ' + flavor, 10, 18);
  for (let i = 0; i < cols * rows; i++) {
    const seed = seedFor(base, i + 1);
    const x = 8 + (i % cols) * cell + (cell - sw) / 2;
    const y = 34 + Math.floor(i / cols) * cell + (cell - sw) / 2;
    ctx.save();
    roundRect(ctx, x, y, sw, sw, 12); ctx.fillStyle = '#e9dcbb'; ctx.fill(); ctx.clip();
    portraits.draw(ctx, x + sw / 2, y + sw * 0.53, sw * 0.40, seed, 0, flavor);
    ctx.restore();
    roundRect(ctx, x, y, sw, sw, 12); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
  }
};
