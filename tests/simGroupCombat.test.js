// GROUP-AWARE COMBAT — fight/flee is no longer a lone-wolf 1-v-1. Every stand/engage/run weighs the LOCAL
// BALANCE OF FORCE (allied vs hostile combatStrength summed near the ship), so pirates gang up on a trader,
// privateers gang up on a pirate, and a lone hull flees a pack it would have fought one-on-one — while the
// captain's own nerve (boldness+skill) still sets the odds bar. Also: raiders focus-fire onto a prize a
// consort already marks, an enemy alongside preempts a resting/greedy raider's other goals, and a privateer
// is never mistaken for plunder-prey. Backward-compatible by construction (null grids ⇒ the old self-vs-foe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { balanceOfForce, combatStrength, turnPirate, piracy } from '/game/sim/piracy.js';
import { antipiracy } from '/game/sim/antipiracy.js';
import { ship } from '/game/sim/ship.js';
import { buildShipGrid } from '/game/sim/grid.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 277, gun: 277, cmd: 277 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, ...over });
const boat = (over = {}) => ({ id: 's', type: 'brig', hull: 1, rig: 1, morale: 0.6, state: 'outbound', cargo: { Gold: 0, People: 0, Weapons: 10 }, captain: cap(), ...over });
const STEP = (w) => w.rules.SIM_STEP;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The primitive
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('balanceOfForce: lone reads self-vs-foe; consorts & foes sum; a docked foe is no threat; head-count capped; deterministic', () => {
  const w = makeWorld();
  const self = boat({ id: 'a0', x: 5000, y: 5000 });
  const foe = boat({ id: 'f0', x: 5050, y: 5000, cargo: { Gold: 0, People: 0, Weapons: 20 } });

  // Null grids ⇒ exactly {ally: str(self), foe: str(foe)} — identical to the old 1-v-1.
  let b = balanceOfForce(w, self, null, null, 800, {});
  assert.equal(b.ally, combatStrength(w, self)); assert.equal(b.foe, 0);
  assert.equal(b.nAlly, 1); assert.equal(b.nFoe, 0);
  b = balanceOfForce(w, self, null, null, 800, { foe });
  assert.equal(b.foe, combatStrength(w, foe)); assert.equal(b.nFoe, 1);

  // Allied consorts within range sum; a far one is excluded.
  const a1 = boat({ id: 'a1', x: 5100, y: 5000 }), a2 = boat({ id: 'a2', x: 5200, y: 5000 });
  const far = boat({ id: 'a3', x: 9000, y: 5000 });
  const allyGrid = buildShipGrid(w, [self, a1, a2, far]);
  b = balanceOfForce(w, self, allyGrid, null, 800, {});
  assert.equal(b.nAlly, 3, 'self + two in-range consorts; the far one is out of the bubble');
  assert.ok(Math.abs(b.ally - (combatStrength(w, self) + combatStrength(w, a1) + combatStrength(w, a2))) < 1e-9);

  // A docked/trading foe is skipped on the foe side (mirrors every hunter's prey scan).
  const docked = boat({ id: 'f1', x: 5060, y: 5000, state: 'trading' });
  const foeGrid = buildShipGrid(w, [foe, docked]);
  b = balanceOfForce(w, self, null, foeGrid, 800, {});
  assert.equal(b.nFoe, 1, 'the berthed foe is no threat — excluded from the force sum');

  // Head-count cap bounds a big melee.
  const rules = { ...w.rules, GROUP_MAX_ALLIES: 3 };
  const wCap = { ...w, rules };
  const many = [self]; for (let i = 1; i <= 8; i++) many.push(boat({ id: 'm' + i, x: 5000 + i * 10, y: 5000 }));
  b = balanceOfForce(wCap, self, buildShipGrid(wCap, many), null, 800, {});
  assert.equal(b.nAlly, 3, 'GROUP_MAX_ALLIES caps the tally');

  // Determinism: identical calls are byte-identical.
  const g = buildShipGrid(w, [self, a1, a2]);
  assert.deepEqual(balanceOfForce(w, self, g, foeGrid, 800, { foe }), balanceOfForce(w, self, g, foeGrid, 800, { foe }));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. Pirates gang up (the headline)
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('GANG UP: a lone weak raider FLEES a hunter, but with two consorts near it TURNS and fights', () => {
  const arm = (p, guns, bold) => { p.captain.traits = { boldness: bold, wanderlust: 0.3, greed: 0.3 }; p.captain.xp = { sea: 277, gun: 277, cmd: 277 }; p.type = 'brig'; p.hull = 1; p.rig = 1; p.morale = 0.85; p._huntCd = 0; p._prey = null; p._fleeing = false; p.cargo = { Gold: 0, People: 0, Food: 999, Weapons: guns }; };
  const mkHunter = (h, isl) => { h.privateer = true; h.pirate = false; h.homeId = isl.id; h.type = 'brig'; h.hull = 1; h.rig = 1; h.morale = 1; h.captain.xp = { sea: 2000, gun: 2000, cmd: 2000 }; h.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 40 }; };

  // ALONE → flee
  const w = makeWorld();
  for (const i of w.islands) i.haven = false;
  const pirate = w.ships[0], priv = w.ships[1];
  turnPirate(w, pirate); arm(pirate, 4, 0.35);
  pirate.x = 5000; pirate.y = 5000;
  mkHunter(priv, w.islands[1]); priv.x = 5300; priv.y = 5000;
  w.ships = w.ships.filter((s) => s === pirate || s === priv);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  // world._pirateGrid (the pirate ally-side) is built by `ship` upstream in the real pipeline; supply it here.
  const pirateGridOf = (world) => buildShipGrid(world, world.ships.filter((s) => s.pirate && !s._sunk));
  let fledAlone = false;
  for (let i = 0; i < 5; i++) { w._pirateGrid = pirateGridOf(w); piracy(w, STEP(w)); if (pirate._act && pirate._act.k === 'flee') fledAlone = true; }
  assert.ok(fledAlone, 'alone and weak, the raider runs from the hunter');

  // WITH TWO CONSORTS → stand
  const w2 = makeWorld();
  for (const i of w2.islands) i.haven = false;
  const p0 = w2.ships[0], hunter = w2.ships[1], c1 = w2.ships[2], c2 = w2.ships[3];
  for (const p of [p0, c1, c2]) { turnPirate(w2, p); arm(p, 4, 0.35); }
  p0.x = 5000; p0.y = 5000; c1.x = 5120; c1.y = 5000; c2.x = 4880; c2.y = 5000;
  mkHunter(hunter, w2.islands[1]); hunter.x = 5300; hunter.y = 5000;
  w2.ships = w2.ships.filter((s) => [p0, hunter, c1, c2].includes(s));
  w2.rules = { ...w2.rules, SINK_PER_1000: 0 };
  let stood = false;
  for (let i = 0; i < 5 && !p0._sunk; i++) { w2._pirateGrid = pirateGridOf(w2); piracy(w2, STEP(w2)); w2.simTime += w2.rules.COMBAT_ROUND_SEC; if (p0._act && p0._act.k === 'fight') stood = true; }
  assert.ok(stood, 'with two consorts in the rally bubble, the same weak raider TURNS on the hunter');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Privateers gang up
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('NAVY GANG UP: a cautious privateer shadows a strong raider alone but COMMITS with a consort', () => {
  const setup = (withConsort) => {
    const w = makeWorld();
    for (const i of w.islands) i.haven = false;
    const priv = w.ships[0], pirate = w.ships[1], consort = w.ships[2];
    const guard = w.islands[2];
    priv.pirate = false; priv.privateer = true; priv.homeId = guard.id; priv._guard = guard.id; priv.privateerUntil = w.simTime + 1e6;
    priv.captain.traits = { boldness: 0.2, wanderlust: 0.5, greed: 0.5 }; priv.captain.xp = { sea: 277, gun: 277, cmd: 277 };
    priv.type = 'brig'; priv.hull = 1; priv.rig = 1; priv.morale = 0.9; priv.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; priv.x = 5000; priv.y = 5000; priv._prey = null;
    turnPirate(w, pirate);
    pirate.captain.traits = { boldness: 0.6, wanderlust: 0.3, greed: 0.3 }; pirate.captain.xp = { sea: 2000, gun: 2000, cmd: 2000 };
    pirate.type = 'galleon'; pirate.hull = 1; pirate.rig = 1; pirate.morale = 1; pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 34 }; pirate.x = 5250; pirate.y = 5000; pirate._prey = null;
    const keep = [priv, pirate];
    if (withConsort) {
      consort.pirate = false; consort.privateer = true; consort.homeId = guard.id; consort._guard = guard.id; consort.privateerUntil = w.simTime + 1e6;
      consort.captain.xp = { sea: 2000, gun: 2000, cmd: 2000 }; consort.type = 'brig'; consort.hull = 1; consort.rig = 1; consort.morale = 1; consort.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 }; consort.x = 5120; consort.y = 5000; consort._prey = null;
      keep.push(consort);
    }
    w.ships = w.ships.filter((s) => keep.includes(s));
    w.rules = { ...w.rules, SINK_PER_1000: 0 };
    return { w, priv };
  };

  // world._privGrid (the privateer ally-side) is built by `piracy` upstream in the real pipeline; supply it here
  // (keeping the pirate stationary so the test isolates the PRIVATEER's engage decision).
  const ranHunt = ({ w, priv }) => {
    let hunted = false;
    for (let i = 0; i < 5; i++) {
      w._privGrid = buildShipGrid(w, w.ships.filter((s) => s.privateer && !s._sunk));
      antipiracy(w, STEP(w));
      if (priv._act && priv._act.k === 'hunt') hunted = true;
    }
    return hunted;
  };
  assert.ok(!ranHunt(setup(false)), 'alone, the cautious hunter shadows/patrols rather than charging a stronger raider');
  assert.ok(ranHunt(setup(true)), 'with a consort in the rally bubble, the cautious hunter COMMITS to the raider');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Wolfpack focus-fire
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('FOCUS-FIRE: a raider piles onto the prize a consort has already marked (deterministic)', () => {
  const w = makeWorld();
  for (const i of w.islands) i.haven = false;
  const P = w.ships[0], C = w.ships[1], A = w.ships[2], B = w.ships[3];
  for (const p of [P, C]) { turnPirate(w, p); p.captain.traits = { boldness: 0.5, wanderlust: 0.3, greed: 0.3 }; p.captain.xp = { sea: 277, gun: 277, cmd: 277 }; p.type = 'brig'; p.hull = 1; p.rig = 1; p.morale = 0.9; p.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; p._huntCd = 0; }
  for (const m of [A, B]) { m.pirate = false; m.privateer = false; m.state = 'outbound'; m.hull = 1; m.rig = 1; m.cargo = { Gold: 200, People: 0, Food: 5, Weapons: 0 }; }
  P.x = 5000; P.y = 5000; P._prey = null;
  A.x = 5400; A.y = 5000; B.x = 4600; B.y = 5000;         // equidistant, equal prize
  C.x = 5000; C.y = 5120; C._prey = A.id;                  // a consort already marking A
  w.ships = w.ships.filter((s) => [P, C, A, B].includes(s));
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  piracy(w, STEP(w));
  assert.equal(P._prey, A.id, 'the raider joins the consort on prize A rather than the equidistant B');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Opportunistic preemption (the "blindness" fix)
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('PREEMPT: a fed raider resting on its plunder cooldown still POUNCES on a prize right alongside', () => {
  const mk = (dx) => {
    const w = makeWorld();
    for (const i of w.islands) i.haven = false;
    const P = w.ships[0], M = w.ships[1];
    turnPirate(w, P);
    P.captain.traits = { boldness: 0.5, wanderlust: 0.3, greed: 0.3 }; P.captain.xp = { sea: 277, gun: 277, cmd: 277 };
    P.type = 'brig'; P.hull = 1; P.rig = 1; P.morale = 0.9; P.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 12 };
    P._huntCd = w.simTime + 1e4; P._prey = null; P.x = 5000; P.y = 5000;              // FED, armed, resting on cooldown
    M.pirate = false; M.privateer = false; M.state = 'outbound'; M.hull = 1; M.rig = 1; M.cargo = { Gold: 300, People: 0, Food: 5, Weapons: 0 };
    M.x = 5000 + dx; M.y = 5000;
    w.ships = w.ships.filter((s) => [P, M].includes(s));
    w.rules = { ...w.rules, SINK_PER_1000: 0 };
    piracy(w, STEP(w));
    return { P, M };
  };
  const near = mk(200);   // within PACK_PREEMPT_RANGE (320)
  assert.equal(near.P._act && near.P._act.k, 'hunt', 'the prize alongside overrides the rest cooldown — it hunts');
  assert.equal(near.P._prey, near.M.id);
  const farOff = mk(700); // beyond PACK_PREEMPT_RANGE → no preemption
  assert.notEqual(farOff.P._act && farOff.P._act.k, 'hunt', 'with no prize in preempt range, the fed raider keeps resting (blockade), not hunting');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. Privateer is not plunder-prey (bug fix + precondition)
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('PRIVATEER IS NOT PLUNDER: a raider never scores a privateer as a fat merchant', () => {
  const w = makeWorld();
  for (const i of w.islands) i.haven = false;
  const P = w.ships[0], V = w.ships[1];
  turnPirate(w, P);
  P.captain.traits = { boldness: 0.5, wanderlust: 0.3, greed: 0.3 }; P.captain.xp = { sea: 277, gun: 277, cmd: 277 };
  P.type = 'brig'; P.hull = 1; P.rig = 1; P.morale = 0.9; P.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; P._huntCd = 0; P._prey = null; P.x = 5000; P.y = 5000;
  V.pirate = false; V.privateer = true; V.homeId = w.islands[1].id; V.state = 'outbound'; V.hull = 1; V.rig = 1;
  V.cargo = { Gold: 500, People: 0, Food: 200, Weapons: 26 };                          // a fat-LOOKING hull — but a warship
  V.x = 5000 + w.rules.PIRATE_FLEE_PRIVATEER_RANGE + 200; V.y = 5000;                  // out of flee/fight reach, inside prey range
  w.ships = w.ships.filter((s) => [P, V].includes(s));
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  piracy(w, STEP(w));
  assert.notEqual(P._prey, V.id, 'the privateer is never marked as plunder-prey');
  assert.notEqual(P._act && P._act.k, 'hunt', 'and the raider does not hunt it as a merchant — it blockades/roves');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. Merchant flees a pack it would face down one-on-one
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('MERCHANT: a bold armed trader runs one weak raider’s blockade but FLEES a PACK', () => {
  const mkRaider = (r, isl, x, y) => { r.pirate = true; r.privateer = false; r.state = 'outbound'; r.captain = cap({ traits: { boldness: 0.5, wanderlust: 0.3, greed: 0.3 } }); r.captain.xp = { sea: 200, gun: 200, cmd: 200 }; r.type = 'sloop'; r.hull = 1; r.rig = 1; r.morale = 0.8; r.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 10 }; r.homeId = isl.id; r.x = x; r.y = y; };
  const mkMerchant = (w) => {
    const m = w.ships[0];
    m.pirate = false; m.privateer = false; m._sheltered = false; m._fleeing = false;
    m.captain.traits = { boldness: 0.95, wanderlust: 0.5, greed: 0.3 }; m.captain.xp = { sea: 4000, gun: 4000, cmd: 4000 };
    m.type = 'brig'; m.hull = 1; m.rig = 1; m.morale = 1; m.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 12 };
    m.state = 'outbound'; m.voyage = { reason: 'export', stops: [{ islandId: w.islands[5].id, sell: {}, buy: {}, people: 0 }], index: 0 };
    m.x = 5000; m.y = 5000;
    return m;
  };
  const D = (w) => w.rules.PIRATE_EVADE_RANGE * 0.7; // between runClear and the evade radius

  // ONE weak raider → runs the blockade (not fleeing)
  const w = makeWorld();
  for (const i of w.islands) i.haven = false;
  const m = mkMerchant(w);
  const r1 = w.ships[1]; mkRaider(r1, w.islands[1], 5000 + D(w), 5000);
  w.ships = w.ships.filter((s) => s === m || s === r1);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  ship(w, STEP(w));
  assert.ok(!m._fleeing, 'a lone weak raider off the bow — the bold armed trader holds her course (runs the blockade)');

  // THREE raiders → the summed guns clear the bar → she flees
  const w2 = makeWorld();
  for (const i of w2.islands) i.haven = false;
  const m2 = mkMerchant(w2);
  const [a, b, c] = [w2.ships[1], w2.ships[2], w2.ships[3]];
  mkRaider(a, w2.islands[1], 5000 + D(w2), 4960); mkRaider(b, w2.islands[1], 5000 + D(w2), 5000); mkRaider(c, w2.islands[1], 5000 + D(w2), 5040);
  w2.ships = w2.ships.filter((s) => [m2, a, b, c].includes(s));
  w2.rules = { ...w2.rules, SINK_PER_1000: 0 };
  ship(w2, STEP(w2));
  assert.ok(m2._fleeing, 'three raiders off the bow — she flees the pack she would have faced one-on-one');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 8. Determinism guard for the new code paths
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('DETERMINISM: a mixed melee replays identically from the same seed (no RNG/Date leak in the group logic)', () => {
  const build = () => {
    const w = makeWorld();
    for (const i of w.islands) i.haven = false;
    const [p0, p1, v0, v1, m0, m1] = w.ships.slice(0, 6);
    for (const p of [p0, p1]) { turnPirate(w, p); p.type = 'brig'; p.hull = 1; p.rig = 1; p.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 12 }; p._huntCd = 0; p._prey = null; }
    for (const v of [v0, v1]) { v.pirate = false; v.privateer = true; v.homeId = w.islands[2].id; v._guard = w.islands[2].id; v.privateerUntil = w.simTime + 1e6; v.type = 'brig'; v.hull = 1; v.rig = 1; v.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 20 }; v._prey = null; }
    for (const mm of [m0, m1]) { mm.pirate = false; mm.privateer = false; mm.state = 'outbound'; mm.hull = 1; mm.rig = 1; mm.cargo = { Gold: 200, People: 0, Food: 999, Weapons: 6 }; mm.voyage = { reason: 'export', stops: [{ islandId: w.islands[7].id, sell: {}, buy: {}, people: 0 }], index: 0 }; }
    p0.x = 5000; p0.y = 5000; p1.x = 5080; p1.y = 5040;
    v0.x = 5300; v0.y = 5000; v1.x = 5340; v1.y = 5060;
    m0.x = 5150; m0.y = 5100; m1.x = 5200; m1.y = 4950;
    w.ships = w.ships.filter((s) => [p0, p1, v0, v1, m0, m1].includes(s));
    w.rules = { ...w.rules, SINK_PER_1000: 0 };
    return w;
  };
  const run = (w) => {
    for (let i = 0; i < 120; i++) { ship(w, STEP(w)); piracy(w, STEP(w)); antipiracy(w, STEP(w)); w.simTime += STEP(w); }
    return w.ships.map((s) => ({ id: s.id, x: s.x, y: s.y, hull: s.hull, rig: s.rig, prey: s._prey || null, act: s._act && s._act.k }));
  };
  assert.deepEqual(run(build()), run(build()));
});
