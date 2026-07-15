// Ship condition — hull/rig tracks, the speed/founder consequences, class armour, and the
// port repair economy (Wood mends hull, Fiber mends rig; home free, a foreign yard sells).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { rigMult, hullRisk, damageHull, repairAtPort, inDistress, initCondition } from '/game/sim/repair.js';

const capt = () => ({ name: 'T', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 } });

function port(over = {}) {
  return {
    id: 'i1', name: 'Testholm', gold: 0,
    stock: { Wood: 500, Fiber: 500 },
    price: { Wood: { mid: 3 }, Fiber: { mid: 3 } },
    targets: { Wood: 250, Fiber: 250 },
    ...over,
  };
}
function boat(over = {}) {
  return { id: 's1', homeId: 'i1', type: 'brig', cargo: { Gold: 1000, Food: 50 }, captain: capt(), hull: 1, rig: 1, ...over };
}

test('initCondition sets a fresh hull and rig to full', () => {
  const s = {}; initCondition(s);
  assert.equal(s.hull, 1); assert.equal(s.rig, 1);
});

test('rigMult: a whole rig is neutral (×1); a dismasted hull crawls at the floor, never frozen', () => {
  const w = makeWorld();
  assert.equal(rigMult({ rig: 1 }, w.rules), 1);
  const floor = w.rules.RIG_SPEED_FLOOR;
  assert.ok(Math.abs(rigMult({ rig: 0 }, w.rules) - floor) < 1e-9, 'rig 0 → the floor');
  const half = rigMult({ rig: 0.5 }, w.rules);
  assert.ok(half < 1 && half > floor, 'partial rig → between floor and full');
  assert.ok(rigMult({ rig: 0 }, w.rules) > 0, 'never fully frozen (no softlock)');
});

test('hullRisk: a whole hull is neutral (×1); a staved-in hull founders far more readily', () => {
  const w = makeWorld();
  assert.equal(hullRisk({ hull: 1 }, w.rules), 1);
  assert.ok(hullRisk({ hull: 0 }, w.rules) > hullRisk({ hull: 0.5 }, w.rules));
  assert.ok(hullRisk({ hull: 0 }, w.rules) > 1);
});

test('armor: a galleon shrugs off damage that staves a sloop', () => {
  const w = makeWorld();
  const sloop = { type: 'sloop', hull: 1 }, galleon = { type: 'galleon', hull: 1 };
  damageHull(sloop, 0.3, w.rules);
  damageHull(galleon, 0.3, w.rules);
  assert.ok(galleon.hull > sloop.hull, 'the galleon lost less hull to the same blow');
});

test('repairAtPort: a home yard mends the hull from its Wood for free (no coin)', () => {
  const w = makeWorld();
  const isl = port(); const s = boat({ hull: 0.4 });
  const wood0 = isl.stock.Wood, gold0 = s.cargo.Gold;
  repairAtPort(w, isl, s);
  assert.ok(s.hull > 0.4, 'hull rose');
  assert.ok(isl.stock.Wood < wood0, 'home Wood consumed');
  assert.equal(s.cargo.Gold, gold0, 'home mends free — no coin spent');
});

test('repairAtPort: a foreign yard sells timber — the ship pays coin', () => {
  const w = makeWorld();
  const isl = port({ id: 'other' }); const s = boat({ hull: 0.4 }); // homeId 'i1' ≠ 'other'
  const gold0 = s.cargo.Gold, islGold0 = isl.gold;
  repairAtPort(w, isl, s);
  assert.ok(s.hull > 0.4, 'hull rose');
  assert.ok(s.cargo.Gold < gold0, 'foreign yard charged coin');
  assert.ok(isl.gold > islGold0, 'the port took the payment');
});

test('repairAtPort: a bare yard cannot mend, and cries a shortage', () => {
  const w = makeWorld();
  const isl = port({ stock: { Wood: 0, Fiber: 0 } }); const s = boat({ hull: 0.3 });
  repairAtPort(w, isl, s);
  assert.equal(s.hull, 0.3, 'no timber → no mend');
  assert.ok((w.events || []).some((e) => e.kind === 'refitshort'), 'a refit shortage was logged');
});

test('repair is capped per dock — a wreck needs more than one visit', () => {
  const w = makeWorld();
  const isl = port(); const s = boat({ hull: 0.1, rig: 1 });
  repairAtPort(w, isl, s);
  assert.ok(s.hull < 1, 'not fully mended in a single dock');
  assert.ok(s.hull > 0.1, 'but meaningfully repaired');
});

test('inDistress: a dismasted ship is in distress; a whole one is not', () => {
  const w = makeWorld();
  assert.equal(inDistress({ rig: 1 }, w.rules), false);
  assert.equal(inDistress({ rig: w.rules.RIG_DISTRESS }, w.rules), true);
});
