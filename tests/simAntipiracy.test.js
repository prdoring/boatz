// Anti-piracy — the economy fighting back. Bounties (a treasury sink posted by victims, paid to
// the pirate's killer), danger that makes waters feared (merchants route around it), and
// PRIVATEERS commissioned from an idle trader at a real cost (gold wages + guns from the armoury —
// nothing free). These tests lock those economic invariants in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { markDanger, postBounty, payBounty, nearestIsland } from '/game/sim/bounty.js';
import { antipiracy, privateerCount } from '/game/sim/antipiracy.js';
import { turnPirate } from '/game/sim/piracy.js';
import { findBestPartner } from '/game/sim/queries.js';

test('an attack marks the nearest waters dangerous, and danger decays as peace returns', () => {
  const w = makeWorld();
  const isl = w.islands[0];
  isl.danger = 0;
  markDanger(w, isl.x + 20, isl.y + 20, 'raid');
  assert.ok(isl.danger > 0, 'a raid nearby raised the danger');
  const spiked = isl.danger;
  // Run antipiracy with no pirates → danger only decays.
  for (let i = 0; i < 200; i++) { antipiracy(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
  assert.ok(isl.danger < spiked, 'danger fades over time');
});

test('a bounty is a treasury sink for the poster, paid out to the pirate-killer', () => {
  const w = makeWorld();
  const poster = w.islands[0], hunterHome = w.islands[1];
  const pirate = w.ships[0];
  turnPirate(w, pirate);
  poster.gold = 5000; hunterHome.gold = 1000;
  const before = poster.gold;
  postBounty(w, pirate, poster.id, 'raid');
  assert.ok(pirate.bounty > 0, 'gold was placed on the pirate’s head');
  assert.ok(poster.gold < before, 'the poster paid for the bounty up front (a sink until claimed)');
  const reward = pirate.bounty;
  const paid = payBounty(w, pirate, hunterHome.id);
  assert.equal(paid, reward, 'the full bounty was paid');
  assert.equal(pirate.bounty, 0, 'the bounty is cleared once claimed');
  assert.equal(hunterHome.gold, 1000 + reward, 'the killer’s home collected the reward');
});

test('a threatened, solvent, armed port commissions a privateer — paying gold + guns (nothing free)', () => {
  const w = makeWorld();
  const t = w.rules;
  const port = w.islands[0];
  // A wealthy, armed port with an idle trader at home and a pirate in its waters.
  port.gold = 5000;
  port.stock.Weapons = 40;
  const hull = w.ships.find((s) => s.homeId === port.id) || w.ships[0];
  hull.homeId = port.id; hull.state = 'idle'; hull.voyage = null; hull.ownerId = 'npc';
  const pirate = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = port.x + 200; pirate.y = port.y + 200; // inside PRIVATEER_THREAT_RANGE

  const goldBefore = port.gold, weaponsBefore = port.stock.Weapons, privBefore = privateerCount(w);
  antipiracy(w, t.SIM_STEP);

  assert.equal(privateerCount(w), privBefore + 1, 'a privateer was commissioned');
  assert.equal(hull.privateer, true, 'the idle trader took the commission');
  assert.ok(port.gold < goldBefore, 'crew wages came out of the treasury (a gold cost)');
  assert.ok(port.stock.Weapons < weaponsBefore, 'the privateer armed from the armoury (a weapons cost)');
  assert.ok((hull.cargo.Weapons || 0) > 0, 'it sailed armed');
});

test('a privateer runs down a pirate, sinks it, and claims the bounty for home', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PRIZE_RECOVER_CHANCE: 0 }; // isolate the SINK outcome (no recovery this test)
  const port = w.islands[0];
  const priv = w.ships[0], pirate = w.ships[1];
  turnPirate(w, pirate);
  pirate.bounty = 300; pirate.morale = 0.3; pirate.cargo.Weapons = 2; pirate.captain.xp = 0;
  // Hand-commission a strong privateer sitting right on the pirate.
  priv.privateer = true; priv.homeId = port.id;
  priv.privateerUntil = w.simTime + 10 * w.rules.SIM_DAY_SECONDS;
  priv.morale = 1; priv.cargo = { Gold: 0, People: 0, Weapons: 30, Food: 200 };
  priv.captain.xp = 5000;
  priv.x = pirate.x = 2000; priv.y = pirate.y = 2000;
  port.gold = 1000;

  const before = port.gold;
  const xpBefore = priv.captain.xp;
  // Combat is now ATTRITION over rounds (paced by _fightCd = COMBAT_ROUND_SEC), not a single roll — so
  // run the hunt round by round (advancing sim time a round each pass) until the outmatched raider founders.
  for (let i = 0; i < 80 && !pirate._sunk; i++) {
    antipiracy(w, w.rules.SIM_STEP);
    w.simTime += w.rules.COMBAT_ROUND_SEC;
  }

  assert.ok(!w.ships.includes(pirate) || pirate._sunk, 'the pirate was sunk');
  assert.equal(port.gold, before + 300, 'the privateer’s home collected the 300g bounty');
  assert.ok(priv.captain.xp.gun > xpBefore, 'the hunter’s captain earned experience for the kill (grows more skilled)');
});

