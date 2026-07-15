// Merchant SELF-DEFENCE — a trader captain decides how heavily to arm from judgment, personality,
// and the KNOWN danger of the route, then fights DEFENSIVELY (chain-shot at the pursuer's rig to
// flee). These lock the decision (defensiveArmTarget), the belief-based route read (routePeril), the
// home-armoury load (armForDefence via the ship system), the buy-the-shortfall purchase, and the
// escape enabler (the merchant's return fire crippling the pursuer's rig).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { ship as runShipSystem } from '/game/sim/ship.js';
import { piracy, turnPirate } from '/game/sim/piracy.js';
import { planVoyage } from '/game/sim/goals.js';
import { executeStop } from '/game/sim/trade.js';
import { defensiveArmTarget } from '/game/sim/captains.js';
import { routePeril } from '/game/sim/intel.js';
import { rigMult } from '/game/sim/repair.js';
import { GOLD } from '/game/sim/resources.js';

const cap = (over = {}) => ({ name: 'C', xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 }, ...over });

// ── The DECISION (defensiveArmTarget, pure) ──────────────────────────────────
test('a cautious captain on a KNOWN-dangerous route arms more than a bold captain on a safe one', () => {
  const w = makeWorld();
  const t = w.rules;
  const cautious = cap({ traits: { boldness: 0.2, wanderlust: 0.5, greed: 0.5 } });
  const bold = cap({ traits: { boldness: 0.9, wanderlust: 0.5, greed: 0.5 } });
  const armedForPeril = defensiveArmTarget(cautious, t, 22, 1);   // dangerous route
  const armedForCalm = defensiveArmTarget(bold, t, 22, 0);        // no known danger
  assert.ok(armedForPeril > armedForCalm, 'the cautious captain mounts more guns for a perilous run');
  assert.ok(armedForCalm >= t.ARM_WEAPONS_BASE - 1e-9, 'even a bold captain carries the baseline');
});

test('JUDGMENT sharpens the response to known danger — a seasoned captain arms harder for a bad route', () => {
  const w = makeWorld();
  const t = w.rules;
  const green = cap({ xp: { sea: 0, gun: 0, cmd: 0 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 } });
  const veteran = cap({ xp: { sea: 0, gun: 0, cmd: 6000 }, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 } });
  // On a genuinely dangerous route (before the cap binds), the wiser captain reads the risk and arms more.
  assert.ok(defensiveArmTarget(veteran, t, 40, 0.6) > defensiveArmTarget(green, t, 40, 0.6),
    'a captain of better judgment mounts more guns for a known-dangerous route');
});

test('a GREEDY captain runs lighter — she grudges hold space to guns, saving it for saleable cargo', () => {
  const w = makeWorld();
  const t = w.rules;
  const prudent = cap({ traits: { boldness: 0.4, wanderlust: 0.5, greed: 0.1 } });
  const greedy = cap({ traits: { boldness: 0.4, wanderlust: 0.5, greed: 0.95 } });
  // Same nerve + judgment, same dangerous route — but the greedy captain arms less to keep cargo room.
  assert.ok(defensiveArmTarget(greedy, t, 40, 0.6) < defensiveArmTarget(prudent, t, 40, 0.6),
    'greed trims the defensive battery (cargo room over powder)');
});

test('a trader is NEVER a warship — arming is capped at weaponCap × ARM_DEFENSE_CAP_FRAC', () => {
  const w = makeWorld();
  const t = w.rules;
  const maxKeen = cap({ xp: { sea: 0, gun: 0, cmd: 9000 }, traits: { boldness: 0, wanderlust: 0.5, greed: 0.5 } });
  for (const wcap of [10, 22, 34]) {
    const target = defensiveArmTarget(maxKeen, t, wcap, 1); // most cautious, most judgment, most danger
    assert.ok(target <= wcap * t.ARM_DEFENSE_CAP_FRAC + 1e-9, `arming for wcap ${wcap} stayed under the defensive cap`);
  }
});

