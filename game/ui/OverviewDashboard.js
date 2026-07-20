// The world ALMANAC — a left-docked UIStack Panel that turns the map overview from "tint the
// islands" into a real strategic dashboard. It reads the same throttled OverlayModel the map
// paints from (never the socket/sim), so it costs nothing extra, and shows:
//   • a header — the day/season + world totals (gold, ships, people, pirates…);
//   • a "what's on fire" trouble strip (starving / rebelling / havens / lawless);
//   • the ACTIVE metric's distribution — the live min ‹ median › max with the same heat ramp;
//   • a categorized metric PICKER (chips — switches the whole overlay) and a scrollable
//     LEADERBOARD of the best/worst ports, each row click-to-fly-to.
//
// Transport-agnostic like InfoPanel/NewsPanel: the scene injects every dependency as a closure.

import { Panel, roundRect } from './UIStack.js';
import { ScrollBox } from './scroll.js';
import { PALETTE } from '../config.js';
import { plate, chip as themeChip, sectionHeading, font as tfont } from './theme.js';
import { drawIcon } from './icons.js';
import { seasonIcon } from './eventKinds.js';
import { heatColor, neutralColor, normalize } from '../overlays.js';

const W = 286;
const PAD = 12;
const EDGE_KEY = { ally: ['#8ee6a0', 'ally'], rival: ['#ff7b6b', 'rival'], lane: ['#6fd0e0', 'trade lane'], aid: ['#7fe0b0', 'relief'], embargo: ['#e0863a', 'embargo'], hunt: ['#ff5b4a', 'pirate hunt'], guard: ['#6fa8d8', 'privateer patrol'] };

function shortGold(v) {
  v = Math.round(v || 0);
  const a = Math.abs(v);
  return (a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1000 ? (v / 1000).toFixed(a >= 1e5 ? 0 : 1) + 'k' : '' + v);
}

export class OverviewDashboard extends Panel {
  constructor({ getModel, getScalarSpec, getLinkSpec, getSummary, getRegistry, setOverlay, setLinks, onPickIsland, nameById }) {
    super();
    this.getModel = getModel;           // () -> { stats, edges, trouble }
    this.getScalarSpec = getScalarSpec; // () -> the active scalar OVERLAYS entry (or the off entry)
    this.getLinkSpec = getLinkSpec;     // () -> the active edges/links OVERLAYS entry (or the off entry)
    this.getSummary = getSummary;       // () -> { economy, season, clock, islandCount }
    this.getRegistry = getRegistry;     // () -> OVERLAYS
    this.setOverlay = setOverlay;       // (key) -> void  (scalar layer; 'off' hides it)
    this.setLinks = setLinks;           // (key) -> void  (links layer; 'off' hides it)
    this.onPickIsland = onPickIsland;   // (id) -> void (fly-to + select)
    this.nameById = nameById;           // (id) -> name
    this.visible = false;
    this._scroll = new ScrollBox();
    this._chipRects = [];               // {key, kind:'overlay'|'link', x, y, w, h} in SCREEN space
    this._rowRects = [];                // {id, x, y, w, h} in SCREEN space
    this._cursor = null;
  }

  toggle() { this.visible = !this.visible; }

  layout(view) {
    this._view = view;
    const top = 168;                                   // below the overview toolbar + relocated legend
    const bottomLimit = view.height - 206;             // clear the bottom-left news crawl
    const h = Math.max(220, bottomLimit - top);
    this.setRect(12, top, W, h);
  }

  onMove(px, py) { this._cursor = { x: px, y: py }; }
  _hit(r, px, py) { return r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }
  hitPointer(px, py) {
    for (const c of this._chipRects) if (this._hit(c, px, py)) return true;
    for (const r of this._rowRects) if (this._hit(r, px, py)) return true;
    return false;
  }

  onDown(px, py) {
    if (!this.contains(px, py)) return false;
    for (const c of this._chipRects) if (this._hit(c, px, py)) { (c.kind === 'link' ? this.setLinks : this.setOverlay)(c.key); return true; }
    for (const r of this._rowRects) if (this._hit(r, px, py)) { this.onPickIsland(r.id); return true; }
    return true; // swallow other clicks inside the panel (no world pick-through)
  }

  onWheel(px, py, dy) {
    if (!this.contains(px, py)) return false;
    this._scroll.wheel(dy);
    return true;
  }

