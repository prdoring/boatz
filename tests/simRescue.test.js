// Aid & rescue at sea — the mercy valve, and where the diplomatic layer becomes PHYSICAL. A passing ally
// heaves-to for a crippled ship, giving SPARE canvas/timber/victuals. The decision runs off the captain's
// CARRIED knowledge (info by sea — not the live rep table), and the goodwill lands only when the helper
// next reports HOME (like recordTrade), so an alliance forged by a rescue propagates by sea, never teleports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { ship } from '/game/sim/ship.js';
import { renderAid, spareAboard, juryRig } from '/game/sim/repair.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.6, wanderlust: 0.5, greed: 0.3 }, ...over });
const boat = (over = {}) => ({ id: 's', homeId: 'h', x: 0, y: 0, type: 'brig', capacity: 400, hull: 1, rig: 1, morale: 0.6, cargo: { Gold: 0, People: 0 }, captain: cap(), ...over });
const merchant = (w) => w.ships.find((s) => !s.pirate && !s.privateer);

test('renderAid: a helper hands its SPARE canvas to a dismasted ally, who then mends HERSELF with it', () => {
  const w = makeWorld(); w.simTime = 0;
  const helper = boat({ cargo: { Gold: 0, People: 0, Fiber: 30, Wood: 30, Food: 100 } });
  const victim = boat({ id: 'v', homeId: 'other', rig: 0.08, hull: 0.6, cargo: { Gold: 0, People: 0, Food: 0 } });
  const fib0 = helper.cargo.Fiber;
  const ok = renderAid(w, helper, victim);
  assert.ok(ok, 'aid was rendered');
  assert.ok((victim.cargo.Fiber || 0) > 0, 'the victim RECEIVED spare canvas into her hold (she is not patched on the spot)');
  assert.ok(helper.cargo.Fiber < fib0, 'from the helper’s spare');
  // She mends herself from the supplies over the following days — jury-rig, not a teleport to full.
  const rig0 = victim.rig;
  for (let i = 0; i < 200; i++) juryRig(w, victim, w.rules.SIM_DAY_SECONDS);
  assert.ok(victim.rig > rig0, 'and jury-rigs the dismasted rig back up from the canvas given');
});

