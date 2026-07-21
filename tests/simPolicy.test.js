// The MAGISTRATE POLICY LOOP (policy.js) — Phase 2, the industry lever. A magistrate builds a
// workshop into an open slot (serving its ambition + the market), tears down one left derelict, and
// — crucially — reasons about suppliers from its OWN stale intel, never live remote truth (the
// no-omniscience invariant). PURE-sim tests: step the `policy` system directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { mutateWorkshops } from '/game/sim/island.js';
import { policy } from '/game/sim/policy.js';
import { upkeep } from '/game/sim/upkeep.js';
import { governance } from '/game/sim/magistrate.js';
import { tariffMult } from '/game/sim/reputation.js';

function aDayLater(w) { w.simTime += w.rules.SIM_DAY_SECONDS + 1; }
const industrialOf = (isl, t) => isl.workshops.filter((s) => t.INDUSTRIAL_GOODS.includes(s.good)).map((s) => s.good);

test('a magistrate builds a workshop into an open slot when it can afford, staff, and score one', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  mutateWorkshops(w, isl, [{ good: 'Food', condition: 1 }]); // a clean slate: 0 industry, open berths
  isl.population = 300;                                       // enough hands to crew a works
  isl.gold = t.WORKSHOP_BUILD_GOLD + t.POLICY_TREASURY_RESERVE + 2000;
  isl.stock.Wood = 300; isl.stock.Iron = 300;                // timber + iron to build with
  const gold0 = isl.gold;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.equal(industrialOf(isl, t).length, 1, 'exactly one industrial workshop was raised');
  assert.ok(isl.gold < gold0, 'it paid gold for the works');
  assert.deepEqual(isl.produces, isl.workshops.map((s) => s.good), 'produces stays derived from workshops');
});

test('a poor / material-less port cannot build; a full port does not overbuild', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  mutateWorkshops(w, isl, [{ good: 'Food', condition: 1 }]);
  isl.population = 300; isl.gold = 50; isl.stock.Wood = 0; isl.stock.Iron = 0; // no coin, no materials
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.equal(industrialOf(isl, t).length, 0, 'too poor + no materials → nothing built');
});

test('ambition steers the build: a fortify magistrate raises a gun-foundry (Weapons)', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  mutateWorkshops(w, isl, [{ good: 'Food', condition: 1 }]);
  isl.magistrate.ambition = { kind: 'fortify', progress: 0.35 };
  isl.population = 300; isl.gold = 999999; isl.stock.Wood = 500; isl.stock.Iron = 500;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok(industrialOf(isl, t).includes('Weapons'), 'the fortify magistrate favoured Weapons');
});

test('a workshop left idle/derelict past the grace period is demolished (frees the slot + the bleed)', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  mutateWorkshops(w, isl, [{ good: 'Weapons', condition: 0 }, { good: 'Food', condition: 1 }]);
  const shop = isl.workshops.find((s) => s.good === 'Weapons');
  shop._st = 2; shop._lowDays = t.WORKSHOP_DERELICT_DAYS; // marked derelict long enough to retire
  isl.population = 300;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok(!isl.workshops.some((s) => s.good === 'Weapons'), 'the derelict gun-foundry was pulled down');
  assert.ok(isl.produces.includes('Food') && !isl.produces.includes('Weapons'), 'produces reflects the demolition');
});

test('FISCAL: a heavier tax yields more treasury income (upkeep)', () => {
  const gain = (tax) => {
    const w = makeWorld(); const t = w.rules;
    const isl = w.islands[0];
    isl.magistrate.traits.integrity = 1;        // honest → no skim, isolate the tax effect
    isl.population = 300; isl.civ = 0.5; isl.tax = tax; isl.gold = 1000;
    isl.workshops = isl.workshops.filter((s) => !t.INDUSTRIAL_GOODS.includes(s.good)); // no workshop-upkeep noise
    w.ships = w.ships.filter((s) => s.homeId !== isl.id);                              // no ship-upkeep noise
    const g0 = isl.gold; upkeep(w, t.SIM_DAY_SECONDS); return isl.gold - g0;
  };
  assert.ok(gain(0.4) > gain(0), 'a heavier levy raises the day’s income');
});

test('FISCAL: a tax hike pushes the populace’s approval down (tryTax)', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.magistrate.ambition = { kind: 'wealth', progress: 0.35 };
  isl.magistrate.traits.generosity = 0.2;       // not too generous → willing to raise
  isl.loyalty = 0.9;                            // secure → allowed to raise
  isl.gold = 100;                               // treasury pinch → wants revenue
  isl.tax = 0; isl._approval = 0;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok(isl.tax > 0, 'the magistrate raised taxes');
  assert.ok(isl._approval < 0, 'the hike soured the populace');
});

test('CORRUPTION: a venal magistrate skims a hidden hoard; toppling one returns wealth to the treasury', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  const mag = isl.magistrate;
  mag.traits.integrity = 0;                     // maximally corrupt → max skim
  mag.hoard = 0; isl.population = 400; isl.civ = 0.8; isl.tax = 0.3; isl.gold = 1000;
  for (let d = 0; d < 5; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.ok(mag.hoard > 0, `the corrupt magistrate skimmed a hoard (${Math.round(mag.hoard)})`);

  // Force repeated rebellion resolutions on a weak, corrupt ruler until the people cast it out; the
  // seized hoard must boost the treasury (toppling a grafter PAYS — an honest failure would not).
  mag.hoard = 8000; mag.traits.firmness = 0; mag.xp = 0; isl.grievance = 1; isl.gold = 500;
  const goldBefore = isl.gold;
  let overthrown = false;
  for (let i = 0; i < 50 && !overthrown; i++) {
    isl.rebellion = { until: w.simTime };
    w.simTime += t.SIM_DAY_SECONDS;
    governance(w, t.SIM_DAY_SECONDS);
    if (w.events.some((e) => e.kind === 'graftseized')) overthrown = true;
  }
  assert.ok(overthrown, 'a weak, corrupt magistrate was eventually cast out');
  assert.ok(isl.gold > goldBefore, 'the seized hoard boosted the treasury');
});