  draw(ctx) {
    if (!this.visible) return;
    this._chipRects = [];
    this._rowRects = [];
    const scalar = this.getScalarSpec();
    const link = this.getLinkSpec();
    const model = this.getModel() || {};
    const sum = this.getSummary() || {};
    plate(ctx, this.x, this.y, this.w, this.h, { radius: 10 });
    const x = this.x + PAD, right = this.x + this.w - PAD;

    // ── Header: title + day/season, then world totals ──
    ctx.save();
    drawIcon(ctx, 'map', x + 7, this.y + 17, 15, PALETTE.panelText);
    ctx.font = tfont('heading'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = PALETTE.panelText;
    ctx.fillText('Almanac', x + 19, this.y + 17);
    const clock = sum.clock || {};
    const season = sum.season;
    ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'right';
    ctx.fillText(clock.day != null ? `Day ${clock.day}` : '', right, this.y + 13);
    if (season && season.name) {
      const sw = ctx.measureText(season.name).width;
      ctx.fillText(season.name, right, this.y + 26);
      drawIcon(ctx, seasonIcon(season.name), right - sw - 9, this.y + 26, 11, PALETTE.panelDim);
    }
    ctx.restore();

    // Totals strip.
    const econ = sum.economy || {};
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let tx = x, ty = this.y + 40;
    const stat = (icon, text, color) => {
      drawIcon(ctx, icon, tx + 6, ty, 12, color || PALETTE.panelDim);
      ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'left';
      ctx.fillText(text, tx + 15, ty);
      tx += 15 + ctx.measureText(text).width + 12;
    };
    stat('coin', shortGold(econ.totalGold) + 'g', PALETTE.accent);
    stat('anchor', (econ.shipCount || 0) + ' ships');
    if (econ.people != null) stat('crowd', shortGold(econ.people));
    if (econ.pirates != null) stat('skull', '' + econ.pirates, '#b23a2e');
    ctx.restore();

    // ── Trouble strip ──
    const tr = model.trouble || {};
    let hy = this.y + 58;
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let hx = x;
    const trouble = (icon, n, color) => {
      if (!n) return;
      drawIcon(ctx, icon, hx + 6, hy, 12, color);
      ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim;
      ctx.fillText('' + n, hx + 15, hy);
      hx += 15 + ctx.measureText('' + n).width + 10;
    };
    trouble('wheat', tr.starving, '#b5601e');
    trouble('flame', tr.rebelling, '#b0342a');
    trouble('skull', tr.havens, '#9a2028');
    trouble('sabres', tr.lawless, '#9a6b1f');
    if (hx === x) { ctx.fillStyle = PALETTE.good; ctx.font = tfont('numSmall'); ctx.fillText('the realm is at peace', x + 2, hy); }
    ctx.restore();

    // ── Distribution: the scalar overlay's spread AND/OR the links overlay's tally (independent) ──
    let dy = this.y + 74;
    const stats = model.stats;
    if (scalar.kind === 'scalar' && stats && stats.count) {
      const bx = x, bw = this.w - PAD * 2, sh = 8, slices = 28;
      for (let i = 0; i < slices; i++) {
        const frac = i / (slices - 1);
        ctx.fillStyle = heatColor(scalar.good ? frac : 1 - frac, 1);
        ctx.fillRect(bx + (i / slices) * bw, dy, bw / slices + 1, sh);
      }
      ctx.strokeStyle = PALETTE.panelInk; ctx.lineWidth = 1; ctx.strokeRect(bx, dy, bw, sh);
      const mt = stats.hi > stats.lo ? (stats.p50 - stats.lo) / (stats.hi - stats.lo) : 0.5;
      const mx = bx + Math.max(0, Math.min(1, mt)) * bw;
      ctx.strokeStyle = '#2a2012'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, dy - 2); ctx.lineTo(mx, dy + sh + 2); ctx.stroke();
      ctx.font = tfont('numSmall'); ctx.textBaseline = 'top';
      ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left'; ctx.fillText(scalar.vfmt(stats.lo), bx, dy + sh + 3);
      ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'center'; ctx.fillText('~' + scalar.vfmt(stats.p50), bx + bw / 2, dy + sh + 3);
      ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'right'; ctx.fillText(scalar.vfmt(stats.hi), bx + bw, dy + sh + 3);
      dy += sh + 18;
    }
    if (link.kind === 'edges') {
      const n = (model.edges && model.edges.length) || 0;
      ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${link.label} — ${n} link${n === 1 ? '' : 's'}`, x, dy);
      dy += 16;
    }

    // ── PICKERS (fixed, always one click away): two sections that mirror the [Overlays]/[Links]
    //    toolbar toggles — each with an "Off" chip so a layer can be cleared right here. This panel
    //    IS the layer menu; the toolbar buttons are just shortcuts to the same on/off state. ──
    const reg = this.getRegistry() || [];
    dy = this._drawPickerSection(ctx, x, right, dy + 2, 'Overlays', reg.filter((o) => o.kind === 'scalar'), scalar.key, 'overlay', true);
    dy = this._drawPickerSection(ctx, x, right, dy + 6, 'Links', reg.filter((o) => o.kind === 'edges'), link.key, 'link', false);

    // ── LEADERBOARD / legend (scrolls in the remaining space): the scalar's port ranking when an
    //    overlay is on, else the active links' swatch key. ──
    const lbSpec = scalar.kind === 'scalar' ? scalar : (link.kind === 'edges' ? link : scalar);
    const top = dy + 6, bottom = this.y + this.h - 8;
    if (bottom - top < 34) return;
    const sb = this._scroll;
    sb.begin(ctx, this.x, top, this.w, bottom - top);
    const cy = this._drawLeaderboard(ctx, x, right, top + 2, lbSpec, model, sb);
    sb.end(ctx, cy + 6);
  }

  /** One titled picker section — a wrapped chip flow led by an "Off" chip, drawn FIXED above the
   *  scroll region so toggling a layer is always one click. `kind` ('overlay'|'link') tags each chip
   *  rect so onDown routes it to the right setter; `catGaps` inserts a subtle gap at each category
   *  change. Returns the y just below the section. Chip rects are screen-space. */
  _drawPickerSection(ctx, x, right, y, title, entries, activeKey, kind, catGaps) {
    sectionHeading(ctx, x, right, y + 6, title);
    let chX = x, chY = y + 15, prevCat = null;
    const chip = (key, label, active) => {
      ctx.font = tfont('badge');
      const cw = ctx.measureText(label).width + 18;
      if (chX + cw > right) { chX = x; chY += 22; }
      const w = themeChip(ctx, chX, chY + 9, label, { active });
      this._chipRects.push({ key, kind, x: chX, y: chY, w, h: 18 });
      chX += w + 5;
    };
    chip('off', 'Off', activeKey === 'off');
    for (const o of entries) {
      if (catGaps && prevCat && o.category !== prevCat && chX > x) chX += 8; // subtle group gap
      prevCat = o.category;
      chip(o.key, o.label, o.key === activeKey);
    }
    return chY + 22;
  }

  /** Best/worst leaderboard for a scalar metric — click a row to fly to that island. Row rects
   *  stored in screen space. For an edges overlay, shows the swatch key instead. */
  _drawLeaderboard(ctx, x, right, cy, spec, model, sb) {
    if (spec.kind === 'edges') {
      sectionHeading(ctx, x, right, cy + 6, 'Legend'); cy += 18;
      ctx.lineCap = 'round';
      for (const ek of (spec.edgeKinds || [])) {
        const sw = EDGE_KEY[ek] || ['#8fc6d4', ek];
        ctx.strokeStyle = sw[0]; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x + 2, cy + 6); ctx.lineTo(x + 26, cy + 6); ctx.stroke();
        ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(sw[1], x + 34, cy + 6);
        cy += 18;
      }
      return cy;
    }
    const lb = model.stats && model.stats.leaderboard;
    if (!lb || !lb.count) return cy;
    const lo = model.stats.lo, hi = model.stats.hi;
    const row = (r, rank) => {
      const rx = this.x + 6, rw = this.w - 12, rh = 18;
      const cur = this._cursor;
      const hovered = cur && cur.x >= rx && cur.x <= rx + rw && (cur.y + sb.offset) >= cy && (cur.y + sb.offset) <= cy + rh;
      if (hovered) { roundRect(ctx, rx, cy, rw, rh, 4); ctx.fillStyle = 'rgba(60,44,24,0.12)'; ctx.fill(); }
      const n = normalize(r.v, lo, hi);
      ctx.fillStyle = n == null ? neutralColor(0.8) : heatColor(spec.good ? n : 1 - n, 0.95);
      ctx.beginPath(); ctx.arc(x + 5, cy + rh / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = tfont('numSmall'); ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('' + rank, x + 14, cy + rh / 2);
      ctx.fillStyle = PALETTE.panelText;
      ctx.fillText(clip(ctx, r.name || this.nameById(r.id) || r.id, this.w - 118), x + 34, cy + rh / 2);
      ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'right';
      ctx.fillText(spec.vfmt(r.v), right, cy + rh / 2);
      this._rowRects.push({ id: r.id, x: rx, y: cy - sb.offset, w: rw, h: rh });
      cy += rh;
    };
    sectionHeading(ctx, x, right, cy + 6, spec.good ? 'Best' : 'Worst first'); cy += 20;
    lb.top.forEach((r, i) => row(r, i + 1));
    if (lb.bottom.length && lb.count > lb.top.length) {
      cy += 4;
      sectionHeading(ctx, x, right, cy + 6, spec.good ? 'Worst' : 'Best'); cy += 20;
      lb.bottom.forEach((r) => row(r, lb.count - lb.bottom.indexOf(r)));
    }
    return cy;
  }
}

function clip(ctx, text, maxW) {
  text = '' + text;
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
