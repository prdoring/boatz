import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { ship as shipSystem, moveToward } from '/game/sim/ship.js';
import { dispatch } from '/game/sim/trade.js';
import { applyIntents } from '/game/sim/intents.js';
import { turnPirate } from '/game/sim/piracy.js';
import { snapshotShips } from '/game/sim/snapshot.js';

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
  const s = w.ships.find((sh) => sh.homeId === home.id && !sh.pirate);
  w.rules.SINK_PER_1000 = 0; // deterministic: this ship must not founder mid-test
  // Isolate: keep ONLY `s` afloat — drop every other hull (incl. the seeded rogues, which would
  // otherwise trip this ship's pirate-evasion and stop it ever completing the run).
  w.ships = w.ships.filter((sh) => sh === s);
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

test('a merchant fleeing a pirate commits to ONE refuge and does not spin in place', () => {
  const w = makeWorld();
  const merch = w.ships.find((s) => !s.pirate && !s.privateer);
  const pirate = w.ships.find((s) => s !== merch);
  turnPirate(w, pirate);
  // Isolate the pair so the merchant's flight is the only dynamic (the ship system skips the pirate,
  // so it sits put as a stable evade trigger).
  w.ships = w.ships.filter((s) => s === merch || s === pirate);
  w.rules.SINK_PER_1000 = 0;
  merch.x = 5000; merch.y = 5000;
  merch.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 0 }; // unarmed → it flees, never runs the blockade
  merch.captain.traits = { boldness: 0.2, wanderlust: 0.5, greed: 0.5 };
  merch.state = 'inbound';
  merch.voyage = { reason: 'trade', index: 0, stops: [{ islandId: w.islands[0].id, sell: {}, buy: {}, people: 0 }] };
  merch.targetX = w.islands[0].x; merch.targetY = w.islands[0].y;
  pirate.x = 5000 + 0.5 * w.rules.PIRATE_EVADE_RANGE; pirate.y = 5000; // inside evade range → merchant flees

  const headings = [];
  for (let i = 0; i < 60; i++) { shipSystem(w, 0.05); if (!merch._sunk) headings.push(merch.heading); }
  assert.ok(merch._fleeing && merch._fleeTo, 'it committed to a single named refuge');
  let flips = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = Math.abs(headings[i] - headings[i - 1]) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d > 2.4) flips++; // a ~140°+ reversal in one substep = spinning, not sailing
  }
  assert.ok(flips <= 2, `heading stays stable while fleeing (had ${flips} sharp reversals — the spin bug is >30)`);
});

test('a ship that makes port SHELTERS docked and holds station, then resumes only once the coast is clear', () => {
  const w = makeWorld();
  w.rules.SINK_PER_1000 = 0;
  const merch = w.ships.find((s) => !s.pirate && !s.privateer);
  const pirate = w.ships.find((s) => s !== merch);
  turnPirate(w, pirate);
  w.ships = w.ships.filter((s) => s === merch || s === pirate);
  const port = w.islands[0];
  // She's reached the refuge and ducked in — the state panicRun sets on crossing the harbour line.
  merch.state = 'outbound';
  merch.voyage = { reason: 'trade', index: 0, stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }] };
  merch.targetX = w.islands[1].x; merch.targetY = w.islands[1].y;
  merch.x = port.x + 40; merch.y = port.y;
  merch._sheltered = true; merch._shelterAt = port.id; merch._shelterClear = 0;
  merch.captain.xp = 0;
  merch.captain.traits = { boldness: 0.5, wanderlust: 0.5, greed: 0.5 };
  // A raider still loitering just off the port → she stays put behind the harbour.
  pirate.x = port.x + 700; pirate.y = port.y;

  const p0 = { x: merch.x, y: merch.y };
  for (let i = 0; i < 200; i++) shipSystem(w, 0.05);
  assert.ok(merch._sheltered, 'she rode out the raider sheltered, not bouncing off the port');
  assert.ok(Math.hypot(merch.x - p0.x, merch.y - p0.y) < 5, 'she held station at the berth (no bounce)');
  assert.equal(snapshotShips(w)[merch.id].state, 'docked', 'a sheltering hull renders as docked/berthed, not sailing');

  // Coast clears — after a captain-scaled settling spell she weighs anchor and resumes her voyage.
  pirate.x = port.x + 6000; pirate.y = port.y + 6000;
  let resumed = false;
  for (let i = 0; i < 2000 && !resumed; i++) { shipSystem(w, 0.05); if (!merch._sheltered) resumed = true; }
  assert.ok(resumed, 'once the raider was gone she weighed anchor and left the refuge');
});

test('a BOLD captain weighs anchor sooner than a cautious one (shelter timing rides on captain nerve)', () => {
  function shelterUntilResume(boldness) {
    const w = makeWorld();
    w.rules.SINK_PER_1000 = 0;
    const m = w.ships.find((s) => !s.pirate && !s.privateer);
    w.ships = w.ships.filter((s) => s === m); // no raiders → the coast is clear from the first tick
    const port = w.islands[0];
    m.state = 'outbound';
    m.voyage = { reason: 'trade', index: 0, stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }] };
    m.targetX = w.islands[1].x; m.targetY = w.islands[1].y;
    m.x = port.x + 40; m.y = port.y;
    m._sheltered = true; m._shelterAt = port.id; m._shelterClear = 0;
    m.captain.xp = 0; // hold skill fixed so the only variable is nerve
    m.captain.traits = { boldness, wanderlust: 0.5, greed: 0.5 };
    let steps = 0;
    for (; steps < 4000 && m._sheltered; steps++) shipSystem(w, 0.05);
    return steps;
  }
  const boldSteps = shelterUntilResume(0.95);
  const cautiousSteps = shelterUntilResume(0.15);
  assert.ok(boldSteps > 0 && cautiousSteps > 0, 'both captains dwelt at anchor before leaving');
  assert.ok(boldSteps < cautiousSteps, `a bold captain leaves sooner (bold ${boldSteps} < cautious ${cautiousSteps} substeps)`);
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
