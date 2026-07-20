// Top-left overview toolbar — [Overlays] [Links] [Almanac] — so the map data views are reachable
// by mouse, not just the o / l / m hotkeys. [Overlays] and [Links] are plain on/off TOGGLES for two
// independent map layers (click again hides); [Almanac] opens the panel where you pick WHICH metric
// / link each layer shows. Each button lights (brass) while its layer/panel is active. Transport-
// agnostic like SimControls: the scene injects the toggle callbacks + active readers.

import { Widget, Button } from './UIStack.js';

const BW = 64, BH = 26, GAP = 6, X = 12, Y = 62;
const FONT = '400 13px "IM Fell English SC", Georgia, serif';

export class OverviewControls extends Widget {
  constructor({ onOverlay, onLinks, onAlmanac, overlayActive, linksActive, almanacActive }) {
    super();
    this.buttons = [
      new Button({ label: 'Overlays', font: FONT, onClick: onOverlay, isActive: overlayActive }),
      new Button({ label: 'Links', font: FONT, onClick: onLinks, isActive: linksActive }),
      new Button({ label: 'Almanac', font: FONT, onClick: onAlmanac, isActive: almanacActive }),
    ];
  }

  layout() {
    const n = this.buttons.length;
    this.setRect(X, Y, n * BW + (n - 1) * GAP, BH);
    let x = X;
    for (const b of this.buttons) { b.setRect(x, Y, BW, BH); x += BW + GAP; }
  }

  onDown(px, py) {
    for (const b of this.buttons) if (b.onDown(px, py)) return true;
    return this.contains(px, py); // swallow clicks in the cluster (don't fall through to the map)
  }

  /** For the scene's pointer-cursor: is the cursor over a button? */
  hitPointer(px, py) { return this.contains(px, py); }

  draw(ctx) {
    if (!this.visible) return;
    for (const b of this.buttons) b.draw(ctx);
  }
}
