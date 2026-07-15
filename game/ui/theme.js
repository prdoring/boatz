// UI design tokens + a few pure drawing helpers — the one place the canvas HUD gets its
// type scale, spacing, radii, semantic colours, and the shared "chart frame" plate. This is
// tokens + helpers, NOT a layout/theming engine (UIStack stays the widget spine); it exists so
// the ~57 ad-hoc ctx.font/fillStyle call sites stop each inventing their own weight/size/hex.
//
// Look: dark teal glass panels (legible over bright water) framed by a DOUBLE ink rule — a
// bright outer edge + a dark inner hairline — echoing the hand-inked captain portraits, with
// parchment as an accent surface. Event-kind colours/icons live in eventKinds.js (shared with
// the history UI); this module owns everything else.

import { PALETTE } from '../config.js';
import { roundRect } from './UIStack.js';

export { PALETTE, roundRect };

// ─── Type ────────────────────────────────────────────────────────────────────
export const FONT = {
  sans: 'system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};

// Named roles = the de-facto scale distilled from the current call sites.
export const TYPE = {
  title:    { size: 19,   weight: 600, font: 'sans' },
  heading:  { size: 15,   weight: 600, font: 'sans' },
  label:    { size: 13,   weight: 400, font: 'sans' },
  body:     { size: 12.5, weight: 400, font: 'sans' },
  small:    { size: 12,   weight: 400, font: 'sans' },
  section:  { size: 10.5, weight: 600, font: 'sans' },
  badge:    { size: 11,   weight: 600, font: 'sans' },
  num:      { size: 13,   weight: 400, font: 'mono' },
  numSmall: { size: 11.5, weight: 400, font: 'mono' },
};
/** CSS font string for a TYPE role (optionally override weight). */
export function font(role, weight) {
  const t = TYPE[role] || TYPE.body;
  return `${weight || t.weight} ${t.size}px ${FONT[t.font]}`;
}

export const SPACE  = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 };
export const RADIUS = { button: 7, card: 10, chip: 8, pill: 8, banner: 6, gauge: 3, tile: 8 };

// ─── Non-event semantic maps (migrated from InfoPanel; one source) ────────────
export const GOAL = {
  food: { label: 'Importing food', color: '#ff9d5c' },
  migrate: { label: 'Carrying migrants', color: '#8fc6ff' },
  buyShip: { label: 'Buying a ship', color: '#c8a06a' },
  trade: { label: 'Trading', color: '#8ee6a0' },
  scout: { label: 'Scouting prices', color: '#c8b3ff' },
  aid: { label: 'Aid convoy for an ally', color: '#7fe0b0' },
};
export const SHIP_STATE = { idle: 'In port', sailing: 'Sailing', docked: 'Docked' };
export const STATE_COLOR = { idle: '#9fb6bd', sailing: '#5fd0e0', docked: '#8fc6ff' };
export const RESOURCE = {
  Grain: '#e2c85a', Wood: '#5fb84f', Meat: '#cf9b6a', Fiber: '#a8c85a', Iron: '#9aa6b2', PreciousMetal: '#dfe4ec',
  Food: '#e0a83f', Ale: '#b07a3a', Clothing: '#d06a9a', Weapons: '#7f8790', LuxuryGoods: '#ffe36a', Ships: '#c8a06a',
};
export function resourceColor(g) { return RESOURCE[g] || PALETTE.panelText; }

// ─── Drawing helpers ──────────────────────────────────────────────────────────
const GOLD_LINE = 'rgba(200, 162, 74, 0.42)';   // the cartouche's inner gilt hairline

/** The chart-frame plate — a lacquered-teal cartouche: a top-lit depth gradient body, a bright
 *  outer rule, and (on larger panels) a set-in GILT inner frame pinned by small brass corner knots,
 *  so a panel reads as a crafted instrument, not a flat div. `opts`:
 *  { radius, fill (skip the gradient), edge, inner:false, corners (force on/off) }. */