test('TRADE: a host duties FOREIGN traders but exempts its own fleet (tariffMult)', () => {
  const w = makeWorld();
  const host = w.islands[0]; host.tariff = 0.2;
  assert.ok(Math.abs(tariffMult(host, 'someForeignId') - 1.2) < 1e-9, 'a foreigner pays the 20% duty on the ask');
  assert.equal(tariffMult(host, host.id), 1, 'the host’s own fleet trades duty-free');
});

test('TRADE: a starving port withholds Food from export; a fed one releases the hold (tryHolds)', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.population = 300; isl.stock.Food = 0;         // larder empty → hold
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok((isl._holds || []).includes('Food'), 'a starving port withholds Food from foreign export');
  isl.stock.Food = 999999;                          // plenty → release
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok(!(isl._holds || []).includes('Food'), 'a well-fed port releases the hold');
});

test('INFRASTRUCTURE: a public work lifts civ and warms approval', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.magistrate.ambition = { kind: 'splendor', progress: 0.35 }; // splendor → publicworks, NOT naval
  isl.civ = 0.3; isl.gold = 999999; isl._approval = 0;
  isl.loyalty = 0.5;                                // in the tax hysteresis dead-band → tryTax holds (isolate the boost)
  isl.stock.Wood = 0; isl.stock.Iron = 0;           // no materials → build can't fire, so publicworks does
  const civ0 = isl.civ;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.ok(isl.civ > civ0, 'the public work lifted civ');
  assert.ok(isl._approval > 0, 'and warmed the populace');
});

test('NAVAL: a fleet-ambition mayor commissions a hull through the policy loop (development folded in)', () => {
  const w = makeWorld(); const t = w.rules;
  const buyer = w.islands[0];
  buyer.magistrate.ambition = { kind: 'wealth', progress: 0.35 }; // a fleet ambition
  buyer.gold = t.DEVELOP_SHIP_GOLD + t.POLICY_TREASURY_RESERVE + 4000;
  buyer.stock.Ships = 0; buyer.stock.Wood = 0; buyer.stock.Iron = 0; // no materials → BUILD can't pre-empt NAVAL
  buyer._devCd = 0;
  const yard = w.islands[1]; yard.stock.Ships = 2;
  buyer.rep[yard.id] = 0.1; yard.rep[buyer.id] = 0.1;
  const owned0 = w.ships.filter((s) => s.homeId === buyer.id).length;
  aDayLater(w); policy(w, t.SIM_STEP);
  assert.equal(w.ships.filter((s) => s.homeId === buyer.id).length, owned0 + 1, 'a hull was commissioned via the naval lever');
});

// #2 (starving tail): pre-#1 a hull cost ~4,780 to buy (pop ≥ ~120); post-#1 it's ~2,260 (pop ≥ ~57), and
// the Phase-3/4 tax + public-works levers let a modest port fund GROWTH toward that. Here a pop-60 port
// that levies tax reaches the hull-buy threshold — where pre-#1 its 40·pop hoard cap never could.
test('STARVING TAIL (#2): a taxing modest port can now reach the hull-buy threshold', () => {
  const w = makeWorld(); const t = w.rules;
  const isl = w.islands[0];
  isl.magistrate.traits.integrity = 1;               // honest → no skim
  isl.population = 60; isl.civ = 0.5; isl.gold = 200; isl.tax = 0.3;
  isl.workshops = isl.workshops.filter((s) => !t.INDUSTRIAL_GOODS.includes(s.good)); // isolate income
  w.ships = w.ships.filter((s) => s.homeId !== isl.id);
  for (let d = 0; d < 40; d++) { w.simTime += t.SIM_DAY_SECONDS; upkeep(w, t.SIM_DAY_SECONDS); }
  assert.ok(isl.gold >= 2260, `a taxing modest port reaches the ~2,260g hull-buy bar (${Math.round(isl.gold)})`);
});

test('NO OMNISCIENCE: the build decision ignores a supplier’s LIVE danger — it reads only own intel', () => {
  // Run the SAME build scenario twice, once with every other port live-calm and once with every one
  // live-ABLAZE. The deciding island carries no intel of the wider sea, so believedDanger returns the
  // same (unknown) risk both times → the decision must be identical. If policy peeked at live remote
  // truth, the two would diverge. This is the "information travels by sea" contract, in a test.
  const decide = (liveDanger) => {
    const w = makeWorld();
    const t = w.rules;
    const isl = w.islands[0];
    mutateWorkshops(w, isl, [{ good: 'Food', condition: 1 }]);
    isl.population = 300; isl.gold = 999999; isl.stock.Wood = 500; isl.stock.Iron = 500;
    isl.intel = {}; isl.beliefs = {};                        // it knows nothing of the other ports
    for (const o of w.islands) if (o !== isl) o.danger = liveDanger; // live truth the island can't see
    aDayLater(w); policy(w, t.SIM_STEP);
    return industrialOf(isl, t).sort();
  };
  assert.deepEqual(decide(0.0), decide(0.95), 'identical build whether suppliers are live-calm or live-ablaze');
});
