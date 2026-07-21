// FIGHT OR FLEE — a battle is a running assessment, not a duel to the death. Every round BOTH combatants
// weigh their hull and the odds, tempered by captain character: the bold & seasoned hold on through worse,
// the fearless never quit, a dismasted ship can't run. And a raider no longer blindly presses a hunt — it
// breaks off to mend when it's shot to pieces, and decides fight-or-flight when a pirate-hunter bears down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { assessFlee, combatStrength, turnPirate, piracy } from '/game/sim/piracy.js';

// A mid-career captain (xp ≈ 277 → skill ≈ 0.5, so NERVE turns on boldness alone) with tunable traits.
const cap = (over = {}) => ({ name: 'C', xp: { sea: 277, gun: 277, cmd: 277 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, ...over });
const boat = (over = {}) => ({ id: 's', type: 'brig', hull: 1, rig: 1, morale: 0.6, cargo: { Gold: 0, People: 0, Weapons: 10 }, captain: cap(), ...over });

test('assessFlee: the FEARLESS never quit — a staved-in, outgunned hull still fights', () => {
  const w = makeWorld();
  const fearless = boat({ hull: 0.1, cargo: { Gold: 0, People: 0, Weapons: 2 }, captain: cap({ traits: { boldness: 0.9, wanderlust: 0.5, greed: 0.5 } }) });
  const monster = boat({ cargo: { Gold: 0, People: 0, Weapons: 40 } });
  assert.ok(combatStrength(w, fearless) < combatStrength(w, monster), 'the setup is genuinely lopsided');
  assert.equal(assessFlee(w, fearless, monster), false, 'boldness ≥ COMBAT_FEARLESS → she fights on regardless');
});

test('assessFlee: a DISMASTED ship cannot run — she must fight on or strike, never flee', () => {
  const w = makeWorld();
  const dismasted = boat({ hull: 0.1, rig: w.rules.RIG_DISTRESS, cargo: { Gold: 0, People: 0, Weapons: 2 }, captain: cap({ traits: { boldness: 0.3, wanderlust: 0.5, greed: 0.5 } }) });
  const monster = boat({ cargo: { Gold: 0, People: 0, Weapons: 40 } });
  assert.equal(assessFlee(w, dismasted, monster), false, 'rig ≤ RIG_DISTRESS → no sail to flee under');
});

test('assessFlee: a STOUT hull trades blows even when outgunned (hull gate must also give way)', () => {
  const w = makeWorld();
  const stout = boat({ hull: 0.95, cargo: { Gold: 0, People: 0, Weapons: 2 }, captain: cap({ traits: { boldness: 0.3, wanderlust: 0.5, greed: 0.5 } }) });
  const monster = boat({ cargo: { Gold: 0, People: 0, Weapons: 40 } });
  assert.equal(assessFlee(w, stout, monster), false, 'still whole enough to fight — you break off on odds AND hull, not either alone');
});

test('assessFlee: hurt AND outmatched → break off; hurt but WINNING → hold the line', () => {
  const w = makeWorld();
  const hurtWeak = boat({ hull: 0.35, cargo: { Gold: 0, People: 0, Weapons: 2 }, captain: cap({ traits: { boldness: 0.3, wanderlust: 0.5, greed: 0.5 } }) });
  const monster = boat({ cargo: { Gold: 0, People: 0, Weapons: 40 } });
  assert.equal(assessFlee(w, hurtWeak, monster), true, 'battered and plainly outgunned → she runs');

  const hurtStrong = boat({ hull: 0.35, cargo: { Gold: 0, People: 0, Weapons: 40 }, captain: cap({ traits: { boldness: 0.3, wanderlust: 0.5, greed: 0.5 } }) });
  const minnow = boat({ cargo: { Gold: 0, People: 0, Weapons: 2 } });
  assert.equal(assessFlee(w, hurtStrong, minnow), false, 'battered but still winning the exchange → she presses on');
});

test('assessFlee: character sets the nerve — a timid captain breaks off where a bold one holds', () => {
  const w = makeWorld();
  const foe = boat({ cargo: { Gold: 0, People: 0, Weapons: 22 } }); // moderately stronger than a 10-gun hull
  const timid = boat({ hull: 0.45, captain: cap({ traits: { boldness: 0.2, wanderlust: 0.5, greed: 0.5 } }) });
  const bold = boat({ hull: 0.45, captain: cap({ traits: { boldness: 0.7, wanderlust: 0.5, greed: 0.5 } }) });
  assert.equal(assessFlee(w, timid, foe), true, 'the timid captain quits this fight');
  assert.equal(assessFlee(w, bold, foe), false, 'the bold captain, same hull & odds, fights on');
});

test('SELF-PRESERVATION: a crippled raider breaks off the hunt and makes for its haven — even with a prize alongside', () => {
  const w = makeWorld();
  const den = w.islands[0];
  den.haven = true; den.havenStrength = 0.8;              // a den to run to
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.captain.traits = { boldness: 0.5, wanderlust: 0.3, greed: 0.3 };
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 30 }; // fed + armed (would happily hunt if whole)
  pirate._huntCd = 0; pirate._prey = null;
  pirate.x = den.x + 60; pirate.y = den.y;                // right in the den's roads
  const merch = w.ships.find((s) => s !== pirate && !s.pirate) || w.ships[1];
  merch.pirate = false; merch.privateer = false; merch.state = 'outbound';
  merch.cargo = { Gold: 500, People: 0, Food: 10, Weapons: 0 }; // a fat prize
  merch.x = den.x + 60; merch.y = den.y;                  // right on top of the raider (a prize in reach)
  w.ships = w.ships.filter((s) => s === pirate || s === merch);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  // WHOLE: with a prize alongside it hunts.
  pirate.hull = 1;
  piracy(w, w.rules.SIM_STEP);
  assert.equal(pirate._act && pirate._act.k, 'hunt', 'a sound hull takes the prize in front of it');

  // CRIPPLED: the same raider quits the hunt and heads for the den to mend.
  pirate.hull = 0.2; pirate._prey = null; pirate._huntCd = 0;
  piracy(w, w.rules.SIM_STEP);
  assert.equal(pirate._act && pirate._act.k, 'resupply', 'shot to pieces, it breaks off to mend rather than press the chase');
});

