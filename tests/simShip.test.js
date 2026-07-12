import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { ship as shipSystem, moveToward } from '/game/sim/ship.js';
import { dispatch } from '/game/sim/trade.js';
import { applyIntents } from '/game/sim/intents.js';

test('moveToward reaches and snaps to the target', () => {
  const s = { x: 0, y: 0, heading: 0 };
  let arrived = false;
  for (let i = 0; i < 100 && !arrived; i++) arrived = moveToward(s, 100, 0, 120, 0.05);
  assert.ok(arrived);
  assert.equal(s.x, 100);
  assert.equal(s.y, 0);
});

test('a ship completes a full multi-hop voyage back to idle', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const a = w.islands[1];
  const b = w.islands[2];
  const s = w.ships.find((sh) => sh.homeId === home.id);
  w.rules.SINK_PER_1000 = 0; // deterministic: this ship must not founder mid-test
  // Isolate: park every other ship idle with no voyage so only `s` moves.
  for (const other of w.ships) { if (other !== s) { other.state = 'idle'; other.voyage = null; } }
  s.state = 'idle';
  s.voyage = {
    reason: 'trade', index: 0,
    stops: [
      { islandId: a.id, sell: {}, buy: {}, people: 0 },
      { islandId: b.id, sell: {}, buy: {}, people: 0 },
    ],
  };
  let visitedBoth = false, idleAgain = false;
  for (let i = 0; i < 12000; i++) {
    shipSystem(w, 0.05);
    if (s.voyage && s.voyage.index >= 1) visitedBoth = true; // reached the second stop
    if (i > 0 && s.state === 'idle') { idleAgain = true; break; }
  }
  assert.ok(visitedBoth, 'ship never advanced to its second stop');
  assert.ok(idleAgain, 'ship never returned to idle');
  assert.equal(s.voyage, null);
  assert.ok(Math.abs(s.x - home.x) < 1 && Math.abs(s.y - home.y) < 1, 'not home');
});

test('a player intent sets a ship voyage that NPC dispatch does not stomp', () => {
  const w = makeWorld();
  w.agents.p1 = { kind: 'player' };
  const s = w.ships[0];
  s.ownerId = 'p1';
  s.state = 'idle';
  s.voyage = null;
  const voyage = { reason: 'player', index: 0, stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }] };
  w.intents.push({ type: 'setVoyage', shipId: s.id, voyage, by: 'p1' });
  applyIntents(w);
  assert.equal(s.voyage && s.voyage.reason, 'player');
  dispatch(w); // NPC dispatch must skip a player-owned ship
  assert.equal(s.voyage.reason, 'player');
});
