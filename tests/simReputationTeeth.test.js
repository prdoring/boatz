// Reputation with TEETH — the hard consequences layered over the opinion system:
//   • EMBARGO — deep hostility bars trade entirely (no deal at any price).
//   • AID CONVOY — an ally gifts food to a famine-struck friend (free; warms the bond).
//   • BETRAYAL — a close friendship can collapse into a feud (tested via the daily system).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { isEmbargoed, tradeBarred, bumpRep, reputation } from '/game/sim/reputation.js';
import { executeStop } from '/game/sim/trade.js';
import { GOLD, PEOPLE } from '/game/sim/resources.js';

test('a deep grudge is an embargo — either side hostile bars the trade', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  const E = w.rules.REP_EMBARGO_THRESHOLD;
  a.rep[b.id] = E - 0.1; b.rep[a.id] = 0.2;
  assert.ok(isEmbargoed(a, b.id, w.rules), 'a has embargoed b');
  assert.ok(!isEmbargoed(b, a.id, w.rules), 'b has not embargoed a');
  assert.ok(tradeBarred(w, a.id, b.id, w.rules), 'either-side hostility bars the trade');
  a.rep[b.id] = 0.3;
  assert.ok(!tradeBarred(w, a.id, b.id, w.rules), 'friendly again → trade flows');
});

test('an embargoed trader is turned away at the dock — no goods or coin move (but refugees land)', () => {
  const w = makeWorld();
  const host = w.islands[0], home = w.islands[1];
  const ship = w.ships.find((s) => s.homeId === home.id) || w.ships[0];
  ship.homeId = home.id;
  host.rep[home.id] = w.rules.REP_EMBARGO_THRESHOLD - 0.2; // host hates home
  host.stock.Wood = 200; const wood0 = host.stock.Wood, gold0 = host.gold;
  ship.cargo = { Gold: 500, People: 12, Wood: 0 };
  const stop = { islandId: host.id, sell: {}, buy: { Wood: 40 }, people: 10 };
  executeStop(w, host, ship, stop);
  assert.equal(host.stock.Wood, wood0, 'no goods sold to the embargoed trader');
  assert.equal(host.gold, gold0, 'no coin changed hands');
  assert.ok(host.population > 0 && (ship.cargo[PEOPLE] || 0) < 12, 'but refugees aboard still landed');
});

test('an aid gift delivers food free and strongly warms the friendship', () => {
  const w = makeWorld();
  const host = w.islands[0], home = w.islands[1];
  const ship = w.ships[0]; ship.homeId = home.id;
  host.rep[home.id] = 0.3; home.rep[host.id] = 0.3;
  host.stock.Food = 20; const food0 = host.stock.Food, gold0 = host.gold, rep0 = host.rep[home.id];
  ship.cargo = { Gold: 0, People: 0, Food: 60 };
  const stop = { islandId: host.id, sell: {}, buy: {}, people: 0, gift: { Food: 60 } };
  executeStop(w, host, ship, stop);
  assert.ok(host.stock.Food > food0 + 50, 'the gifted food was delivered to the port');
  assert.equal(host.gold, gold0, 'the recipient paid nothing (a gift, not a sale)');
  assert.ok((ship.cargo.Food || 0) < 1, 'the ship handed over its aid');
  assert.ok(host.rep[home.id] > rep0, 'the act of solidarity deepened the friendship');
});

test('bumpRep nudges both sides’ opinion mutually', () => {
  const w = makeWorld();
  const [a, b] = w.islands;
  a.rep[b.id] = 0; b.rep[a.id] = 0;
  bumpRep(w, a.id, b.id, 0.2);
  assert.ok(a.rep[b.id] > 0.19 && b.rep[a.id] > 0.19, 'both warmed by ~0.2');
});

test('betrayal can shatter a close alliance into a feud (daily system, over time)', () => {
  const w = makeWorld();
  // Make every pair a very close ally so betrayal is possible; drive many days.
  for (const a of w.islands) for (const b of w.islands) if (a !== b) a.rep[b.id] = 0.9;
  let betrayals = 0;
  const before = w.events.length;
  // A betrayal SEVERS trade the moment it lands (it slams the pair past the embargo line); the grudge
  // then HEALS over the following days, because passive same-primary rivalry no longer sticks at
  // embargo depth — it settles at v*≈-0.5 (thawable), the -0.667 permanent-embargo attractor having
  // been fixed. So we prove "a betrayal drove a pair to embargo depth" the day it happens, not at the
  // end of the run (by when it has thawed back toward rivalry). Passive drift alone never crosses the
  // embargo line (it converges monotonically to -0.5), so this can only be a betrayal's doing.
  let everEmbargoed = false;
  for (let d = 0; d < 120; d++) {
    w.simTime += w.rules.SIM_DAY_SECONDS;
    reputation(w);
    if (w.islands.some((a) => a.rep && Object.values(a.rep).some((v) => v <= w.rules.REP_EMBARGO_THRESHOLD))) everEmbargoed = true;
  }
  for (const e of w.events.slice(before)) if (e.kind === 'betray') betrayals++;
  assert.ok(betrayals >= 1, 'at least one betrayal occurred among many close allies over 120 days');
  assert.ok(everEmbargoed, 'a betrayal slammed a pair into embargo-deep hostility (the moment it lands, before the grudge heals)');
});
