// UI design tokens + a few pure drawing helpers — the one place the canvas HUD gets its
// type scale, spacing, radii, semantic colours, and the shared "chart frame" plate. This is
// tokens + helpers, NOT a layout/theming engine (UIStack stays the widget spine); it exists so
// the ~57 ad-hoc ctx.font/fillStyle call sites stop each inventing their own weight/size/hex.
//
// Look: INK ON PARCHMENT — warm aged-paper panels (legible over bright water) framed by a DOUBLE
// ink rule (dark outer edge + faint inner hairline) and a set-in sepia-brass cartouche, echoing
// the hand-inked captain portraits. Event-kind colours/icons live in eventKinds.js (shared with
// the history UI); this module owns everything else.

import { PALETTE } from '../config.js';
import { roundRect } from './UIStack.js';
import { agePaper } from './parchment.js';

export { PALETTE, roundRect };

// ─── Type ────────────────────────────────────────────────────────────────────
export const FONT = {
  // "Weathered ink": IM Fell (a 1600s press face) carries the whole HUD; mono numerals stay
  // tabular. Self-hosted woff2 in game/fonts (see index.html @font-face). IM Fell has NO bold cut,
  // so hierarchy comes from the SC (small-caps) display face + size, never font-weight.
  sans: 'system-ui, sans-serif',                              // legacy fallback (no role targets it now)
  serif: '"IM Fell English", Georgia, "Times New Roman", serif',
  display: '"IM Fell English SC", "IM Fell English", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};

// Named roles. Display (SC caps) for titles/headings/section labels; serif for running text;
// mono for numerals. Sizes run a touch larger than the old sans scale — IM Fell sets small.
export const TYPE = {
  title:    { size: 21,   weight: 400, font: 'display' },
  heading:  { size: 16,   weight: 400, font: 'display' },
  label:    { size: 13.5, weight: 400, font: 'serif' },
  body:     { size: 13,   weight: 400, font: 'serif' },
  small:    { size: 12.5, weight: 400, font: 'serif' },
  section:  { size: 11,   weight: 400, font: 'display' },
  badge:    { size: 11.5, weight: 400, font: 'display' },
  num:      { size: 13,   weight: 400, font: 'mono' },
  numSmall: { size: 11.5, weight: 400, font: 'mono' },
};
/** CSS font string for a TYPE role. A weight override is honoured only for faces that HAVE other
 *  weights (sans/mono); IM Fell (display/serif) is 400-only, so overrides are ignored there to
 *  avoid muddy faux-bold on the canvas. */
export function font(role, weight) {
  const t = TYPE[role] || TYPE.body;
  const w = (t.font === 'display' || t.font === 'serif') ? 400 : (weight || t.weight);
  return `${w} ${t.size}px ${FONT[t.font]}`;
}

// ─── Handwriting "hands" for the ship's-log (InfoPanel Story tab) ──────────────
// Each captain/magistrate carries a stable voiceSeed (game/sim/captains.js). The log renders a
// keeper's span in a hand chosen by that seed, so their prose VOICE and their HANDWRITING are one
// identity, and the hand changes at every regime handover. Self-hosted woff2 (see index.html).
export const HANDS = [
  '"Caveat", cursive',
  '"Kalam", cursive',
  '"Shadows Into Light", cursive',
  '"Patrick Hand", cursive',
  '"Reenie Beanie", cursive',
  '"Cedarville Cursive", cursive',
];
function handHash(seed) { let x = (seed >>> 0) || 0; x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0; return (x ^ (x >>> 15)) >>> 0; }
/** Index into HANDS for a keeper `seed`. `avoid` (the previous keeper's index) nudges to a
 *  different hand, so a handover ALWAYS visibly changes hand while a given keeper stays stable. */
export function handIndex(seed, avoid) {
  let i = handHash(seed) % HANDS.length;
  if (avoid != null && i === avoid) i = (i + 1) % HANDS.length;
  return i;
}
/** A CSS font string for keeper `seed` at `size`px (handwriting reads larger than body text). */
export function hand(seed, size = 14, avoid) { return `${size}px ${HANDS[handIndex(seed, avoid)]}`; }

export const SPACE  = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 };
export const RADIUS = { button: 7, card: 10, chip: 8, pill: 8, banner: 6, gauge: 3, tile: 8 };

// ─── Non-event semantic maps (migrated from InfoPanel; one source) ────────────
// Semantic hues DARKENED for legibility on cream parchment (were pastels tuned for a dark panel).
export const GOAL = {
  food: { label: 'Importing food', color: '#c0561c' },
  migrate: { label: 'Carrying migrants', color: '#356291' },
  buyShip: { label: 'Buying a ship', color: '#8a6220' },
  trade: { label: 'Trading', color: '#2f7d45' },
  scout: { label: 'Scouting prices', color: '#5f47a0' },
  aid: { label: 'Aid convoy for an ally', color: '#2d8060' },
};
export const SHIP_STATE = { idle: 'In port', sailing: 'Sailing', docked: 'Docked' };
export const STATE_COLOR = { idle: '#5a6b70', sailing: '#1f7f8c', docked: '#356291' };
export const RESOURCE = {
  Grain: '#96751a', Wood: '#3a7d2f', Meat: '#96602f', Fiber: '#5f7020', Iron: '#586470', PreciousMetal: '#6f7885',
  Food: '#9c6414', Ale: '#7a4f1e', Clothing: '#9a3a66', Weapons: '#464c54', LuxuryGoods: '#8f7a10', Ships: '#8a6220',
};
export function resourceColor(g) { return RESOURCE[g] || PALETTE.panelText; }

// ─── Drawing helpers ──────────────────────────────────────────────────────────
const GOLD_LINE = 'rgba(120, 84, 30, 0.42)';   // the cartouche's inner gilt hairline (sepia-brass on parchment)

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
    g.addColorStop(0, PALETTE.panelPaperHi);
    g.addColorStop(0.6, '#ecdcb2');
    g.addColorStop(1, PALETTE.panelPaperLo);
    ctx.fillStyle = g;
  }
  ctx.fill();
  // Worn-paper grain + aged edges, clipped to the body (skip tiny controls; go lighter on the
  // translucent overlay plates so text stays readable over the sea). Baked once — see parchment.js.
  if (w >= 100 && h >= 40 && opts.aged !== false) {
    const burn = opts.burn ?? big;   // big cartouche panels read as burnt maps; small chips just age
    agePaper(ctx, x, y, w, h, r, {
      tex: opts.fill ? 0.42 : 0.55,
      burn,
      burnIntensity: opts.burnIntensity ?? 0.85,
      edge: big ? 0.36 : 0.28,
    });
  }
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
      ctx.fillStyle = PALETTE.panelAccent;
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
  ctx.fillStyle = PALETTE.panelAccent;
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
    g.addColorStop(0, 'rgba(156, 109, 36, 0.32)'); g.addColorStop(1, 'rgba(120, 84, 30, 0.18)');
    ctx.fillStyle = g;
  } else ctx.fillStyle = PALETTE.panelInset;
  ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = active ? PALETTE.panelAccent : PALETTE.panelEdge; ctx.stroke();
  ctx.fillStyle = active ? '#3a2a12' : PALETTE.panelDim;
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, cy + 0.5);
  ctx.restore();
  return w;
}
