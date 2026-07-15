// Vector "ink" icon kit — crisp, hand-drawn canvas glyphs that replace the emoji the HUD
// used to draw as text (☠ ⚔ ⛈ 🌱☀🍂❄ 🏴‍☠ 📜 🔥 ⚑ ⏸ ▶ …). Emoji render differently on every
// platform and read as programmer-art; these are authored in the same round-cap / round-join,
// slightly-tapered idiom as the captain portraits (InkRenderer) so world + UI feel hand-drawn.
//
// Each icon fn draws in a unit box centred at the origin (coords in ~[-s, s], s = size/2) and
// takes the pen colour; the caller supplies centre + size + colour. Glyphs that carve NEGATIVE
// SPACE (skull sockets, coin emboss) use `destination-out`, which only works on a transparent
// surface — so drawIcon rasterises through a SpriteCache tile (transparent by default) and blits,
// never carving a hole in the panel behind them. In Node (no canvas) it falls back to a direct
// draw (pixels aren't asserted there).

import { SpriteCache } from '/engine/render/SpriteCache.js';
import { PALETTE, PALETTE_VERSION } from '../config.js';

const TAU = Math.PI * 2;
const _cache = new SpriteCache({ max: 128 });

/** Draw icon `name` centred at (x,y) in a size×size box, in `color`. `opts` is passed to the icon. */
export function drawIcon(ctx, name, x, y, size, color, opts) {
  const fn = ICONS[name];
  if (!fn) return;
  const s = Math.max(1, size);
  const key = `${name}|${Math.round(s)}|${color}|${opts && opts.accent ? opts.accent : ''}|${PALETTE_VERSION}`;
  const tile = _cache.get(key, s, s, (c, w, h) => {
    c.save();
    c.translate(w / 2, h / 2);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    fn(c, w / 2, color, opts || {});
    c.restore();
  });
  if (tile) { ctx.drawImage(tile.canvas, x - s / 2, y - s / 2, s, s); return; }
  // Node / no-canvas fallback: draw straight to the target (save/restore also restores the
  // composite op the negative-space glyphs flip).
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  fn(ctx, s / 2, color, opts || {});
  ctx.restore();
}

export function hasIcon(name) { return !!ICONS[name]; }

