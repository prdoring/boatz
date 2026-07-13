import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { executeStop } from '/game/sim/trade.js';
import { planVoyage } from '/game/sim/goals.js';
import { stepWorld } from '/game/sim/world.js';

test('executeStop conserves gold and every traded good', () => {
  const w = makeWorld();
  const partner = w.islands.find((i) => i.produces.includes('Food'));
  partner.gold = 1000;
  partner.stock.Food = 800;
  partner.stock.Weapons = 0;
  const ship = w.ships[0];
  ship.cargo = { Gold: 500, People: 0, Weapons: 40 };
  const stop = { islandId: partner.id, sell: { Weapons: 40 }, buy: { Food: 30 }, people: 0 };

  const goldBefore = partner.gold + ship.cargo.Gold;
  const weaponsBefore = partner.stock.Weapons + ship.cargo.Weapons;
  const foodBefore = partner.stock.Food + (ship.cargo.Food || 0);

  executeStop(w, partner, ship, stop);

  assert.ok(Math.abs((partner.gold + ship.cargo.Gold) - goldBefore) < 1e-6, 'gold not conserved');
  assert.ok(Math.abs((partner.stock.Weapons + ship.cargo.Weapons) - weaponsBefore) < 1e-6, 'weapons not conserved');
  assert.ok(Math.abs((partner.stock.Food + (ship.cargo.Food || 0)) - foodBefore) < 1e-6, 'food not conserved');
});

test('a starving island plans a food-import voyage (survival first)', () => {
  const w = makeWorld();
  const isl = w.islands.find((i) => i.primary === 'Iron' && !i.produces.includes('Food'));
  const seller = w.islands.find((i) => i.produces.includes('Food'));
  seller.stock.Food = 600;   // a food seller exists
  isl.stock.Food = 0;        // foodDays = 0 < SURVIVAL_DAYS
  isl.gold = 2000;           // can afford it
  isl.population = 12;       // below the migration threshold, so survival (food) is the reason
  const ship = w.ships.find((s) => s.homeId === isl.id);

  const v = planVoyage(w, isl, ship);
  assert.ok(v, 'a voyage should be planned');
  assert.equal(v.reason, 'food');
  assert.ok(v.stops.some((s) => (s.buy.Food || 0) > 0), 'voyage should buy Food');
});

test('ship count stays within MAX_SHIPS_TOTAL over a long run (purchases + upkeep)', () => {
  const w = makeWorld();
  for (let i = 0; i < 60 * 60; i++) stepWorld(w, 1.0);
  assert.ok(w.ships.length <= w.rules.MAX_SHIPS_TOTAL, `ships=${w.ships.length}`);
  // Per-island TRADING fleet cap holds (no same-tick overshoot). The cap governs a
  // port's merchant hulls; rogue pirates raised at sea keep a nominal homeId for
  // identity but are raiders at large, not berths, so they don't count against it.
  for (const isl of w.islands) {
    const owned = w.ships.filter((s) => s.homeId === isl.id && !s.pirate).length;
    assert.ok(owned <= w.rules.MAX_SHIPS_PER_ISLAND, `${isl.name} owns ${owned}`);
  }
});
