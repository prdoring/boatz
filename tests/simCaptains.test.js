// Captains — seeded names + personality, experience → skill → rank, and personality → the
// decision knobs that shape a voyage. Plus the observable payoff: a skilled captain TACKS a
// strong headwind (a visible dogleg) while a novice bulls straight into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { makeCaptain, skill01, rankOf, awardVoyageXp, navProfile, personalityOf } from '/game/sim/captains.js';
import { stepWorld } from '/game/sim/world.js';

test('makeCaptain is deterministic for a given seed and gives a name, traits, personality', () => {
  const a = makeWorld(), b = makeWorld();
  const ca = makeCaptain(a), cb = makeCaptain(b);
  assert.equal(ca.name, cb.name);
  assert.deepEqual(ca.traits, cb.traits);
  assert.equal(ca.personality, cb.personality);
  assert.ok(ca.name.length > 0 && ca.xp === 0);
  for (const k of ['boldness', 'wanderlust', 'greed']) assert.ok(ca.traits[k] >= 0 && ca.traits[k] <= 1);
});

test('skill rises with experience from 0 toward 1', () => {
  const w = makeWorld();
  const s0 = skill01({ xp: 0 }, w.rules);
  const s1 = skill01({ xp: 400 }, w.rules);
  const s2 = skill01({ xp: 2000 }, w.rules);
  assert.equal(s0, 0);
  assert.ok(s1 > s0 && s2 > s1 && s2 < 1);
});

test('rank climbs with xp; awardVoyageXp adds a per-hop bonus', () => {
  assert.equal(rankOf({ xp: 0 }), 'Novice');
  assert.notEqual(rankOf({ xp: 5000 }), 'Novice');
  const w = makeWorld();
  const one = { xp: 0 }, three = { xp: 0 };
  awardVoyageXp(one, w.rules, 1);
  awardVoyageXp(three, w.rules, 3);
  assert.ok(three.xp > one.xp, 'a 3-stop run earns more than a 1-stop run');
});

test('personalityOf names the most pronounced trait, else Steady', () => {
  assert.equal(personalityOf({ boldness: 0.95, wanderlust: 0.5, greed: 0.5 }), 'Bold');
  assert.equal(personalityOf({ boldness: 0.05, wanderlust: 0.5, greed: 0.5 }), 'Cautious');
  assert.equal(personalityOf({ boldness: 0.5, wanderlust: 0.95, greed: 0.5 }), 'Wanderer');
  assert.equal(personalityOf({ boldness: 0.5, wanderlust: 0.5, greed: 0.5 }), 'Steady');
});

test('navProfile: bold captains range farther and never dawdle; greedy captains hold out', () => {
  const w = makeWorld();
  const bold = navProfile({ traits: { boldness: 0.95, wanderlust: 0.5, greed: 0.5 } }, w.rules);
  const cautious = navProfile({ traits: { boldness: 0.05, wanderlust: 0.5, greed: 0.5 } }, w.rules);
  assert.ok(bold.travelMult < cautious.travelMult, 'bold discounts travel → ranges farther');
  assert.equal(bold.patient, false);
  assert.equal(cautious.patient, true);
  const greedy = navProfile({ traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.95 } }, w.rules);
  const easy = navProfile({ traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.05 } }, w.rules);
  assert.ok(greedy.profitMult > easy.profitMult, 'greed raises the profit bar');
  const wanderer = navProfile({ traits: { boldness: 0.5, wanderlust: 0.95, greed: 0.5 } }, w.rules);
  assert.ok(wanderer.scoutStale < cautious.scoutStale, 'wanderlust scouts sooner');
});

test('a skilled captain tacks a strong headwind; a novice sails straight into it', () => {
  const setup = (xp) => {
    const w = makeWorld();
    const home = w.islands[0];
    const target = w.islands.find((i) => i !== home);
    const bearing = Math.atan2(target.y - home.y, target.x - home.x);
    // Wind blows FROM the target → sailing there is dead upwind. Frozen (target == current).
    const dir = bearing + Math.PI;
    w.wind = { dir, str: 1, tDir: dir, tStr: 1, nextShift: 1e12 };
    const ship = w.ships.find((s) => s.homeId === home.id);
    ship.captain = { name: 'T', xp, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, personality: 'Steady' };
    ship.state = 'idle';
    ship.voyage = { reason: 'food', stops: [{ islandId: target.id, sell: {}, buy: {}, people: 0 }], index: 0 };
    stepWorld(w, w.rules.SIM_STEP); // one substep: idle → load → plan leg → outbound
    return ship;
  };
  const veteran = setup(3000);
  const novice = setup(0);
  assert.equal(veteran.state, 'outbound');
  assert.equal(veteran.leg.length, 2, 'veteran plots a tacking dogleg');
  assert.equal(novice.leg.length, 1, 'novice sails a straight (slow) course');
});
