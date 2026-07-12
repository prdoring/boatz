// Purposeful reconnaissance — a port shops for a cheaper supplier when the one it KNOWS has grown
// dear (soughtSupply), and otherwise-idle ships scout potential suppliers rather than wandering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { soughtSupply } from '/game/sim/goals.js';

test('soughtSupply flags a needed good whose only known sources have grown dear', () => {
  const w = makeWorld();
  const t = w.rules;
  const home = w.islands.find((i) => i.primary !== 'Iron' && i.secondary !== 'Iron');
  home.stock.Iron = 0;                          // genuinely short of iron
  const ironPorts = w.islands.filter((i) => i.id !== home.id && (i.primary === 'Iron' || i.secondary === 'Iron'));
  assert.ok(ironPorts.length >= 2, 'the sea has several iron producers');
  home.beliefs = {};
  for (const p of ironPorts) home.beliefs[p.id] = { Iron: { mid: t.PRICE_BASE.Iron * 1.5, day: 0 } }; // every KNOWN source is dear
  assert.ok(soughtSupply(w, home).Iron > 0, 'all known iron sources dear → the port wants to shop for a cheaper one');
});

test('a known CHEAP source stops the shopping', () => {
  const w = makeWorld();
  const t = w.rules;
  const home = w.islands.find((i) => i.primary !== 'Iron' && i.secondary !== 'Iron');
  home.stock.Iron = 0;
  const ironPorts = w.islands.filter((i) => i.id !== home.id && (i.primary === 'Iron' || i.secondary === 'Iron'));
  home.beliefs = {};
  for (const p of ironPorts) home.beliefs[p.id] = { Iron: { mid: t.PRICE_BASE.Iron * 1.5, day: 0 } };
  home.beliefs[ironPorts[0].id] = { Iron: { mid: t.PRICE_BASE.Iron * 0.9, day: 0 } }; // one known source is cheap
  assert.ok(!('Iron' in soughtSupply(w, home)), 'knowing a cheap supplier removes the itch to shop');
});

test('a good with NO known source is left to ordinary exploration, not forced shopping', () => {
  const w = makeWorld();
  const home = w.islands.find((i) => i.primary !== 'Iron' && i.secondary !== 'Iron');
  home.stock.Iron = 0;
  home.beliefs = {}; // knows no iron prices at all
  // Unknown ports look cheap at the base-price prior, so normal trade routing explores them on its
  // own — soughtSupply deliberately does NOT flag this case (that would force wasteful detours).
  assert.ok(!('Iron' in soughtSupply(w, home)), 'an unknown-source good is not flagged for a forced shopping trip');
});

test('a well-supplied port is not shopping for anything', () => {
  const w = makeWorld();
  const home = w.islands[0];
  for (const res of [...w.economy.raw, ...w.economy.goods]) home.stock[res] = (home.targets[res] || 250) * 2; // stocked up
  assert.equal(Object.keys(soughtSupply(w, home)).length, 0, 'nothing short → nothing to shop for');
});
