// Wind — a single global vector over the whole sea that drifts over time and speeds up or
// slows down ships depending on the heading they sail relative to it. `world.wind.dir` is the
// direction the wind blows TOWARD (radians); `str` is its strength 0..1. The wind eases
// smoothly toward periodically-rerolled targets, so it's continuous for rendering and roughly
// predictable for a good captain. Deterministic (seeded 'wind' stream) and serialisable
// (state is the plain `world.wind` object). PURE.
//
// Effect on a ship: windMult(world, heading, skill) — a tailwind (heading aligned with the
// wind) speeds it up, a headwind slows it (floored so it never fully stalls). A skilled
// captain sheds much of the headwind penalty (tacking know-how) and enjoys a small flat
// seamanship bonus, so experience turns bad wind from a wall into a manageable slog.

import { streamFloat } from './rng.js';

const TAU = Math.PI * 2;

function rollTarget(world) {
  const r = world.rules, w = world.wind;
  const turn = (streamFloat(world, 'wind') * 2 - 1) * r.WIND_TURN; // ± swing off current heading
  w.tDir = w.dir + turn;
  w.tStr = r.WIND_STR_MIN + streamFloat(world, 'wind') * (1 - r.WIND_STR_MIN);
  // Jitter the interval so shifts don't land on a fixed cadence.
  w.nextShift = world.simTime + r.WIND_SHIFT_SECONDS * (0.6 + 0.8 * streamFloat(world, 'wind'));
}

export function initWind(world) {
  const r = world.rules;
  world.wind = { dir: streamFloat(world, 'wind') * TAU, str: 0.55, tDir: 0, tStr: 0.6, nextShift: 0 };
  rollTarget(world);
}

/** SIM system: re-roll the target when due, then ease dir/str toward it (per-substep, so the
 *  drift is identical at any fast-forward speed). */
export function wind(world, h) {
  const w = world.wind;
  if (!w) return;
  if (world.simTime >= w.nextShift) rollTarget(world);
  const ease = Math.min(1, world.rules.WIND_EASE * h);
  let d = w.tDir - w.dir;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest way round
  w.dir += d * ease;
  w.str += (w.tStr - w.str) * ease;
}

/** Speed multiplier for a ship on `heading` (radians), given the captain's skill 0..1.
 *  align = +1 dead tailwind … −1 dead headwind. Skilled captains halve the upwind bite. */
export function windMult(world, heading, skill = 0) {
  const w = world.wind;
  if (!w) return 1;
  const r = world.rules;
  let align = Math.cos(heading - w.dir);
  if (align < 0) align *= (1 - skill * r.TACK_SKILL); // tacking know-how softens the headwind
  const m = 1 + r.WIND_EFFECT * w.str * align + skill * r.SEAMANSHIP_BONUS;
  return Math.max(r.WIND_MULT_MIN, m);
}

/** How strongly a course toward `heading` bucks the wind: +1 dead upwind … −1 dead downwind.
 *  Drives the tack/wait decisions (goals.js / ship.js) without re-deriving the geometry. */
export function upwindness(world, heading) {
  const w = world.wind;
  if (!w) return 0;
  return -Math.cos(heading - w.dir) * w.str;
}