test('a privateer may RECOVER a beaten pirate — the hull is restored to honest trade at its home port', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PRIZE_RECOVER_CHANCE: 1, MAX_SHIPS_PER_ISLAND: 999 }; // certain recovery; always a berth
  const port = w.islands[0];
  const priv = w.ships[0], pirate = w.ships[1];
  turnPirate(w, pirate);
  pirate.morale = 0.3; pirate.cargo.Weapons = 2; pirate.captain.xp = 0; pirate.hull = 1; pirate.rig = 1;
  priv.privateer = true; priv.homeId = port.id; priv._guard = port.id;
  priv.privateerUntil = w.simTime + 10 * w.rules.SIM_DAY_SECONDS;
  priv.morale = 1; priv.cargo = { Gold: 0, People: 0, Weapons: 30, Food: 200 };
  priv.captain.xp = 5000;
  priv.x = pirate.x = 2000; priv.y = pirate.y = 2000;

  for (let i = 0; i < 80 && pirate.pirate && !pirate._sunk; i++) {
    antipiracy(w, w.rules.SIM_STEP);
    w.simTime += w.rules.COMBAT_ROUND_SEC;
  }

  assert.ok(!pirate._sunk, 'the raider was taken as a prize, not sent under');
  assert.equal(pirate.pirate, false, 'she no longer flies the black flag');
  assert.equal(pirate.homeId, port.id, 'and was returned to the commissioning port as a lawful vessel');
});

test('a besieging privateer CLEARS the haven’s screen before battering the walls', () => {
  const w = makeWorld();
  const den = w.islands[0];
  den.haven = true; den.havenStrength = 0.85;
  const priv = w.ships[0];
  priv.privateer = true; priv.homeId = w.islands[1].id; priv._guard = w.islands[1].id;
  priv.privateerUntil = w.simTime + 10 * w.rules.SIM_DAY_SECONDS;
  priv.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 26 };
  priv.x = den.x + 300; priv.y = den.y; // inside HAVEN_SUPPRESS_RANGE → besieging
  const pirate = w.ships[1];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 6 };
  pirate.x = den.x + 500; pirate.y = den.y; // a defender within HAVEN_DEFEND_RANGE of the den, not at gun-range
  w.ships = w.ships.filter((s) => s === priv || s === pirate);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  antipiracy(w, w.rules.SIM_STEP);
  assert.ok(priv._act && priv._act.k === 'hunt' && priv._act.id === pirate.id,
    'the privateer turned on the defending pirate rather than blindly bombarding the haven');
});

test('a STARVING privateer breaks off to victual at its guard port (hunger forces the drastic action)', () => {
  const w = makeWorld();
  const guard = w.islands[0];
  guard.stock.Food = 200;
  const priv = w.ships[0];
  priv.privateer = true; priv.homeId = guard.id; priv._guard = guard.id;
  priv.privateerUntil = w.simTime + 10 * w.rules.SIM_DAY_SECONDS;
  priv.cargo = { Gold: 0, People: 0, Food: 0.2, Weapons: 20 }; // provisions all but gone
  priv.x = guard.x; priv.y = guard.y;                          // right at the port → it victuals this step
  const pirate = w.ships[1]; turnPirate(w, pirate);            // a threat exists (so it doesn't stand down)…
  pirate.x = guard.x + 5000; pirate.y = guard.y;               // …but far off, so it isn't at gun-range
  w.ships = w.ships.filter((s) => s === priv || s === pirate);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  const before = priv.cargo.Food || 0;
  antipiracy(w, w.rules.SIM_STEP);
  assert.ok(priv._act && priv._act.k === 'resupply', 'the hungry hunter is making for its larder');
  assert.ok((priv.cargo.Food || 0) > before, 'it topped up food free from the guard port’s stores');
});

test('danger routing: a merchant shuns a port it HAS HEARD is pirate-haunted for a safe one', () => {
  const w = makeWorld();
  const home = w.islands[0];
  // Give two other islands identical stock/gold of a good; make one dangerous.
  const good = 'Wood';
  const [safe, risky] = [w.islands[1], w.islands[2]];
  for (const p of [safe, risky]) { p.stock[good] = 500; p.price[good].mid = home.price[good].mid; p.danger = 0; }
  risky.danger = 1; // fully feared waters

  // Information travels by sea: with NO word of the danger, the home can't route around it.
  const naive = findBestPartner(w, home, good, 'import');
  assert.ok(naive, 'a partner was found');

  // Now a ship has carried the sighting home — the port BELIEVES risky is dangerous (today).
  home.intel = { [risky.id]: { day: 0, danger: 1, haven: false, foodDays: 5, lawless: 0 } };
  const pick = findBestPartner(w, home, good, 'import');
  assert.ok(pick, 'a partner was found');
  assert.notEqual(pick.partner.id, risky.id, 'a port KNOWN to be dangerous is avoided when a safe equal exists');
});
