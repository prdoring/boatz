import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { recordTrade, repPriceMult, reputation } from '/game/sim/reputation.js';

test('reputation initialises every ordered pair just above/below neutral', () => {
  const w = makeWorld();
  const spread = w.rules.REP_INIT_SPREAD;
  for (const a of w.islands) {
    assert.ok(a.rep, `${a.name} has no rep map`);
    for (const b of w.islands) {
      if (a === b) { assert.ok(!(b.id in a.rep), 'no self-reputation'); continue; }
      const v = a.rep[b.id];
      assert.ok(typeof v === 'number' && v >= -spread - 1e-9 && v <= spread + 1e-9, `${a.name}->${b.name}=${v}`);
    }
  }
});

test('trading builds mutual reputation and shifts third parties toward the host', () => {
  const w = makeWorld();
  const [A, B, C] = w.islands;
  A.rep[B.id] = 0; B.rep[A.id] = 0;
  C.rep[A.id] = 0; C.rep[B.id] = 0.4; // C likes B
  recordTrade(w, B, A.id, w.rules.REP_VOLUME_NORM); // A's ship trades at B
  assert.ok(A.rep[B.id] > 0, 'A now likes B more');
  assert.ok(B.rep[A.id] > 0, 'B now likes A more (mutual)');
  assert.ok(C.rep[A.id] > 0, "C warms to A — A traded with C's friend B");
});

test("trading with a disliked port costs reputation with that port's enemies", () => {
  const w = makeWorld();
  const [A, B, C] = w.islands;
  C.rep[B.id] = -0.5; // C dislikes B
  C.rep[A.id] = 0;
  recordTrade(w, B, A.id, w.rules.REP_VOLUME_NORM);
  assert.ok(C.rep[A.id] < 0, "C sours on A — A traded with C's enemy B");
});

test('reputation shifts the price a host quotes: friends better, rivals worse', () => {
  const w = makeWorld();
  const [A, B] = w.islands;
  const swing = w.rules.REP_PRICE_SWING;
  B.rep[A.id] = 1; // B loves A
  assert.ok(repPriceMult(B, A.id, swing, true) < 1, 'friend gets a discount when buying');
  assert.ok(repPriceMult(B, A.id, swing, false) > 1, 'friend is paid more when selling');
  B.rep[A.id] = -1; // B hates A
  assert.ok(repPriceMult(B, A.id, swing, true) > 1, 'rival is gouged when buying');
  assert.ok(repPriceMult(B, A.id, swing, false) < 1, 'rival is underpaid when selling');
});

test('same-resource competitors drift apart on the daily tick', () => {
  const w = makeWorld();
  const A = w.islands.find((i) => i.primary === 'Iron');
  const B = w.islands.find((i) => i.primary === 'Iron' && i !== A);
  A.rep[B.id] = 0;
  w.simTime = w.rules.SIM_DAY_SECONDS + 1; // cross a day boundary
  w._repDay = 0;
  reputation(w);
  assert.ok(A.rep[B.id] < 0, 'competing Iron producers drift negative');
});