test('a stranded, hurt merchant HEAVES TO and jury-rigs — the SAME mechanic a raider uses (a boat is a boat)', () => {
  const w = makeWorld(); w.simTime = 0;
  const m = merchant(w);
  for (const i of w.islands) i.haven = true;            // no LAWFUL port in reach → she can't just limp to a yard
  w.ships = w.ships.filter((s) => s === m);             // isolate — no raiders to divert it
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  m.hull = 0.35; m.rig = 0.3; m._sheltered = false; m.adrift = null; m._fleeing = false; m._heaveUntil = 0;
  m.cargo = { Gold: 0, People: 0, Wood: 50, Fiber: 50 }; // carries repair timber (a stowed kit, or spars from a rescue)
  m.x = 5000; m.y = 5000; m.targetX = 20000; m.targetY = 5000; m.leg = null; m.legIdx = 0;
  m.state = 'outbound';
  m.voyage = { reason: 'trade', stops: [{ islandId: w.islands[0].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  const hull0 = m.hull, x0 = m.x;
  for (let i = 0; i < 60; i++) ship(w, w.rules.SIM_STEP);
  assert.equal(m._act && m._act.k, 'careen', 'she hove to and is making repairs — the same careen state as a raider');
  assert.ok(Math.abs(m.x - x0) < 1, 'dead in the water while she works, not sailing on');
  assert.ok(m.hull > hull0 + 0.005, `jury-rigging the hull up (${hull0} → ${m.hull.toFixed(3)})`);
  assert.ok((m.cargo.Wood || 0) < 50, 'from her own timber');
});

test('a prolonged rescue of the SAME ship is logged once, not on every pass', () => {
  const w = makeWorld(); w.simTime = 0;
  const helper = boat({ cargo: { Gold: 0, People: 0, Fiber: 99, Wood: 99, Food: 999 } });
  const victim = boat({ id: 'v', homeId: 'other', rig: 0.05, hull: 0.3, cargo: { Gold: 0, People: 0, Food: 0 } });
  renderAid(w, helper, victim);
  renderAid(w, helper, victim);
  renderAid(w, helper, victim);
  assert.equal(w.events.filter((e) => e.kind === 'rescue').length, 1, 'aiding the same stricken ship pass after pass is ONE deed in the log');
  const other = boat({ id: 'v2', homeId: 'other', rig: 0.05, hull: 0.3, cargo: { Gold: 0, People: 0, Food: 0 } });
  renderAid(w, helper, other);
  assert.equal(w.events.filter((e) => e.kind === 'rescue').length, 2, 'a different ship in distress is a fresh story');
});

test('a sea-rescue does NOT change reputation on the spot — the deed is only recorded aboard to report home', () => {
  const w = makeWorld(); w.simTime = 0;
  const hHome = w.islands[0], vHome = w.islands[1];
  const helper = boat({ homeId: hHome.id, cargo: { Gold: 0, People: 0, Fiber: 30, Wood: 30, Food: 100 } });
  const victim = boat({ id: 'v', homeId: vHome.id, rig: 0.08 });
  const rep0 = hHome.rep[vHome.id] || 0;
  renderAid(w, helper, victim);
  assert.equal(hHome.rep[vHome.id] || 0, rep0, 'no goodwill teleports mid-ocean');
  assert.ok(helper._aidDeeds && helper._aidDeeds.some((d) => d.otherHome === vHome.id), 'the deed is recorded to report at the quay');
});

test('only SPARE goods are given — a helper down to its own reserve hands over nothing', () => {
  const w = makeWorld(); w.simTime = 0;
  const helper = boat({ cargo: { Gold: 0, People: 0, Fiber: 5, Wood: 5, Food: 3 } }); // all at/below the keep reserve
  const victim = boat({ id: 'v', homeId: 'other', rig: 0.1, hull: 0.6, cargo: { Gold: 0, People: 0, Food: 0 } });
  assert.equal(spareAboard(helper, 'Fiber', w.rules.RESCUE_KEEP_FIBER), 0, 'no canvas to spare');
  const ok = renderAid(w, helper, victim);
  assert.equal(ok, false, 'nothing to spare → no aid rendered');
  assert.equal(victim.rig, 0.1, 'the victim got nothing');
});

test('a passing ship AIDS a carried ally in distress — off CARRIED knowledge, not the live rep table', () => {
  const w = makeWorld(); w.simTime = 2 * w.rules.SIM_DAY_SECONDS;
  const helper = merchant(w);
  const victim = w.ships.find((s) => s !== helper && !s.pirate && !s.privateer);
  const vHome = w.islands.find((i) => i.id !== helper.homeId);
  const hHome = w.islandsById.get(helper.homeId);
  victim.homeId = vHome.id;
  helper._allies = { [vHome.id]: 1 }; helper._embargoes = {}; helper._rescueCd = 0; // CARRIES the alliance
  if (hHome && hHome.rep) hHome.rep[vHome.id] = 0;            // …while LIVE rep is neutral (must not be consulted)
  helper.x = 3000; helper.y = 3000; helper.state = 'outbound';
  helper.voyage = { reason: 'trade', stops: [{ islandId: vHome.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  helper.cargo = { Gold: 0, People: 0, Fiber: 40, Wood: 40, Food: 200 };
  helper.captain.traits = { boldness: 0.7, wanderlust: 0.5, greed: 0.2 }; // generous, not cautious
  victim.x = 3050; victim.y = 3000; victim.rig = 0.08; victim.hull = 0.7; victim._sunk = false; victim.adrift = null;
  victim.cargo = { Gold: 0, People: 0, Food: 0 };            // starts with no repair timber → any it has after = from aid
  victim.voyage = { reason: 'trade', stops: [{ islandId: w.islands[2].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  victim.state = 'outbound';
  for (let i = 0; i < 10; i++) ship(w, w.rules.SIM_STEP);
  assert.ok((victim.cargo.Fiber || 0) > 0 || (victim.cargo.Wood || 0) > 0, 'the ally handed over spare canvas/timber for her to mend herself with');
  assert.ok(helper._aidDeeds && helper._aidDeeds.length, 'and recorded the deed to report home');
});

test('a ship does NOT stop for a stranger it carries no alliance with', () => {
  const w = makeWorld(); w.simTime = 2 * w.rules.SIM_DAY_SECONDS;
  const helper = merchant(w);
  const victim = w.ships.find((s) => s !== helper && !s.pirate && !s.privateer);
  const vHome = w.islands.find((i) => i.id !== helper.homeId);
  victim.homeId = vHome.id;
  helper._allies = {}; helper._embargoes = {}; helper._rescueCd = 0; // carries NO alliance with the victim's home
  helper.x = 3000; helper.y = 3000; helper.state = 'outbound';
  helper.voyage = { reason: 'trade', stops: [{ islandId: vHome.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  helper.cargo = { Gold: 0, People: 0, Fiber: 40, Wood: 40, Food: 200 };
  helper.captain.traits = { boldness: 0.7, wanderlust: 0.5, greed: 0.2 };
  victim.x = 3050; victim.y = 3000; victim.rig = 0.08; victim.hull = 0.7; victim._sunk = false; victim.adrift = null;
  victim.voyage = { reason: 'trade', stops: [{ islandId: w.islands[2].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  victim.state = 'outbound';
  const rig0 = victim.rig;
  for (let i = 0; i < 10; i++) ship(w, w.rules.SIM_STEP);
  assert.equal(victim.rig, rig0, 'a stranger is left to fend for herself');
});

test('a cautious captain will NOT heave-to in dangerous, pirate-haunted waters', () => {
  const w = makeWorld(); w.simTime = 2 * w.rules.SIM_DAY_SECONDS;
  const helper = merchant(w);
  const victim = w.ships.find((s) => s !== helper && !s.pirate && !s.privateer);
  const isle = w.islands[0];
  const vHome = w.islands.find((i) => i.id !== helper.homeId);
  victim.homeId = vHome.id;
  helper._allies = { [vHome.id]: 1 }; helper._embargoes = {}; helper._rescueCd = 0;
  isle.danger = 0.95;                                           // these waters are feared
  helper.x = isle.x + 40; helper.y = isle.y; helper.state = 'outbound';
  helper.voyage = { reason: 'trade', stops: [{ islandId: vHome.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  helper.cargo = { Gold: 0, People: 0, Fiber: 40, Wood: 40, Food: 200 };
  helper.captain.traits = { boldness: 0.2, wanderlust: 0.5, greed: 0.2 }; // CAUTIOUS
  victim.x = isle.x + 70; victim.y = isle.y; victim.rig = 0.08; victim.hull = 0.7; victim._sunk = false; victim.adrift = null;
  victim.voyage = { reason: 'trade', stops: [{ islandId: w.islands[2].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  victim.state = 'outbound';
  const rig0 = victim.rig;
  for (let i = 0; i < 10; i++) ship(w, w.rules.SIM_STEP);
  assert.equal(victim.rig, rig0, 'discretion is the better part of valour — no rescue in deadly seas');
});

test('the goodwill from a rescue lands at the QUAY — rep rises only when the helper reports home', () => {
  const w = makeWorld(); w.simTime = 3 * w.rules.SIM_DAY_SECONDS;
  const helper = merchant(w);
  const home = w.islandsById.get(helper.homeId);
  const vHome = w.islands.find((i) => i.id !== home.id);
  helper._aidDeeds = [{ otherHome: vHome.id, day: 1 }];
  const rep0 = home.rep[vHome.id] || 0;
  // Essentially home, inbound, voyage run out → she docks and reports this pass.
  helper.state = 'inbound';
  helper.voyage = { reason: 'trade', stops: [{ islandId: vHome.id, sell: {}, buy: {}, people: 0 }], index: 1 };
  helper.cargo = { Gold: 0, People: 0 };
  helper.x = home.x; helper.y = home.y; helper.leg = null; helper.targetX = home.x; helper.targetY = home.y;
  for (let i = 0; i < 30 && helper.state === 'inbound'; i++) ship(w, w.rules.SIM_STEP);
  assert.ok((home.rep[vHome.id] || 0) > rep0, 'reputation with the rescued ship’s home rose — at the dock, not at sea');
  assert.ok(!helper._aidDeeds, 'the deed was reported and cleared');
});
