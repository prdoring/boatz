// The outstanding-voyage ledger (voyages.js): a home port cannot see over the horizon. It keeps
// EXPECTING each ship it sends out until an estimated return, and only PRESUMES a missing ship lost
// once it is truly overdue — so a vessel sunk far at sea isn't instantly known, and the port doesn't
// rush to replace a ship it still thinks is merely late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { noteDeparture, noteReturn, reckonVoyages, fleetBelievedByHome } from '/game/sim/voyages.js';

function giveVoyage(w, home, ship, toId) {
  ship.voyage = { reason: 'trade', stops: [{ islandId: toId, sell: {}, buy: {}, people: 0 }], index: 0 };
}

test('sending a ship off puts it on the ledger with a future due day', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const ship = w.ships.find((s) => s.homeId === home.id);
  giveVoyage(w, home, ship, w.islands[1].id);
  noteDeparture(w, home, ship);
  assert.ok(home.expecting[ship.id], 'the ship is recorded as outstanding');
  assert.ok(home.expecting[ship.id].dueDay > 0, 'with an estimated return day in the future');
});

test('a ship that makes it home is cleared from the ledger', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const ship = w.ships.find((s) => s.homeId === home.id);
  giveVoyage(w, home, ship, w.islands[1].id);
  noteDeparture(w, home, ship);
  noteReturn(home, ship);
  assert.ok(!home.expecting[ship.id], 'safely home → no longer awaited');
});

test('a lost ship is still awaited until overdue, then presumed lost with a headline', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const ship = w.ships.find((s) => s.homeId === home.id);
  giveVoyage(w, home, ship, w.islands[1].id);
  noteDeparture(w, home, ship);
  const due = home.expecting[ship.id].dueDay;

  // The ship founders and vanishes from the seas.
  w.ships = w.ships.filter((s) => s !== ship);

  // On its due day it is not YET overdue — the home still hopes, no news.
  w.simTime = due * w.rules.SIM_DAY_SECONDS;
  w._voyageDay = -1;
  const before = w.events.length;
  reckonVoyages(w);
  assert.ok(home.expecting[ship.id], 'not yet overdue → still awaited');
  assert.equal(w.events.length, before, 'and no loss reported yet');

  // Past the due day it is presumed lost — struck from the ledger, and it makes the news.
  w.simTime = (due + 1) * w.rules.SIM_DAY_SECONDS;
  w._voyageDay = -1;
  reckonVoyages(w);
  assert.ok(!home.expecting[ship.id], 'now overdue → presumed lost, off the ledger');
  assert.ok(w.events.some((e) => e.kind === 'lost'), 'the loss made the chronicle');
});

test('a not-yet-overdue lost ship still counts toward the fleet the port believes it has', () => {
  const w = makeWorld();
  const home = w.islands[0];
  const ship = w.ships.find((s) => s.homeId === home.id);
  giveVoyage(w, home, ship, w.islands[1].id);
  noteDeparture(w, home, ship);

  const liveBefore = new Set(w.ships.map((s) => s.id));
  const believedBefore = fleetBelievedByHome(w, home, liveBefore);

  // The ship is lost at sea, but not yet overdue — the home doesn't know.
  w.ships = w.ships.filter((s) => s !== ship);
  const liveAfter = new Set(w.ships.map((s) => s.id));
  const believedAfter = fleetBelievedByHome(w, home, liveAfter);

  assert.equal(believedAfter, believedBefore, 'the believed fleet is unchanged — the loss is not yet known');
});