// ── The KNOWN-DANGER read (routePeril, belief-based) ─────────────────────────
test('routePeril is the worst KNOWN danger over the route; an unheard-of lane reads as safe', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const a = w.islands[1], b = w.islands[2], c = w.islands[3];
  const day = Math.floor(w.simTime / w.rules.SIM_DAY_SECONDS);
  home.intel = home.intel || {};
  home.intel[a.id] = { day, danger: 0.3, haven: false, foodDays: 999, lawless: 0 };
  home.intel[b.id] = { day, danger: 0.8, haven: false, foodDays: 999, lawless: 0 };
  // c has NO intel entry — the home has heard nothing of it.
  const stops = [{ islandId: a.id }, { islandId: b.id }, { islandId: c.id }];
  assert.equal(routePeril(w, home, stops, day), 0.8, 'the peril of the route is its most-feared known stop');
  assert.equal(routePeril(w, home, [{ islandId: c.id }], day), 0, 'a lane nobody has spoken of carries no fear');
});

// ── The home-armoury LOAD (armForDefence via the ship system) ────────────────
test('a cautious captain on a known-dangerous run arms from the HOME armoury before sailing', () => {
  const w = makeWorld();
  const t = w.rules;
  const home = w.islands[0];
  const dest = w.islands.find((i) => i.id !== home.id);
  const boat = w.ships.find((s) => !s.pirate) || w.ships[0];
  boat.homeId = home.id; boat.x = home.x; boat.y = home.y;
  boat.state = 'idle'; boat.uprising = null; boat.adrift = null;
  boat.cargo = { Gold: 0, People: 0 };
  boat.captain = cap({ traits: { boldness: 0.2, wanderlust: 0.5, greed: 0.5 } }); // cautious, unskilled → won't wait for wind
  boat.voyage = { reason: 'trade', stops: [{ islandId: dest.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  home.stock.Weapons = 40;
  const day = Math.floor(w.simTime / t.SIM_DAY_SECONDS);
  home.intel = home.intel || {};
  home.intel[dest.id] = { day, danger: 1, haven: false, foodDays: 999, lawless: 0 }; // a KNOWN-dangerous destination
  w.ships = [boat]; // isolate — no pirates near home, so no shelter-in-harbour

  const armouryBefore = home.stock.Weapons;
  runShipSystem(w, t.SIM_STEP);
  assert.ok((boat.cargo.Weapons || 0) >= t.ARM_WEAPONS_BASE, 'the captain mounted guns for the run');
  assert.ok(home.stock.Weapons < armouryBefore, 'the guns came out of the home armoury (an operating cost)');
});

test('a weaponless home cannot arm its trader — she sails light', () => {
  const w = makeWorld();
  const t = w.rules;
  const home = w.islands[0];
  const dest = w.islands.find((i) => i.id !== home.id);
  const boat = w.ships.find((s) => !s.pirate) || w.ships[0];
  boat.homeId = home.id; boat.x = home.x; boat.y = home.y;
  boat.state = 'idle'; boat.uprising = null; boat.adrift = null;
  boat.cargo = { Gold: 0, People: 0 };
  boat.captain = cap({ traits: { boldness: 0.2, wanderlust: 0.5, greed: 0.5 } });
  boat.voyage = { reason: 'trade', stops: [{ islandId: dest.id, sell: {}, buy: {}, people: 0 }], index: 0 };
  home.stock.Weapons = 0; // a bare armoury
  const day = Math.floor(w.simTime / t.SIM_DAY_SECONDS);
  home.intel = home.intel || {};
  home.intel[dest.id] = { day, danger: 1, haven: false, foodDays: 999, lawless: 0 };
  w.ships = [boat];

  runShipSystem(w, t.SIM_STEP);
  assert.equal(boat.cargo.Weapons || 0, 0, 'no guns to be had — she departs unarmed');
});

// ── The DOCTRINE payoff: defensive fire crips the pursuer's rig (the escape enabler) ──
test('a caught merchant’s return fire shoots away the PURSUER’s rig — slowing it so she can flee', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, SINK_PER_1000: 0 }; // silence weather-loss noise
  const t = w.rules;
  const pirate = w.ships[0], merch = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = 1000; pirate.y = 1000; pirate._huntCd = 0; pirate.hull = 1; pirate.rig = 1; pirate.morale = 1;
  pirate.cargo = { Gold: 0, People: 0, Weapons: 20 };
  pirate.captain.traits = { boldness: 0.95, wanderlust: 0.3, greed: 0.3 }; // presses the attack
  pirate.captain.xp = { sea: 0, gun: 800, cmd: 0 };
  merch.x = 1000; merch.y = 1000; merch.state = 'outbound'; merch.pirate = false;
  merch.hull = 1; merch.rig = 1; merch.morale = 0.9;
  merch.cargo = { Gold: 200, People: 0, Food: 20, Weapons: 8 }; // modestly armed — weaker than the raider
  merch.captain = cap({ name: 'M', traits: { boldness: 0.7, wanderlust: 0.5, greed: 0.5 } }); // holds out a few rounds
  w.ships = [pirate, merch];

  for (let i = 0; i < 10 && !merch._sunk && !pirate._sunk; i++) {
    piracy(w, t.SIM_STEP);
    w.simTime += t.COMBAT_ROUND_SEC;
  }
  assert.ok((1 - pirate.rig) > (1 - pirate.hull), 'the merchant aimed high — the pursuer’s rig took more than its hull');
  assert.ok(pirate.rig < 1 && rigMult(pirate, t) < 1, 'the raider has been slowed — the merchant can outrun it');
});

test('an outgunned armed merchant FLEES rather than standing — guns cover the retreat, not a slugfest', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, SINK_PER_1000: 0 };
  const t = w.rules;
  const merch = w.ships[0], pir = w.ships[1];
  // A BOLD, seasoned, armed captain — exactly the one who would "run the blockade" if she had a chance.
  merch.pirate = false; merch.privateer = false; merch.state = 'outbound';
  merch._fleeing = false; merch._fleeTo = null; merch.uprising = null; merch.adrift = null;
  merch.x = 5000; merch.y = 5000; merch.hull = 1; merch.rig = 1; merch.morale = 0.9;
  merch.cargo = { Gold: 0, People: 0, Food: 30, Weapons: 8 };
  merch.captain = cap({ xp: { sea: 2500, gun: 0, cmd: 0 }, traits: { boldness: 0.95, wanderlust: 0.5, greed: 0.5 } });
  merch.voyage = { reason: 'trade', stops: [{ islandId: w.islands.find((i) => i.id !== merch.homeId).id, sell: {}, buy: {}, people: 0 }], index: 0 };
  // A clearly STRONGER raider just inside evasion range (ahead of her, not on her home port).
  turnPirate(w, pir);
  pir.x = 5000 + t.PIRATE_EVADE_RANGE * 0.5; pir.y = 5000; pir.hull = 1; pir.rig = 1; pir.morale = 1;
  pir.cargo = { Gold: 0, People: 0, Weapons: 40 };
  pir.captain.xp = { sea: 0, gun: 5000, cmd: 0 };
  w.ships = [merch, pir];

  runShipSystem(w, t.SIM_STEP);
  assert.ok(merch._fleeing, 'outgunned, even a bold captain runs for safety instead of holding her course');
  assert.equal(merch._act && merch._act.k, 'flee', 'her activity reads FLEE, not standing to slug it out');
});

