// Crew provisioning, morale, ale, starvation, and mutiny/defection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { crew, provisionCrew, foodDaysAboard, deviationTarget } from '/game/sim/crew.js';

// Put a ship "at sea" on a trivial voyage so the crew system processes it.
function atSea(w, ship, cargo = {}) {
  ship.voyage = { reason: 'trade', stops: [{ islandId: w.islands[1].id, sell: {}, buy: {}, people: 0 }], index: 0 };
  ship.state = 'outbound';
  ship.cargo = { Gold: 0, People: 0, ...cargo };
}
function run(w, simDays) {
  const steps = Math.round(simDays * w.rules.SIM_DAY_SECONDS / w.rules.SIM_STEP);
  for (let i = 0; i < steps; i++) { crew(w, w.rules.SIM_STEP); w.simTime += w.rules.SIM_STEP; }
}

test('an at-sea crew eats food from the hold', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  atSea(w, ship, { Food: 40 });
  run(w, 1);
  assert.ok(ship.cargo.Food < 40 && ship.cargo.Food > 0, 'food was consumed but not exhausted in a day');
});

test('well-fed morale eases toward the steady state; no food makes it plummet and starve', () => {
  const w = makeWorld();
  const fed = w.ships[0], starved = w.ships[1];
  atSea(w, fed, { Food: 500 }); fed.morale = 0.4;
  atSea(w, starved, { Food: 0 }); starved.morale = 0.7; starved.hunger = 0;
  starved._upCd = 1e9; // suppress an uprising so we can observe the raw morale drop
  run(w, 0.9); // shorter than the mutiny grace period
  assert.ok(fed.morale > 0.48, 'well-fed morale climbs toward its (fatigue-adjusted) steady state');
  assert.ok(starved.morale < 0.4, 'no food tanks morale');
  assert.ok(starved.hunger > 0.5, 'hunger accrues without food');
});

test('grog (ale) lifts morale above what food alone gives', () => {
  const w = makeWorld();
  const dry = w.ships[0], merry = w.ships[1];
  atSea(w, dry, { Food: 500 }); dry.morale = 0.7;
  atSea(w, merry, { Food: 500, Ale: 500 }); merry.morale = 0.7;
  run(w, 1);
  assert.ok(merry.morale > dry.morale, 'the ship with grog is merrier');
});

test('a FOREIGN port sells the crew its provisions (paid from the ship purse)', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  ship.cargo = { Gold: 2000, People: 0, Food: 0 };
  const foreign = w.islands.find((i) => i.id !== ship.homeId);
  foreign.stock.Food = 300;
  const goldBefore = ship.cargo.Gold;
  provisionCrew(w, foreign, ship);
  assert.ok(ship.cargo.Food > 1, 'took on provisions');
  assert.ok(ship.cargo.Gold < goldBefore, 'paid the foreign port');
});

test('a HOME port victuals its own crew from the town stores, free of charge', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  ship.cargo = { Gold: 0, People: 0, Food: 0 }; // a broke ship fresh off unloading — must still be fed
  const home = w.islandsById.get(ship.homeId);
  home.stock.Food = 300;
  const homeFoodBefore = home.stock.Food;
  provisionCrew(w, home, ship);
  assert.ok(ship.cargo.Food > 1, 'a broke crew is still provisioned by its home port');
  assert.ok(home.stock.Food < homeFoodBefore, 'the food came out of the town stores');
  assert.equal(ship.cargo.Gold, 0, 'no coin changes hands feeding the port’s own crew');
});

test('a crew with no food for too long is lost with the ship', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  atSea(w, ship, { Food: 0 });
  ship.hunger = w.rules.STARVE_DAYS - 0.05;
  run(w, 0.2);
  assert.ok(!w.ships.includes(ship), 'the starved ship was removed');
});

test('sustained low morale raises an uprising, which resolves (morale reset) and sends the ship to resupply', () => {
  const w = makeWorld();
  w.islands[1].stock.Food = 200; // somewhere to run for provisions
  const ship = w.ships[0];
  atSea(w, ship, { Food: 0, Gold: 100 });
  ship.captain = { name: 'Green', xp: 0, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 } };
  ship.morale = 0.05;
  ship.unrest = w.rules.MUTINY_GRACE_DAYS + 1; // already past the crew's patience
  ship._upCd = 0;

  crew(w, w.rules.SIM_STEP); // triggers the uprising (dead in the water)
  assert.ok(ship.uprising, 'crew rose up');

  w.simTime = ship.uprising.until + 1; // let the standoff run its course
  crew(w, w.rules.SIM_STEP);           // resolve it
  assert.equal(ship.uprising, null, 'uprising resolved');
  assert.ok(ship.morale >= w.rules.MORALE_STEADY - 1e-6, 'morale reset to steady');
  assert.equal(ship.voyage.reason, 'resupply', 'the ship now runs for the nearest larder');
});

test('a worried captain low on food diverts to the nearest larder', () => {
  const w = makeWorld();
  const ship = w.ships[0];
  atSea(w, ship, { Food: 0 });
  // Stock a larder somewhere that isn't home or the current stop (fresh worlds have 0 Food).
  const larder = w.islands.find((i) => i.id !== ship.homeId && i.id !== w.islands[1].id);
  larder.stock.Food = 120;
  ship.captain = { name: 'C', xp: 500, traits: { boldness: 0.5, wanderlust: 0.5, greed: 0.5 } };
  ship.morale = 0.3;
  const target = deviationTarget(w, ship);
  assert.ok(target && target.id !== ship.homeId, 'diverts to some other island for food');
});
