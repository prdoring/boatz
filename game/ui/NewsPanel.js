// The news ticker — promoted from raw scene drawing into a UIStack Panel so it gets wheel/clip/hit-
// testing for free. Two states:
//   • COLLAPSED (default): the compact bottom-left crawl of the latest live events, each clickable to
//     focus its ship/island/wreck, plus a small handle to expand.
//   • EXPANDED (press `h` or click the handle): grows in place into a scrollable, category-filterable
//     browser over the DEEP world timeline (server chronicle, newest-first), with a pin so browsing
//     doesn't collapse on each click. Reuses the shared ScrollBox + event category tables.
//
// Transport-agnostic: the scene injects { getEvents, getTimeline, eventLoc, focus } so this never
// touches the socket or the sim directly (mirrors InfoPanel/SimControls).

import { Panel, roundRect } from './UIStack.js';
import { ScrollBox } from './scroll.js';
import { STORY_CATEGORIES, filterByCategory, eventColor, eventIcon, isHeadline } from './eventKinds.js';
import { PALETTE } from '../config.js';
import { plate, chip as themeChip, font as tfont } from './theme.js';
import { drawIcon } from './icons.js';

const CRAWL_ROWS = 9;      // live events shown in the collapsed crawl
const CRAWL_LH = 18;
const PANEL_W = 380;
const ROW_H = 20;

export class NewsPanel extends Panel {
  constructor({ getEvents, getTimeline, eventLoc, focus, getControlsLeft }) {
    super();
    this.getEvents = getEvents;     // () -> live events (ascending, last ~60)
    this.getTimeline = getTimeline; // () -> { entries(newest-first), loading, done, more }
    this.eventLoc = eventLoc;       // (e) -> { x, y, shipId?, islandId? } | null  (is it focusable?)
    this.focus = focus;             // (e) -> void  (snap the camera + select)
    this.getControlsLeft = getControlsLeft || null; // () -> left screen-x of the bottom-center controls
    this._expanded = false;
    this._filter = 'all';
    this._scroll = new ScrollBox();
    this._rows = [];                // clickable event-row rects {e, x, y, w, h} (rebuilt each draw)
    this._chips = [];               // filter-chip rects
    this._btns = {};                // {expand?, collapse} rects
    this._cursor = null;            // last pointer, for hover highlight
  }

  toggle() { this._expanded = !this._expanded; }

  layout(view) {
    this._view = view;
    if (this._expanded) {
      const bottom = view.height - 60;                 // clear the bottom-center clock cluster
      const top = Math.max(56, Math.round(view.height * 0.34));
      // Expanding must always GROW the panel — never end up thinner than the collapsed crawl
      // (whose cap is view.width/2 - 210). Floor at PANEL_W, then match/exceed the crawl width.
      const w = Math.min(view.width - 24, Math.max(PANEL_W, Math.round(view.width / 2 - 190)));
      this.setRect(12, top, w, bottom - top);
    } else {
      // The HISTORY tab sits ABOVE the pane (drawn in _drawCrawl), so the plate only needs a
      // little breathing room above the first feed row — no in-pane reserve for the header.
      const h = CRAWL_ROWS * CRAWL_LH + 15;
      // Fixed width: fill the bottom-left up to the centered control cluster (matches _drawCrawl).
      const LEFT = 8, GAP = 12;
      const cl = this.getControlsLeft ? this.getControlsLeft() : (view.width / 2 - 240);
      const boxW = Math.max(320, Math.min(view.width - 20, (cl - GAP) - LEFT));
      this.setRect(8, view.height - 12 - h, boxW, h);
    }
  }

  onMove(px, py) { this._cursor = { x: px, y: py }; }

  /** For the scene's cursor style: is the pointer over something clickable here? */
  hitPointer(px, py) {
    if (this._hit(this._btns.expand, px, py) || this._hit(this._btns.collapse, px, py)) return true;
    for (const ch of this._chips) if (this._hit(ch, px, py)) return true;
    for (const r of this._rows) if (this._hit(r, px, py)) return true;
    return false;
  }

