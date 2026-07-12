// Minimal game-side UI spine: a widget list with consume-first, z-ordered pointer
// routing and back-to-front drawing. This is the durable seam so InfoPanel/SimControls
// (and future HUD widgets) share ONE hit-test + draw contract, and the scene routes a
// pointer through the UI before falling through to world picking.
//
// Line-in-the-sand (deliberately NOT built): no layout engine, no data-binding, no
// retained-mode reactivity, no theming. A widget list + Button/Panel is the ceiling
// for pass 1. World hit-testing stays a separate pick() in the scene (game-specific),
// never in here or the engine.

import { PALETTE } from '../config.js';

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class Widget {
  constructor() { this.x = 0; this.y = 0; this.w = 0; this.h = 0; this.visible = true; }
  setRect(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; return this; }
  contains(px, py) { return this.visible && px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h; }
  // Shared AABB hit helper (one copy, not three): pad extends the rect outward.
  hitRect(px, py, pad = 0) { return px >= this.x - pad && px <= this.x + this.w + pad && py >= this.y - pad && py <= this.y + this.h + pad; }
  /** @returns {boolean} true if this widget consumed the press. */
  onDown(px, py) { return this.contains(px, py); }
  onMove(_px, _py) {}
  onUp(_px, _py) {}
  draw(_ctx) {}
  layout(_view) {}
}

export class Button extends Widget {
  constructor({ label = '', onClick = null, isActive = null, font = '15px system-ui, sans-serif' } = {}) {
    super();
    this.label = label;
    this.onClick = onClick || (() => {});
    this.isActive = isActive || (() => false);
    this.font = font;
  }
  onDown(px, py) {
    if (!this.contains(px, py)) return false;
    try { this.onClick(); } catch (e) { console.error('Button onClick error:', e); }
    return true;
  }
  draw(ctx) {
    if (!this.visible) return;
    const active = !!this.isActive();
    ctx.save();
    roundRect(ctx, this.x, this.y, this.w, this.h, 7);
    ctx.fillStyle = active ? PALETTE.accent : PALETTE.panelBg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = active ? PALETTE.accent : PALETTE.panelEdge;
    ctx.stroke();
    ctx.fillStyle = active ? '#06323b' : PALETTE.panelText;
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, this.x + this.w / 2, this.y + this.h / 2 + 0.5);
    ctx.restore();
  }
}

export class Panel extends Widget {
  draw(ctx) {
    if (!this.visible) return;
    ctx.save();
    roundRect(ctx, this.x, this.y, this.w, this.h, 10);
    ctx.fillStyle = PALETTE.panelBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = PALETTE.panelEdge;
    ctx.stroke();
    ctx.restore();
    this.drawContent(ctx);
  }
  /** Subclasses draw their body here (background + border already painted). */
  drawContent(_ctx) {}
}

export class UIStack {
  constructor() { this.widgets = []; }
  add(w) { this.widgets.push(w); return w; }
  layout(view) { for (const w of this.widgets) w.layout(view); }
  /** Route a press top-of-stack first; stop at the first widget that consumes it. */
  onDown(px, py) {
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const w = this.widgets[i];
      if (w.visible && w.onDown(px, py)) return true;
    }
    return false;
  }
  onMove(px, py) { for (const w of this.widgets) if (w.visible) w.onMove(px, py); }
  onUp(px, py) { for (const w of this.widgets) if (w.visible) w.onUp(px, py); }
  draw(ctx) { for (const w of this.widgets) if (w.visible) w.draw(ctx); }
}
