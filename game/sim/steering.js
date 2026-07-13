// Steering geometry — pure helpers shared by the pirate and privateer drivers (piracy.js,
// antipiracy.js) for behaviours that CIRCLE or stand off a point rather than beeline to it (a
// pirate blockading a port, a privateer patrolling the one it guards). No game nouns, no state:
// just vector math over positions the callers pass in, so it serialises for free and stays
// deterministic. PURE.

/** A point on the circle of `radius` around (cx,cy), advanced `dTheta` radians (signed by `dir`)
 *  from the current bearing of (fx,fy). Steer a hull at this each substep and it ORBITS the centre:
 *  from off the circle it spirals in to `radius`; once on it, it sweeps steadily around. Stateless —
 *  the angle is read live from position, so there is nothing to serialise and no drift across saves. */
export function orbitPoint(cx, cy, fx, fy, radius, dir = 1, dTheta = 0.1) {
  const ang = Math.atan2(fy - cy, fx - cx) + dir * dTheta;
  return { x: cx + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius };
}

/** The per-substep angular step that keeps the orbit point just AHEAD of a hull moving at `speed`
 *  around a ring of `radius` — so the ship chases the point round the circle instead of the point
 *  outrunning it (a big jump) or the ship overshooting a stationary mark. Capped for tiny radii. */
export function orbitStep(speed, radius, h) {
  if (radius <= 1) return 0.3;
  return Math.min(0.35, (speed * h) / radius);
}

/** Orbit direction for a ship, deterministic from its id (even/odd → clockwise / widdershins) so a
 *  cluster of blockaders or patrollers sweeps in a mix of directions rather than lockstep. */
export function orbitDir(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10) || 0;
  return (n % 2) ? 1 : -1;
}

/** A point `dist` beyond (fx,fy) on the heading AWAY from (cx,cy) — for breaking off and running:
 *  a cautious pirate fleeing a privateer, or any hull opening the range from a threat. */
export function awayPoint(cx, cy, fx, fy, dist) {
  const dx = fx - cx, dy = fy - cy, d = Math.hypot(dx, dy) || 1;
  return { x: fx + (dx / d) * dist, y: fy + (dy / d) * dist };
}