// ── BUYING the shortfall: the executeStop purchase is guarded and conserves gold ─
test('buying weapons at a producer conserves gold and every good (the shortfall purchase)', () => {
  const w = makeWorld();
  const armourer = w.islands.find((i) => i.produces.includes('Weapons')) || w.islands[1];
  armourer.gold = 500;
  armourer.stock.Weapons = 30;
  if (!armourer.price.Weapons) armourer.price.Weapons = { mid: w.rules.BASE_PRICES ? w.rules.BASE_PRICES.Weapons : 20 };
  const buyer = w.ships[0];
  buyer.homeId = w.islands.find((i) => i.id !== armourer.id).id; // not the armourer's own ship
  buyer.cargo = { Gold: 400, People: 0 };
  const stop = { islandId: armourer.id, sell: {}, buy: { Weapons: 10 }, people: 0 };

  const goldBefore = armourer.gold + buyer.cargo.Gold;
  const weaponsBefore = armourer.stock.Weapons + (buyer.cargo.Weapons || 0);
  executeStop(w, armourer, buyer, stop);
  assert.ok(Math.abs((armourer.gold + buyer.cargo.Gold) - goldBefore) < 1e-6, 'gold conserved');
  assert.ok(Math.abs((armourer.stock.Weapons + (buyer.cargo.Weapons || 0)) - weaponsBefore) < 1e-6, 'weapons conserved');
  assert.ok((buyer.cargo.Weapons || 0) > 0, 'the captain took defensive guns aboard');
});
