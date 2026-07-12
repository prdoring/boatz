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
  antipiracy(w, w.rules.SIM_STEP);

  assert.ok(!w.ships.includes(pirate) || pirate._sunk, 'the pirate was sunk');
  assert.equal(port.gold, before + 300, 'the privateer’s home collected the 300g bounty');
});

test('danger routing: a merchant shuns a pirate-haunted port for a safe one', () => {
  const w = makeWorld();
  const home = w.islands[0];
  // Give two other islands identical stock/gold of a good; make one dangerous.
  const good = 'Wood';
  const [safe, risky] = [w.islands[1], w.islands[2]];
  for (const p of [safe, risky]) { p.stock[good] = 500; p.price[good].mid = home.price[good].mid; p.danger = 0; }
  risky.danger = 1; // fully feared waters
  // Import: prefer the safe seller even though both are equivalent.
  const pick = findBestPartner(w, home, good, 'import');
  assert.ok(pick, 'a partner was found');
  assert.notEqual(pick.partner.id, risky.id, 'the dangerous port is avoided when a safe equal exists');
});