export function plate(ctx, x, y, w, h, opts = {}) {
  const r = opts.radius ?? RADIUS.card;
  const big = w > 150 && h > 66;
  const corners = opts.corners ?? big;
  ctx.save();
  // Body — a top-lit lacquer gradient (or an explicit translucent fill for overlays like the crawl).
  roundRect(ctx, x, y, w, h, r);
  if (opts.fill) ctx.fillStyle = opts.fill;
  else {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(13, 56, 67, 0.95)');
    g.addColorStop(0.55, 'rgba(7, 40, 49, 0.94)');
    g.addColorStop(1, 'rgba(4, 26, 33, 0.96)');
    ctx.fillStyle = g;
  }
  ctx.fill();
  // Outer bright rule.
  roundRect(ctx, x, y, w, h, r);
  ctx.lineWidth = 1.5; ctx.strokeStyle = opts.edge ?? PALETTE.panelEdge; ctx.stroke();
  if (opts.inner === false) { ctx.restore(); return; }
  if (big) {
    // Set-in gilt frame + brass corner knots (the cartouche cue).
    const gi = 5, ri = Math.max(2, r - 3);
    roundRect(ctx, x + gi, y + gi, w - 2 * gi, h - 2 * gi, ri);
    ctx.lineWidth = 1; ctx.strokeStyle = GOLD_LINE; ctx.stroke();
    if (corners) {
      ctx.fillStyle = PALETTE.accentDim;
      for (const [kx, ky] of [[x + gi, y + gi], [x + w - gi, y + gi], [x + gi, y + h - gi], [x + w - gi, y + h - gi]]) {
        ctx.beginPath();
        ctx.moveTo(kx, ky - 2.6); ctx.lineTo(kx + 2.6, ky); ctx.lineTo(kx, ky + 2.6); ctx.lineTo(kx - 2.6, ky);
        ctx.closePath(); ctx.fill();
      }
    }
  } else {
    // Small pills: a plain dark inner hairline for depth.
    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, Math.max(1, r - 2));
    ctx.lineWidth = 1; ctx.strokeStyle = PALETTE.panelInk; ctx.stroke();
  }
  ctx.restore();
}

/** A tapered ink section divider (thin→thicker→thin), the InkRenderer idiom, cheap. */
export function inkRule(ctx, x0, x1, y, color = PALETTE.panelEdge) {
  const mid = (x0 + x1) / 2;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineCap = 'round';
  ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.globalAlpha = 0.9; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(x0 + (mid - x0) * 0.35, y); ctx.lineTo(x1 - (x1 - mid) * 0.35, y); ctx.stroke();
  ctx.restore();
}

/** A small-caps-ish section heading: a gilt letter-spaced label with a tapered ink rule filling the
 *  rest of the line. Advances/returns nothing — the caller owns layout `y`. */
export function sectionHeading(ctx, x, x1, y, label) {
  ctx.save();
  ctx.font = font('section', 700);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.accentDim;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText(label.toUpperCase(), x, y);
  const lw = ctx.measureText(label.toUpperCase()).width + (label.length + 1) * 1.5;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const rx = x + lw + 8;
  if (rx < x1 - 6) inkRule(ctx, rx, x1, y, GOLD_LINE);
  ctx.restore();
}

/** A filter/stat pill drawn at (x, cy-center). Returns its width so callers advance + hit-test.
 *  `opts`: { active, role, height }. One implementation for NewsPanel + InfoPanel chips. */
export function chip(ctx, x, cy, label, opts = {}) {
  const h = opts.height ?? 19;
  ctx.save();
  ctx.font = font(opts.role || 'badge');
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 18;
  const active = !!opts.active;
  const y = cy - h / 2;
  roundRect(ctx, x, y, w, h, RADIUS.chip);
  if (active) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(255, 209, 102, 0.30)'); g.addColorStop(1, 'rgba(200, 162, 74, 0.16)');
    ctx.fillStyle = g;
  } else ctx.fillStyle = PALETTE.panelInset;
  ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = active ? PALETTE.accent : PALETTE.panelEdge; ctx.stroke();
  ctx.fillStyle = active ? '#ffe9a8' : PALETTE.panelDim;
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, cy + 0.5);
  ctx.restore();
  return w;
}