test('HUNTED: a bold, matched raider TURNS on the pirate-hunter; an outmatched one FLEES for its haven', () => {
  const w = makeWorld();
  const den = w.islands[0];
  den.haven = true; den.havenStrength = 0.8;
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.hull = 1; pirate.rig = 1; pirate.morale = 1; pirate._huntCd = 0; pirate._prey = null;
  pirate.x = den.x + 1600; pirate.y = den.y;             // well beyond the den's defended waters (open sea)
  const priv = w.ships.find((s) => s !== pirate && !s.pirate) || w.ships[1];
  priv.privateer = true; priv.pirate = false; priv.homeId = w.islands[1].id;
  priv.hull = 1; priv.rig = 1;
  priv.x = pirate.x + 300; priv.y = pirate.y;            // bearing down, inside the flee range
  w.ships = w.ships.filter((s) => s === pirate || s === priv);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  // STAND — a strong, bold raider gives battle.
  pirate.captain.traits = { boldness: 0.9, wanderlust: 0.3, greed: 0.3 };
  pirate.captain.xp = { sea: 0, gun: 4000, cmd: 0 };
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 40 };
  priv.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 4 };
  let fought = false;
  for (let i = 0; i < 60 && !priv._sunk; i++) {
    piracy(w, w.rules.SIM_STEP); w.simTime += w.rules.COMBAT_ROUND_SEC;
    if (pirate._act && pirate._act.k === 'fight') fought = true;
  }
  assert.ok(fought, 'the raider marked itself fighting the hunter');
  assert.ok(priv._sunk || priv.hull < 1 || (priv.cargo.Weapons || 0) < 4, 'and actually traded blows — it did not just press its own hunt');

  // FLEE — a weak, timid raider runs for the den.
  const w2 = makeWorld();
  const den2 = w2.islands[0];
  den2.haven = true; den2.havenStrength = 0.8;
  const runner = w2.ships.find((s) => s.pirate) || w2.ships[0];
  turnPirate(w2, runner);
  runner.hull = 1; runner.rig = 1; runner._huntCd = 0; runner._prey = null;
  runner.captain.traits = { boldness: 0.2, wanderlust: 0.3, greed: 0.3 };
  runner.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  runner.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 2 };
  runner.x = den2.x + 1600; runner.y = den2.y;
  const hunter = w2.ships.find((s) => s !== runner && !s.pirate) || w2.ships[1];
  hunter.privateer = true; hunter.pirate = false; hunter.homeId = w2.islands[1].id;
  hunter.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 40 };
  hunter.x = runner.x + 300; hunter.y = runner.y;
  w2.ships = w2.ships.filter((s) => s === runner || s === hunter);
  w2.rules = { ...w2.rules, SINK_PER_1000: 0 };

  const dBefore = Math.hypot(runner.x - den2.x, runner.y - den2.y);
  let fled = false;
  for (let i = 0; i < 20; i++) { piracy(w2, w2.rules.SIM_STEP); if (runner._act && runner._act.k === 'flee') fled = true; }
  const dAfter = Math.hypot(runner.x - den2.x, runner.y - den2.y);
  assert.ok(fled, 'the outmatched raider marked itself fleeing');
  assert.ok(dAfter < dBefore - 50, 'and ran toward its haven (mend + shelter), not toward the hunter');
});
