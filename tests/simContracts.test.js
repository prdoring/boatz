// Contracts — a port in acute need posts a paid, escrowed contract for a good; delivering it earns
// the reward on top of the sale, until the hold refills or the purse empties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { contracts, contractPayout } from '/game/sim/contracts.js';

function aDay(w) { w.simTime += w.rules.SIM_DAY_SECONDS + 1; }

test('an acutely short port posts a contract, escrowing the reward from its treasury', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands.find((i) => !(i.produces || []).includes('Weapons')) || w.islands[0];
  // Make Weapons acutely short and everything else comfortable.
  for (const g of w.economy.goods.concat(w.economy.raw)) isl.stock[g] = (isl.targets[g] || 0) * 0.9;
  isl.stock.Weapons = (isl.targets.Weapons || 100) * 0.05; // far below the shortage bar
  isl.gold = t.CONTRACT_MIN_TREASURY + t.CONTRACT_REWARD + 500;
  isl._contractCd = 0; isl.contract = null; isl.rebellion = null;
  const gold0 = isl.gold;
  aDay(w); contracts(w, t.SIM_STEP);
  assert.ok(isl.contract, 'a contract was posted');
  assert.equal(isl.contract.good, 'Weapons', 'for the good it most acutely lacks');
  assert.ok(isl.gold < gold0, 'the reward was escrowed out of the treasury');
});

test('delivering the contracted good pays the reward from escrow, then the contract closes', () => {
  const w = makeWorld();
  const t = w.rules;
  const isl = w.islands[0];
  isl.contract = { good: 'Iron', reward: 100, until: w.simTime + 1e9 };
  const first = contractPayout(w, isl, 'Iron', 10);
  assert.ok(first > 0 && first <= 100, 'a delivery drew a reward from the purse');
  assert.equal(isl.contract.reward, 100 - first, 'the purse shrank by what was paid');
  // Delivering the wrong good pays nothing.
  assert.equal(contractPayout(w, isl, 'Wood', 10), 0, 'only the contracted good is rewarded');
  // Empty the purse; the contract flags fulfilled and the daily pass clears it.
  contractPayout(w, isl, 'Iron', 1000);
  assert.equal(isl.contract.reward, 0, 'the purse is spent');
  aDay(w); contracts(w, t.SIM_STEP);
  assert.equal(isl.contract, null, 'a spent contract is cleared');
});

test('a contract routing bonus makes a needy port a better sell target', async () => {
  const w = makeWorld();
  const { findBestPartner } = await import('/game/sim/queries.js');
  const home = w.islands[0];
  const good = 'Clothing';
  // Fill every other port's holds so they're not buyers — only a and b remain candidates.
  for (const p of w.islands) { if (p !== home) p.stock[good] = (p.targets[good] || 100) * 2; }
  const [a, b] = [w.islands[1], w.islands[2]];
  for (const p of [a, b]) { p.gold = 5000; p.stock[good] = 0; p.price[good].mid = home.price[good].mid; p.contract = null; p.rep[home.id] = 0; }
  b.x = a.x; b.y = a.y; // same distance from home → the contract bonus is the only difference
  b.contract = { good, reward: w.rules.CONTRACT_REWARD, until: w.simTime + 1e9 };
  const pick = findBestPartner(w, home, good, 'export');
  assert.ok(pick, 'a buyer was found');
  assert.equal(pick.partner.id, b.id, 'the port with the open contract wins the run');
});
