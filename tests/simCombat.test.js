// Combat as ATTRITION — a fight is a running battle of broadsides (exchangeFire), not one dice roll.
// Each round both ships lose HULL & RIG and burn powder; the stronger ship deals more and takes less; a
// pirate favours the RIG (chain-shot to cripple and board) while a navy/merchant pounds the HULL. Over
// rounds a beaten merchant STRIKES (→ plundered) rather than being one-shot, and a raider that picks the
// wrong fight is worn down and sunk. These lock the round mechanic and the dominoes that grow out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { combatStrength, exchangeFire, turnPirate, piracy } from '/game/sim/piracy.js';
import { GOLD } from '/game/sim/resources.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, ...over });
const boat = (over = {}) => ({ id: 's', type: 'brig', hull: 1, rig: 1, morale: 0.6, cargo: { Gold: 0, People: 0, Weapons: 20 }, captain: cap(), ...over });

test('a broadside wears BOTH ships — hull, rig, and powder all fall on each side', () => {
  const w = makeWorld();
  const A = boat(), B = boat();
  exchangeFire(w, A, B);
  assert.ok(A.hull < 1 && B.hull < 1, 'both hulls took damage');
  assert.ok(A.rig < 1 && B.rig < 1, 'both rigs took damage');
  assert.ok(A.cargo.Weapons < 20 && B.cargo.Weapons < 20, 'both burned powder (a Weapons sink)');
});

test('the stronger ship deals more and takes less — a lopsided duel ends fast', () => {
  const w = makeWorld();
  const strong = boat({ captain: cap({ xp: { sea: 0, gun: 8000, cmd: 0 } }), morale: 1, cargo: { Gold: 0, People: 0, Weapons: 40 } });
  const weak = boat({ captain: cap({ xp: { sea: 0, gun: 0, cmd: 0 } }), morale: 0.3, cargo: { Gold: 0, People: 0, Weapons: 2 } });
  assert.ok(combatStrength(w, strong) > combatStrength(w, weak), 'the setup is genuinely lopsided');
  exchangeFire(w, strong, weak);
  assert.ok((1 - weak.hull) > (1 - strong.hull), 'the weaker ship lost more hull in the exchange');
});

test('a battered hull FIGHTS WORSE — the same ship is weaker once staved in', () => {
  const w = makeWorld();
  const whole = boat({ hull: 1 }), holed = boat({ hull: 0.2 });
  assert.ok(combatStrength(w, whole) > combatStrength(w, holed), 'a wallowing wreck brings less to the fight');
});

test('doctrine by flag: pirate & merchant both aim at the RIG (cripple); a privateer pounds the HULL', () => {
  const w = makeWorld();
  // A pirate cripples its prey's rig to board; a MERCHANT returns fire at the pirate's rig to FLEE.
  const pirate = boat({ pirate: true });
  const merchant = boat();
  exchangeFire(w, pirate, merchant);
  assert.ok((1 - merchant.rig) > (1 - merchant.hull), 'the pirate crippled the merchant’s rig (chain-shot)');
  assert.ok((1 - pirate.rig) > (1 - pirate.hull), 'the merchant shot away the pirate’s rig (defensive fire — cripple & flee)');
  // A PRIVATEER is a hunter: it pounds the hull to sink, not the rig.
  const priv = boat({ privateer: true });
  const raider = boat({ pirate: true });
  exchangeFire(w, priv, raider);
  assert.ok((1 - raider.hull) > (1 - raider.rig), 'the privateer pounded the pirate’s hull (out to sink)');
});

test('a fight is a RUNNING BATTLE — one round neither sinks nor plunders; she is worn down, then strikes', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = 1000; pirate.y = 1000; pirate.morale = 1; pirate._huntCd = 0; pirate.hull = 1; pirate.rig = 1;
  pirate.captain.traits = { boldness: 0.7, wanderlust: 0.3, greed: 0.3 }; // bold enough to press, not timid; scorns no prize
  pirate.captain.xp = { sea: 0, gun: 3000, cmd: 0 };
  pirate.cargo = { Gold: 0, People: 0, Weapons: 40 }; // well-armed
  victim.x = 1000; victim.y = 1000; victim.state = 'outbound'; victim.pirate = false;
  victim.morale = 0.9; victim.hull = 1; victim.rig = 1; victim.cargo = { Gold: 500, People: 0, Food: 30, Weapons: 6 };
  victim.captain = { name: 'V', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.9, wanderlust: 0.5, greed: 0.5 } }; // bold → holds out, so the fight RUNS

  const hull0 = victim.hull;
  piracy(w, w.rules.SIM_STEP); // ONE round
  assert.ok(victim.hull < hull0, 'the first broadside dented her hull');
  assert.ok(!victim._sunk && (victim.cargo[GOLD] || 0) === 500, 'but one round neither sinks her nor takes her coin — the fight continues');

  for (let i = 0; i < 80 && !victim._sunk && (victim.cargo[GOLD] || 0) === 500; i++) {
    w.simTime += w.rules.COMBAT_ROUND_SEC;
    piracy(w, w.rules.SIM_STEP);
  }
  assert.ok(victim._sunk || (victim.cargo[GOLD] || 0) < 500, 'battered over several rounds, she struck her colours (or went under)');
});

test('a raider that picks the wrong fight is worn down and sunk (attrition, not a lucky roll)', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = victim.x = 1000; pirate.y = victim.y = 1000;
  pirate.captain.traits = { boldness: 0.95, wanderlust: 0.3, greed: 0.3 }; // fearless → never breaks off, fights to the end
  pirate.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  pirate.morale = 0.5; pirate._huntCd = 0; pirate.hull = 1; pirate.rig = 1;
  pirate.cargo = { Gold: 0, People: 0, Weapons: 4 }; // lightly armed
  victim.state = 'outbound'; victim.pirate = false;
  victim.morale = 1; victim.hull = 1; victim.rig = 1;
  victim.cargo = { Gold: 100, People: 0, Food: 10, Weapons: 40 }; // a Q-ship, bristling with guns
  victim.captain = { name: 'V', xp: { sea: 0, gun: 6000, cmd: 0 }, traits: { boldness: 0.9, wanderlust: 0.5, greed: 0.5 } };

  for (let i = 0; i < 100 && !pirate._sunk && w.ships.includes(pirate); i++) {
    piracy(w, w.rules.SIM_STEP);
    w.simTime += w.rules.COMBAT_ROUND_SEC;
  }
  assert.ok(pirate._sunk || !w.ships.includes(pirate), 'the raider was shot to pieces over the running fight');
});