// ─── the glyph registry (unit box, origin centre, s = half-size) ─────────────
const ICONS = {
  // Skull-and-bones: inked cranium + jaw, sockets/nose carved by negative space.
  skull(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.60 * s, -0.02 * s);
    ctx.bezierCurveTo(-0.64 * s, -0.78 * s, 0.64 * s, -0.78 * s, 0.60 * s, -0.02 * s);
    ctx.bezierCurveTo(0.60 * s, 0.30 * s, 0.36 * s, 0.34 * s, 0.32 * s, 0.56 * s);
    ctx.lineTo(0.16 * s, 0.56 * s); ctx.lineTo(0.10 * s, 0.34 * s);
    ctx.lineTo(-0.10 * s, 0.34 * s); ctx.lineTo(-0.16 * s, 0.56 * s);
    ctx.lineTo(-0.32 * s, 0.56 * s);
    ctx.bezierCurveTo(-0.36 * s, 0.34 * s, -0.60 * s, 0.30 * s, -0.60 * s, -0.02 * s);
    ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.ellipse(-0.26 * s, -0.06 * s, 0.18 * s, 0.22 * s, -0.15, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0.26 * s, -0.06 * s, 0.18 * s, 0.22 * s, 0.15, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, 0.0); ctx.lineTo(0.08 * s, 0.20 * s); ctx.lineTo(-0.08 * s, 0.20 * s); ctx.closePath(); ctx.fill();
  },
  // Crossed sabres — two curved blades + guards.
  sabres(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.3, 0.14 * s * 2);
    for (const d of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(d * -0.60 * s, 0.60 * s);
      ctx.quadraticCurveTo(d * 0.05 * s, -0.02 * s, d * 0.66 * s, -0.62 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(d * -0.34 * s, 0.12 * s); ctx.lineTo(d * -0.08 * s, 0.40 * s); ctx.stroke();
    }
  },
  // Shield — a rounded crest.
  shield(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -0.66 * s);
    ctx.lineTo(0.6 * s, -0.44 * s);
    ctx.lineTo(0.52 * s, 0.28 * s);
    ctx.quadraticCurveTo(0.28 * s, 0.62 * s, 0, 0.72 * s);
    ctx.quadraticCurveTo(-0.28 * s, 0.62 * s, -0.52 * s, 0.28 * s);
    ctx.lineTo(-0.6 * s, -0.44 * s);
    ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(1, 0.1 * s * 2); ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.moveTo(0, -0.34 * s); ctx.lineTo(0, 0.42 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-0.32 * s, 0.02 * s); ctx.lineTo(0.32 * s, 0.02 * s); ctx.stroke();
  },
  // Storm cloud + bolt.
  storm(ctx, s, color, opts) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(-0.30 * s, -0.02 * s, 0.30 * s, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(0.0 * s, -0.30 * s, 0.36 * s, Math.PI * 1.0, TAU);
    ctx.arc(0.36 * s, -0.02 * s, 0.26 * s, Math.PI * 1.5, Math.PI * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = opts.accent || PALETTE.accent;
    ctx.beginPath();
    ctx.moveTo(0.04 * s, 0.06 * s); ctx.lineTo(-0.14 * s, 0.10 * s); ctx.lineTo(0.04 * s, 0.62 * s);
    ctx.lineTo(-0.02 * s, 0.30 * s); ctx.lineTo(0.18 * s, 0.28 * s); ctx.closePath(); ctx.fill();
  },
  // Season — sprout (spring).
  sprout(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, 0.13 * s * 2);
    ctx.beginPath(); ctx.moveTo(0, 0.62 * s); ctx.lineTo(0, -0.2 * s); ctx.stroke();
    ctx.fillStyle = color;
    for (const d of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(0, -0.02 * s);
      ctx.quadraticCurveTo(d * 0.5 * s, -0.14 * s, d * 0.56 * s, -0.5 * s);
      ctx.quadraticCurveTo(d * 0.16 * s, -0.34 * s, 0, -0.02 * s);
      ctx.closePath(); ctx.fill();
    }
  },
  // Season — sun (summer).
  sun(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.1, 0.11 * s * 2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 0.5 * s, Math.sin(a) * 0.5 * s);
      ctx.lineTo(Math.cos(a) * 0.72 * s, Math.sin(a) * 0.72 * s);
      ctx.stroke();
    }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, 0.34 * s, 0, TAU); ctx.fill();
  },
  // Season — leaf (autumn).
  leaf(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.5 * s, 0.5 * s);
    ctx.quadraticCurveTo(-0.6 * s, -0.5 * s, 0.5 * s, -0.55 * s);
    ctx.quadraticCurveTo(0.55 * s, 0.5 * s, -0.5 * s, 0.5 * s);
    ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 0.08 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.42 * s, 0.42 * s); ctx.lineTo(0.42 * s, -0.44 * s); ctx.stroke();
  },
  // Season — snowflake (winter).
  snowflake(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, 0.1 * s * 2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const ex = Math.cos(a) * 0.66 * s, ey = Math.sin(a) * 0.66 * s;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ex, ey); ctx.stroke();
      for (const t of [0.4, 0.66]) {
        const bx = Math.cos(a) * t * s, by = Math.sin(a) * t * s, bl = 0.2 * s;
        ctx.beginPath();
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a + 1) * bl, by + Math.sin(a + 1) * bl);
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a - 1) * bl, by + Math.sin(a - 1) * bl);
        ctx.stroke();
      }
    }
  },
  // Flag on a staff (a swallowtail; `opts.skull` adds a bone-white skull dot for the black flag).
  flag(ctx, s, color, opts) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, 0.11 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.5 * s, 0.7 * s); ctx.lineTo(-0.5 * s, -0.7 * s); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.5 * s, -0.66 * s);
    ctx.lineTo(0.6 * s, -0.5 * s);
    ctx.lineTo(0.42 * s, -0.24 * s);
    ctx.lineTo(0.62 * s, 0.0 * s);
    ctx.lineTo(-0.5 * s, 0.02 * s);
    ctx.closePath(); ctx.fill();
    if (opts.skull) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(0.02 * s, -0.32 * s, 0.13 * s, 0, TAU); ctx.fill();
    }
  },
  // Wheat stalk (blight / harvest).
  wheat(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.1, 0.1 * s * 2);
    ctx.beginPath(); ctx.moveTo(0, 0.66 * s); ctx.lineTo(0, -0.3 * s); ctx.stroke();
    ctx.fillStyle = color;
    for (const y of [-0.5, -0.24, 0.02]) {
      for (const d of [1, -1]) {
        ctx.beginPath();
        ctx.ellipse(d * 0.2 * s, y * s, 0.12 * s, 0.22 * s, d * 0.6, 0, TAU);
        ctx.fill();
      }
    }
  },
  // Scroll / contract.
  scroll(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.fillRect(-0.44 * s, -0.44 * s, 0.88 * s, 0.88 * s);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 0.08 * s * 2);
    for (const y of [-0.2, 0.04, 0.28]) { ctx.beginPath(); ctx.moveTo(-0.28 * s, y * s); ctx.lineTo(0.28 * s, y * s); ctx.stroke(); }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(0, -0.5 * s, 0.5 * s, 0.14 * s, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, 0.5 * s, 0.5 * s, 0.14 * s, 0, 0, TAU); ctx.fill();
  },
  // Flame (rebellion / fire).
  flame(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -0.7 * s);
    ctx.bezierCurveTo(0.5 * s, -0.2 * s, 0.5 * s, 0.5 * s, 0, 0.66 * s);
    ctx.bezierCurveTo(-0.5 * s, 0.5 * s, -0.5 * s, -0.1 * s, -0.06 * s, -0.2 * s);
    ctx.bezierCurveTo(-0.02 * s, 0.05 * s, 0.14 * s, 0.05 * s, 0.12 * s, -0.16 * s);
    ctx.bezierCurveTo(0.1 * s, -0.4 * s, 0, -0.5 * s, 0, -0.7 * s);
    ctx.closePath(); ctx.fill();
  },
  // Four-point sparkle (boom / prosperity).
  spark(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2);
      const ox = Math.cos(a), oy = Math.sin(a);
      const px = Math.cos(a + Math.PI / 4) * 0.16 * s, py = Math.sin(a + Math.PI / 4) * 0.16 * s;
      if (i === 0) ctx.moveTo(ox * 0.7 * s, oy * 0.7 * s); else ctx.lineTo(ox * 0.7 * s, oy * 0.7 * s);
      ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  },
  // Pennant on a short staff (danger flag).
  pennant(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.1, 0.1 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.4 * s, 0.66 * s); ctx.lineTo(-0.4 * s, -0.66 * s); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.4 * s, -0.62 * s); ctx.lineTo(0.6 * s, -0.24 * s); ctx.lineTo(-0.4 * s, 0.14 * s);
    ctx.closePath(); ctx.fill();
  },
  pause(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.fillRect(-0.42 * s, -0.5 * s, 0.3 * s, 1.0 * s);
    ctx.fillRect(0.12 * s, -0.5 * s, 0.3 * s, 1.0 * s);
  },
  play(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.36 * s, -0.5 * s); ctx.lineTo(0.5 * s, 0); ctx.lineTo(-0.36 * s, 0.5 * s);
    ctx.closePath(); ctx.fill();
  },
  // Coin (gold / trade) — disc with an embossed inner ring.
  coin(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, 0.66 * s, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 0.09 * s * 2);
    ctx.beginPath(); ctx.arc(0, 0, 0.4 * s, 0, TAU); ctx.stroke();
  },
  // Anchor (wreck / settlers / port).
  anchor(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, 0.12 * s * 2);
    ctx.beginPath(); ctx.moveTo(0, -0.5 * s); ctx.lineTo(0, 0.5 * s); ctx.stroke();       // shank
    ctx.beginPath(); ctx.moveTo(-0.3 * s, -0.32 * s); ctx.lineTo(0.3 * s, -0.32 * s); ctx.stroke(); // stock
    ctx.beginPath();
    ctx.moveTo(-0.5 * s, 0.1 * s);
    ctx.quadraticCurveTo(-0.5 * s, 0.6 * s, 0, 0.62 * s);
    ctx.quadraticCurveTo(0.5 * s, 0.6 * s, 0.5 * s, 0.1 * s);
    ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, -0.5 * s, 0.14 * s, 0, TAU); ctx.fill(); // ring
  },
  chevronUp(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.3, 0.16 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.44 * s, 0.24 * s); ctx.lineTo(0, -0.28 * s); ctx.lineTo(0.44 * s, 0.24 * s); ctx.stroke();
  },
  chevronDown(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.3, 0.16 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.44 * s, -0.24 * s); ctx.lineTo(0, 0.28 * s); ctx.lineTo(0.44 * s, -0.24 * s); ctx.stroke();
  },
  // Right-pointing caret (activity ▸).
  caret(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(-0.24 * s, -0.42 * s); ctx.lineTo(0.34 * s, 0); ctx.lineTo(-0.24 * s, 0.42 * s); ctx.closePath(); ctx.fill();
  },
  // Warning triangle with bang.
  warning(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -0.6 * s); ctx.lineTo(0.62 * s, 0.5 * s); ctx.lineTo(-0.62 * s, 0.5 * s);
    ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1.2, 0.13 * s * 2);
    ctx.beginPath(); ctx.moveTo(0, -0.16 * s); ctx.lineTo(0, 0.16 * s); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0.34 * s, 0.02 * s, 0, TAU); ctx.stroke();
  },
  // Crosshatch square (data-overlay legend ▧).
  hatch(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, 0.09 * s * 2);
    ctx.strokeRect(-0.5 * s, -0.5 * s, s, s);
    ctx.save();
    ctx.beginPath(); ctx.rect(-0.5 * s, -0.5 * s, s, s); ctx.clip();
    for (let o = -1; o <= 1; o += 0.34) { ctx.beginPath(); ctx.moveTo((o - 0.5) * s, 0.5 * s); ctx.lineTo((o + 0.5) * s, -0.5 * s); ctx.stroke(); }
    ctx.restore();
  },
  // Crowd (population / people total) — three overlapping heads-and-shoulders.
  crowd(ctx, s, color) {
    ctx.fillStyle = color;
    for (const [ox, oy, r] of [[-0.32, 0.02, 0.2], [0.32, 0.02, 0.2], [0, -0.08, 0.24]]) {
      ctx.beginPath(); ctx.arc(ox * s, oy * s, r * s, 0, TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo((ox - r) * s, (oy + r * 2.4) * s);
      ctx.quadraticCurveTo(ox * s, (oy + r * 0.6) * s, (ox + r) * s, (oy + r * 2.4) * s);
      ctx.closePath(); ctx.fill();
    }
  },
  // Chain link (relations overlay) — two interlocking rings.
  link(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, 0.12 * s * 2);
    ctx.beginPath(); ctx.ellipse(-0.22 * s, 0, 0.34 * s, 0.22 * s, 0, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0.22 * s, 0, 0.34 * s, 0.22 * s, 0, 0, TAU); ctx.stroke();
  },
  // Push-pin (history-panel pin toggle).
  pin(ctx, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.1, 0.1 * s * 2);
    ctx.beginPath(); ctx.moveTo(0, 0.1 * s); ctx.lineTo(0, 0.64 * s); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(0, -0.22 * s, 0.34 * s, 0.28 * s, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -0.5 * s, 0.2 * s, 0.14 * s, 0, 0, TAU); ctx.fill();
  },
  // Folded map (world-history title).
  map(ctx, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.6 * s, -0.4 * s); ctx.lineTo(-0.2 * s, -0.52 * s); ctx.lineTo(0.2 * s, -0.4 * s);
    ctx.lineTo(0.6 * s, -0.52 * s); ctx.lineTo(0.6 * s, 0.4 * s); ctx.lineTo(0.2 * s, 0.52 * s);
    ctx.lineTo(-0.2 * s, 0.4 * s); ctx.lineTo(-0.6 * s, 0.52 * s); ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 0.07 * s * 2);
    ctx.beginPath(); ctx.moveTo(-0.2 * s, -0.5 * s); ctx.lineTo(-0.2 * s, 0.42 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.2 * s, -0.42 * s); ctx.lineTo(0.2 * s, 0.5 * s); ctx.stroke();
  },
};
