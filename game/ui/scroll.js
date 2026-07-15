// Reusable scroll-offset + clip + thumb for immediate-mode canvas panels (the InfoPanel Story tab
// and the NewsPanel). The panel draws its body between begin()/end(): begin() clips to the view rect
// and translates content up by the current offset; end() measures the content, clamps the offset, and
// paints a thumb. Mirrors the editors' timeline/pianoRoll scroll pattern, but routed through the game
// UIStack's onWheel instead of a raw DOM wheel listener.
//
// `stickBottom` supports the "reads like a story" order: entries drawn oldest→newest, the view pinned
// to the newest at the bottom, new events appended below keeping you stuck there until you scroll up.

import { roundRect } from './UIStack.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class ScrollBox {
  constructor() {
    this.offset = 0;
    this._max = 0;
    this._key = null;   // logical subject (selection id + tab) — scroll resets when it changes
    this._view = null;  // last begin() rect
    this.stick = false; // pin to the bottom (newest) as content grows
  }

  /** Reset to the top (or the bottom, for a story) when the subject changes. */
  reset(key, { stickBottom = false } = {}) {
    if (key === this._key) return;
    this._key = key;
    this.stick = stickBottom;
    this.offset = 0; // end() corrects to the bottom this frame when stick is set
  }

  /** Apply a wheel delta; returns true if it changed the offset (⇒ the caller consumes the event). */
  wheel(dy) {
    if (this._max <= 0) return false;
    const prev = this.offset;
    this.offset = clamp(this.offset + dy, 0, this._max);
    this.stick = this.offset >= this._max - 1; // re-stick once dragged back to the bottom
    return this.offset !== prev;
  }

  get scrollable() { return this._max > 0; }
  /** Content-space y-band currently visible — for culling rows that are off-screen. */
  get visibleTop() { return (this._view ? this._view.y : 0) + this.offset; }
  get visibleBottom() { return (this._view ? this._view.y + this._view.h : 0) + this.offset; }
  atTop(slack = 40) { return this.offset <= slack; }
  atBottom(slack = 40) { return this.offset >= this._max - slack; }

  /** Begin the clipped, offset content region [x,y,w,h]. Draw body at absolute content coords after. */
  begin(ctx, x, y, w, h) {
    this._view = { x, y, w, h };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(0, -this.offset);
  }

  /** End the region. `contentBottom` = absolute content-space y of the last thing drawn. */
  end(ctx, contentBottom) {
    const v = this._view;
    ctx.restore();
    this._max = Math.max(0, (contentBottom - v.y) - v.h);
    this.offset = this.stick ? this._max : clamp(this.offset, 0, this._max);
    if (this._max > 0) this._thumb(ctx);
  }

  _thumb(ctx) {
    const v = this._view;
    const thumbH = Math.max(24, v.h * (v.h / (v.h + this._max)));
    const ty = v.y + (v.h - thumbH) * (this.offset / this._max);
    ctx.save();
    ctx.fillStyle = 'rgba(180,220,235,0.30)';
    roundRect(ctx, v.x + v.w - 5, ty, 3, thumbH, 1.5);
    ctx.fill();
    ctx.restore();
  }
}
