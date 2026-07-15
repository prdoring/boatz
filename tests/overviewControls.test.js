// The overview toolbar ([Overlays] [Links] [Almanac]) — the mouse counterpart to the o/l/m
// hotkeys. The browser smoke renders it but can't assert click routing, so this drives layout +
// onDown over a Proxy canvas stub: each button fires its callback and consumes the click; the
// active-state readers feed the brass highlight; clicks off the cluster fall through to the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverviewControls } from '/game/ui/OverviewControls.js';

// Any ctx method is a no-op; gradients/measureText return real-enough objects (Button.draw uses
// createLinearGradient for its fill and roundRect/arcTo for the frame).
function stubCtx() {
  const grad = { addColorStop() {} };
  const special = { measureText: () => ({ width: 12 }), createLinearGradient: () => grad };
  return new Proxy({}, {
    get(t, p) { if (p in special) return special[p]; if (p in t) return t[p]; return () => {}; },
    set(t, p, v) { t[p] = v; return true; }, has(t, p) { return p in t; },
  });
}

function make() {
  const calls = {};
  const state = { overlay: false, links: false, almanac: false };
  const tb = new OverviewControls({
    onOverlay: () => { calls.overlay = (calls.overlay || 0) + 1; },
    onLinks: () => { calls.links = (calls.links || 0) + 1; },
    onAlmanac: () => { calls.almanac = (calls.almanac || 0) + 1; },
    overlayActive: () => state.overlay,
    linksActive: () => state.links,
    almanacActive: () => state.almanac,
  });
  tb.layout({ width: 1440, height: 900 });
  tb.visible = true;
  return { tb, calls, state };
}

test('toolbar lays out three non-overlapping buttons and draws without throwing', () => {
  const { tb } = make();
  assert.equal(tb.buttons.length, 3);
  const [b0, b1, b2] = tb.buttons;
  assert.ok(b0.x < b1.x && b1.x < b2.x, 'buttons run left→right');
  assert.ok(b0.x + b0.w <= b1.x && b1.x + b1.w <= b2.x, 'no horizontal overlap');
  assert.doesNotThrow(() => tb.draw(stubCtx()));
});

test('each button fires its callback and swallows the click', () => {
  const { tb, calls } = make();
  const [b0, b1, b2] = tb.buttons;
  assert.equal(tb.onDown(b0.x + 2, b0.y + 2), true); assert.equal(calls.overlay, 1);
  assert.equal(tb.onDown(b1.x + 2, b1.y + 2), true); assert.equal(calls.links, 1);
  assert.equal(tb.onDown(b2.x + 2, b2.y + 2), true); assert.equal(calls.almanac, 1);
});

test('active-state readers drive each button highlight independently', () => {
  const { tb, state } = make();
  const [overlayBtn, linksBtn, almanacBtn] = tb.buttons;
  assert.equal(overlayBtn.isActive(), false);
  state.overlay = true; state.almanac = true;
  assert.equal(overlayBtn.isActive(), true);
  assert.equal(linksBtn.isActive(), false);
  assert.equal(almanacBtn.isActive(), true);
});

test('a click off the cluster is not consumed (falls through to the map)', () => {
  const { tb, calls } = make();
  const last = tb.buttons[2];
  assert.equal(tb.onDown(last.x + last.w + 200, last.y), false);
  assert.equal(tb.hitPointer(last.x + last.w + 200, last.y), false, 'no pointer cursor off-cluster');
  assert.ok(tb.hitPointer(tb.buttons[0].x + 2, tb.buttons[0].y + 2), 'pointer cursor over a button');
  assert.equal(calls.overlay, undefined);
});

test('a hidden toolbar draws nothing', () => {
  const { tb } = make();
  tb.visible = false;
  let touched = false;
  const spy = new Proxy({}, { get() { touched = true; return () => {}; }, set() { return true; }, has() { return false; } });
  tb.draw(spy);
  assert.equal(touched, false, 'draw() early-returns when hidden');
});
