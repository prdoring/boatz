// Bottom-center clock cluster: [⏸/▶] [1×] [3×] [10×]  Day N · HH:MM. Decoupled from
// the socket — it takes injected onSetSpeed/onTogglePause callbacks + a getClock reader,
// so it's transport-agnostic and trivially stubbed in shots. Buttons light from the
// AUTHORITATIVE clock in the latest snapshot (a dropped command simply doesn't light);
// never an optimistic local toggle. Bottom-center avoids the top-right volume overlay.

import { Widget, Button } from './UIStack.js';
import { PALETTE } from '../config.js';
import { plate, font } from './theme.js';

const BW = 46, BH = 34, GAP = 8, CLOCK_W = 150, LABEL_GAP = 14;

export class SimControls extends Widget {
  constructor({ onSetSpeed, onTogglePause, getClock, speeds = [1, 3, 10] }) {
    super();
    this.getClock = getClock;
    this.pauseBtn = new Button({
      icon: 'pause',
      iconSize: 15,
      onClick: () => onTogglePause(),
      isActive: () => this.getClock().paused,
    });
    this.speedBtns = speeds.map((s) => new Button({
      label: s + '×',
      onClick: () => onSetSpeed(s),
      isActive: () => !this.getClock().paused && this.getClock().speed === s,
    }));
    this.buttons = [this.pauseBtn, ...this.speedBtns];
  }

  layout(view) {
    const n = this.buttons.length;
    const totalW = n * BW + (n - 1) * GAP + LABEL_GAP + CLOCK_W;
    let x = Math.round((view.width - totalW) / 2);
    const y = Math.round(view.height - BH - 18);
    this.setRect(x, y, totalW, BH);
    for (const b of this.buttons) { b.setRect(x, y, BW, BH); x += BW + GAP; }
    this._clockX = x + LABEL_GAP;
    this._clockY = y;
  }

  onDown(px, py) {
    for (const b of this.buttons) if (b.onDown(px, py)) return true;
    return this.contains(px, py); // swallow clicks in the cluster (don't fall through to the map)
  }

  draw(ctx) {
    if (!this.visible) return;
    // Pause/play icon reflects the authoritative state.
    this.pauseBtn.icon = this.getClock().paused ? 'play' : 'pause';
    for (const b of this.buttons) b.draw(ctx);

    const c = this.getClock();
    // Clock pill — the shared chart-frame plate (double-ruled ink edge).
    ctx.save();
    plate(ctx, this._clockX - 8, this.y, CLOCK_W, BH, { radius: 7 });
    ctx.fillStyle = PALETTE.panelText;
    ctx.font = font('label');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Day ${c.day}`, this._clockX, this.y + BH / 2);
    ctx.fillStyle = PALETTE.panelDim;
    ctx.font = font('num');
    ctx.textAlign = 'right';
    ctx.fillText(c.timeLabel, this._clockX - 8 + CLOCK_W - 12, this.y + BH / 2);
    ctx.restore();
  }
}
