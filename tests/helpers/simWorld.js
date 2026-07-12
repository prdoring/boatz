// Test helper: build a fresh sim world from the project's economy + a PROCEDURAL roster.
// (The register-loader remaps /data/ and /game/ so these absolute specifiers resolve.)
// The roster is generated from a FIXED seed so tests stay deterministic (the live server
// rolls a fresh sea each boot — see server/simHost.js).
import economyRaw from '/data/economy.json' with { type: 'json' };
import { buildWorld } from '/game/sim/world.js';
import { generateRoster } from '/game/sim/roster.js';

const roster = generateRoster(1);

export function makeWorld(seed = 1337) {
  // Clone the frozen JSON import — buildWorld annotates world.economy.
  return buildWorld({ economy: structuredClone(economyRaw), roster, seed });
}

export function capOfRes(world, res) {
  return world.economy.goods.includes(res) ? world.rules.GOODS_CAP : world.rules.STOCKPILE_CAP;
}

export { economyRaw, roster };