  _hit(r, px, py) { return r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

  onDown(px, py) {
    if (this._expanded) {
      if (this._hit(this._btns.collapse, px, py)) { this._expanded = false; return true; }
      for (const ch of this._chips) {
        if (this._hit(ch, px, py)) { this._filter = ch.key; this._scroll.reset('news:' + this._filter); return true; }
      }
      for (const r of this._rows) {
        // Browsing stays open on a row click (focus the camera, keep the panel up); collapse via the tab or `h`.
        if (this._hit(r, px, py)) { this.focus(r.e); return true; }
      }
      return this.contains(px, py); // swallow other clicks inside the panel
    }
    // Collapsed: only consume real hits, so empty crawl space still falls through to the map.
    if (this._hit(this._btns.expand, px, py)) { this._expanded = true; return true; }
    for (const r of this._rows) if (this._hit(r, px, py)) { this.focus(r.e); return true; }
    return false;
  }

  onWheel(px, py, dy) {
    if (!this._expanded || !this.contains(px, py)) return false;
    this._scroll.wheel(dy);
    return true;
  }

  draw(ctx) {
    if (!this.visible) return;
    this._rows = [];
    this._expanded ? this._drawExpanded(ctx) : this._drawCrawl(ctx);
  }

  // ── Collapsed crawl (the classic ticker) ──
  _drawCrawl(ctx) {
    const events = this.getEvents() || [];
    // The crawl shows only HEADLINE events; low-tier 'log' beats live in the Story tab, not here.
    const recent = events.filter(isHeadline).slice(-CRAWL_ROWS);
    const cur = this._cursor;
    ctx.save();
    ctx.font = tfont('small');
    // Fixed width: fill the bottom-left up to the centered control cluster (never shrink-wrap the text).
    // Long dispatches ellipsise via clip()/maxTextW below; short ones no longer shrink the box.
    const LEFT = 8, GAP = 12;
    const cl = this.getControlsLeft ? this.getControlsLeft() : (this._view.width / 2 - 240);
    const boxW = Math.max(320, Math.min(this._view.width - 20, (cl - GAP) - LEFT));
    this.w = boxW; // keep layout/hit-testing in step with what we draw
    // A subtle chart-frame plate so the crawl reads over the painted sea (it used to float).
    plate(ctx, this.x, this.y, boxW, this.h, { radius: 10, fill: 'rgba(240, 232, 206, 0.86)', corners: true });

    // The HISTORY handle rides above the pane (see _drawTab); chevronUp = "expand upward".
    this._btns.expand = this._drawTab(ctx, 'chevronUp');

    ctx.font = tfont('small');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const x = this.x + 10;
    const maxTextW = this.x + boxW - 12 - x; // clip guard so text never leaves the box
    let y = this._view.height - 30; // newest row sits near the bottom, older fading upward
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      const loc = this.eventLoc(e);
      const ic = loc ? 16 : 0;
      const text = clip(ctx, `Day ${e.day}  ·  ${e.text}`, maxTextW - ic);
      const w = Math.min(boxW - 8, ctx.measureText(text).width + ic + 10);
      const rx = x - 5, ry = y - CRAWL_LH / 2;
      const hovered = loc && cur && cur.x >= rx && cur.x <= rx + w && cur.y >= ry && cur.y <= ry + CRAWL_LH;
      const col = eventColor(e.kind, PALETTE.panelDim);
      if (hovered) { roundRect(ctx, rx, ry, w, CRAWL_LH, 5); ctx.fillStyle = 'rgba(60,44,24,0.12)'; ctx.fill(); }
      ctx.globalAlpha = hovered ? 1 : Math.max(0.42, 1 - (recent.length - 1 - i) * 0.07);
      if (loc) drawIcon(ctx, eventIcon(e.kind), x + 5, y, 11, col);
      ctx.fillStyle = hovered ? '#ffffff' : col;
      ctx.fillText(text, x + ic, y);
      ctx.globalAlpha = 1;
      if (loc) this._rows.push({ e, x: rx, y: ry, w, h: CRAWL_LH });
      y -= CRAWL_LH;
    }
    ctx.restore();
  }

