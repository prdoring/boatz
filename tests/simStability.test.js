import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, capOfRes } from './helpers/simWorld.js';
import { stepWorld, worldTotals } from '/game/sim/world.js';

const DAY = 60; // sim-seconds per day

function allFinite(w) {
  for (const i of w.islands) {
    for (const k of ['population', 'gold', 'civ']) if (!Number.isFinite(i[k])) return false;
    for (const r in i.stock) if (!Number.isFinite(i.stock[r])) return false;
    for (const r in i.price) if (!Number.isFinite(i.price[r].mid)) return false;
  }
  for (const s of w.ships) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
    for (const r in s.cargo) if (!Number.isFinite(s.cargo[r])) return false;
  }
  return true;
}

// The headline test: a self-sustaining, dynamic, non-collapsing economy with no
// player intervention, across several seeds. Thresholds match the verified sim.
for (const seed of [1337, 7, 42]) {
  test(`economy is stable and dynamic over 30 sim-days (seed ${seed})`, () => {
    const w = makeWorld(seed);
    const K = w.islands.reduce((a, i) => a + i.k, 0); // total carrying capacity
    const gold0 = worldTotals(w).gold;

    for (let day = 1; day <= 30; day++) {
      for (let s = 0; s < DAY; s++) stepWorld(w, 1.0);

      assert.ok(allFinite(w), `non-finite value on day ${day}`);
      // Gold is a bounded FLOW (GDP income vs. upkeep/wreck sinks + a per-capita hoard cap),
      // not conserved — assert it stays positive and within the cap, never NaN/runaway.
      const gnow = worldTotals(w).gold;
      const goldCap = w.rules.GOLD_MAX_PER_POP * w.islands.reduce((a, i) => a + i.k, 0);
      assert.ok(Number.isFinite(gnow) && gnow > 0 && gnow <= goldCap * 1.01, `gold out of bounds day ${day}: ${gnow}`);
      // No island dies; no stockpile explodes.
      for (const i of w.islands) {
        assert.ok(i.population >= w.rules.POP_FLOOR - 1e-6, `${i.name} below floor day ${day}`);
        for (const r in i.stock) {
          assert.ok(i.stock[r] <= capOfRes(w, r) * (1 + 1e-6), `${i.name}/${r} over cap day ${day}`);
        }
      }
      // Population neither collapses to nothing nor exceeds capacity, after warmup.
      if (day >= 10) {
        const total = w.islands.reduce((a, i) => a + i.population, 0);
        assert.ok(total > 0.35 * K, `population collapsed to ${total.toFixed(0)} day ${day}`);
        assert.ok(total <= K * 1.05, `population exceeded capacity: ${total.toFixed(0)} day ${day}`);
      }
    }

    // Trade actually happened and ships keep working.
    const runs = w.islands.reduce((a, i) => a + i._runs, 0);
    assert.ok(runs >= w.islands.length, `too few trade runs: ${runs}`);
    assert.ok(w.ships.some((s) => s.state !== 'idle'), 'all ships idle at end');
  });
}
