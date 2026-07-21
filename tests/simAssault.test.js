// Island assault + the rig-speed penalty on a privateer's homeward legs. A besieger must CLOSE to within
// the den's gun-range (so the shore batteries answer and shots actually cross), and a battered hunter must
// LIMP — the rig penalty applies when it's resupplying/standing down, not just when hunting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { antipiracy } from '/game/sim/antipiracy.js';

test('a besieging privateer CLOSES to within the haven’s gun-range to bombard (not sitting out at the suppress ring)', () => {
  const w = makeWorld();
  const haven = w.islands[0]; haven.haven = true; haven.havenStrength = 1;
  const priv = w.ships[0];
  priv.privateer = true; priv.pirate = false;
  priv.privateerUntil = w.simTime + 1e6;
  priv.homeId = w.islands[1].id; priv._guard = w.islands[1].id;
  priv.hull = 1; priv.rig = 1;
  priv.cargo = { Gold: 0, People: 0, Food: 9999, Weapons: 30 }; // fed + armed → won't divert to resupply
  const bombard = w.rules.PORT_CANNON_RANGE * w.rules.HAVEN_BOMBARD_FRAC;
  priv.x = haven.x + (bombard + w.rules.HAVEN_SUPPRESS_RANGE) / 2; priv.y = haven.y; // besieging, but BEYOND bombard range
  w.ships = w.ships.filter((s) => s === priv);              // no prey / no other hulls to commission
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  const dBefore = Math.hypot(priv.x - haven.x, priv.y - haven.y);
  const strength0 = haven.havenStrength;
  for (let i = 0; i < 300 && !priv._sunk; i++) antipiracy(w, w.rules.SIM_STEP);
  const dAfter = Math.hypot(priv.x - haven.x, priv.y - haven.y);
  assert.ok(dAfter < dBefore - 50, `the besieger bore IN toward the haven (${Math.round(dBefore)}u → ${Math.round(dAfter)}u)`);
  assert.ok(dAfter <= bombard + 60, `and closed to within bombarding gun-range (~${Math.round(bombard)}u)`);
  assert.ok(haven.havenStrength < strength0, 'and actually battered the walls once in range');
});

test('a battered privateer LIMPS to resupply — the rig penalty applies off-station, not just when hunting', () => {
  const run = (rig) => {
    const w = makeWorld();
    for (const i of w.islands) i.haven = false;
    const port = w.islands[0];
    const priv = w.ships[0];
    priv.privateer = true; priv.pirate = false;
    priv.privateerUntil = w.simTime + 1e6;
    priv.homeId = port.id; priv._guard = port.id;
    priv.hull = 0.5; priv.rig = rig;                       // battered → the resupply valve fires (REPAIR_GUARD_HULL)
    priv.cargo = { Gold: 0, People: 0, Food: 0, Weapons: 20 }; // empty larder too → definitely heads for the port
    priv.x = port.x + 4000; priv.y = port.y;               // far out, so it's a long limp home
    w.ships = w.ships.filter((s) => s === priv);
    w.rules = { ...w.rules, SINK_PER_1000: 0, PIRATE_MAX_FRAC: 0 };
    const x0 = priv.x;
    for (let i = 0; i < 40; i++) antipiracy(w, w.rules.SIM_STEP);
    return x0 - priv.x; // distance travelled toward the port
  };
  const wholeRig = run(1);
  const shotRig = run(0.2);
  assert.ok(wholeRig > 0 && shotRig > 0, 'both make headway toward the port');
  assert.ok(shotRig < wholeRig * 0.8, `a shot rig limps noticeably slower (${shotRig.toFixed(1)} vs ${wholeRig.toFixed(1)} units)`);
});