  // ── Expanded world-history browser ──
  _drawExpanded(ctx) {
    // Panel chrome — the shared double-ruled chart-frame plate.
    plate(ctx, this.x, this.y, this.w, this.h, { radius: 10 });

    // Collapse handle: the SAME HISTORY tab as the collapsed crawl — same size and top-left spot —
    // but chevronDown = "collapse". Keeps the toggle in one consistent place across both states.
    this._btns.collapse = this._drawTab(ctx, 'chevronDown');

    const x = this.x + 12;
    // Title (the collapse handle is the tab above the pane; no in-pane corner buttons).
    ctx.save();
    drawIcon(ctx, 'map', x + 7, this.y + 18, 14, PALETTE.panelText);
    ctx.font = tfont('heading'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = PALETTE.panelText;
    ctx.fillText('World History', x + 18, this.y + 18);
    ctx.restore();

    // Filter chips (shared theme.chip).
    this._chips = [];
    ctx.save();
    let cx = x; const cy = this.y + 40;
    for (const cat of STORY_CATEGORIES) {
      const w = themeChip(ctx, cx, cy, cat.label, { active: this._filter === cat.key });
      this._chips.push({ key: cat.key, x: cx, y: cy - 9, w, h: 18 });
      cx += w + 5;
    }
    ctx.restore();

    // Scrollable timeline (newest-first).
    const tl = this.getTimeline ? this.getTimeline() : { entries: [], loading: false, done: true };
    const entries = filterByCategory(tl.entries, this._filter);
    const top = cy + 18, bottom = this.y + this.h - 8;
    if (bottom - top < 30) return;
    if (!entries.length) {
      ctx.save();
      ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = PALETTE.panelDim;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(tl.loading ? 'Gathering the chronicle…' : 'No events yet.', x, top + 16);
      ctx.restore();
      return;
    }

    const sb = this._scroll, w = this.w - 24, cur = this._cursor;
    sb.begin(ctx, this.x, top, this.w, bottom - top);
    let y = top + 4;
    const vt = sb.visibleTop, vb = sb.visibleBottom;
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const e of entries) {
      if (y + ROW_H >= vt && y <= vb) {
        const loc = this.eventLoc(e);
        const col = eventColor(e.kind, PALETTE.panelDim);
        const rx = this.x + 6, rw = this.w - 12, ry = y;
        const hovered = cur && cur.x >= rx && cur.x <= rx + rw && (cur.y + sb.offset) >= ry && (cur.y + sb.offset) <= ry + ROW_H;
        if (hovered) { roundRect(ctx, rx, ry, rw, ROW_H, 5); ctx.fillStyle = 'rgba(60,44,24,0.12)'; ctx.fill(); }
        drawIcon(ctx, eventIcon(e.kind), x + 5, y + ROW_H / 2, 12, col);
        ctx.font = tfont('section'); ctx.fillStyle = PALETTE.panelDim;
        ctx.fillText(`Day ${e.day}`, x + 15, y + ROW_H / 2);
        ctx.font = tfont('small'); ctx.fillStyle = hovered ? '#ffffff' : col;
        ctx.fillText(clip(ctx, e.text, w - 56), x + 50, y + ROW_H / 2);
        // Row rect is stored in SCREEN space (subtract the scroll offset) for hit-testing.
        if (loc) this._rows.push({ e, x: rx, y: ry - sb.offset, w: rw, h: ROW_H });
      }
      y += ROW_H;
    }
    ctx.restore();
    sb.end(ctx, y + 4);

    if (sb.atBottom() && tl.more && !tl.done && !tl.loading) tl.more(); // page older history in
  }

  /** The HISTORY handle — a folder tab riding just above the pane's top-left edge (hy sits one px
   *  into the plate so it reads as attached). Shared by both states so the toggle keeps one size and
   *  place: collapsed passes 'chevronUp' (expand), expanded passes 'chevronDown' (collapse).
   *  Returns the tab's hit rect. */
  _drawTab(ctx, chevron) {
    const hx = this.x + 8, hh = 19, hy = this.y - hh + 1;
    ctx.save();
    ctx.font = tfont('section', 700);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
    const lblW = ctx.measureText('HISTORY').width;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const hw = 22 + lblW + 26;
    const hg = ctx.createLinearGradient(0, hy, 0, hy + hh);
    hg.addColorStop(0, PALETTE.panelPaperHi); hg.addColorStop(1, PALETTE.panelPaperLo);
    roundRect(ctx, hx, hy, hw, hh, 6); ctx.fillStyle = hg; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = PALETTE.panelEdge; ctx.stroke();
    drawIcon(ctx, chevron, hx + 13, hy + hh / 2, 10, PALETTE.panelAccent);
    ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = tfont('section', 700);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
    ctx.fillText('HISTORY', hx + 22, hy + hh / 2 + 0.5);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    // key badge
    ctx.font = tfont('numSmall');
    const kx = hx + hw - 20;
    roundRect(ctx, kx, hy + 4, 14, hh - 8, 3); ctx.fillStyle = PALETTE.panelInk; ctx.fill();
    ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'center';
    ctx.fillText('h', kx + 7, hy + hh / 2 + 0.5);
    ctx.restore();
    return { x: hx, y: hy, w: hw, h: hh };
  }

}

function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
