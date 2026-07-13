// Island avoidance — steer a hull AROUND a landmass in its path instead of sailing straight through it.
// Ships beeline to their target; when a NON-destination island blocks that beeline, this deflects the aim
// to a point beside the island (on the side toward the target), so the hull rounds the shore and re-aims at
// the real target once the obstacle is astern. LOCAL + greedy (only the nearest blocker), which suits a
// SPARSE ocean of convex, roughly-circular islands — no global pathfinding, no per-ship route state. PURE.
//
// The destination island is EXEMPT (a ship must be able to enter it to dock), found by the target sitting
// on its land. A hull already AT an island it's leaving (the blocker would be right on top of it, projecting
// to zero distance ahead) is likewise ignored, so departures aren't fought.

import { eachIslandInRange } from './grid.js';

/** An island's land radius — MIRRORS the client's WorldRenderer.islandRadius (ISLAND_RADIUS·(k/K)^POW,
 *  clamped) so a hull visibly rounds the DRAWN landmass. The constants live in sim tuning; keep them in
 *  step with game/config.js ISLAND_RADIUS + WorldRenderer.islandRadius if either changes. */
export function islandLandRadius(isl, rules) {
  const k = isl.k || 120;
  const scale = Math.pow(k / (rules.ISLAND_RADIUS_K || 130), rules.ISLAND_RADIUS_POW || 0.62);
  return (rules.ISLAND_RADIUS || 58) * Math.max(0.4, Math.min(1.85, scale));
}

/** Aim point for a hull steering from (ship) toward (tx,ty): `{x, y, deflected}`. When the path is clear
 *  it is the target itself (deflected:false → arrival/docking works unchanged). When a non-destination
 *  island blocks the way, it is a point beside that island (deflected:true) that the hull heads for to
 *  round the shore; being off the target, straight-line movement never mistakes it for an arrival. */
export function steerAroundIslands(world, ship, tx, ty) {
  const t = world.rules;
  const clear = t.SHIP_ISLAND_CLEARANCE;
  if (clear == null) return { x: tx, y: ty, deflected: false }; // feature disabled
  const sx = ship.x, sy = ship.y;
  const dx = tx - sx, dy = ty - sy;
  const L = Math.hypot(dx, dy);
  if (L < 1e-3) return { x: tx, y: ty, deflected: false };
  const dirx = dx / L, diry = dy / L;
  const look = Math.min(L, t.SHIP_ISLAND_LOOKAHEAD || 450);

  // Nearest island (along the heading) whose land the straight route would cut through.
  let block = null, blockAlong = Infinity, blockR = 0;
  eachIslandInRange(world, sx, sy, look, (isl) => {
    const R = islandLandRadius(isl, t) + clear;
    const tdx = isl.x - tx, tdy = isl.y - ty;
    if (tdx * tdx + tdy * tdy < R * R) return;          // the destination — must be enterable, don't avoid
    const cx = isl.x - sx, cy = isl.y - sy;
    const along = cx * dirx + cy * diry;                // distance ahead along the heading
    if (along <= 0 || along >= look) return;            // behind us / at us, or beyond the look-ahead
    const perp = cx * diry - cy * dirx;                 // signed offset of the centre from the ray
    if (Math.abs(perp) >= R) return;                    // the route clears its land — nothing to do
    if (along < blockAlong) { blockAlong = along; block = isl; blockR = R; }
  });
  if (!block) return { x: tx, y: ty, deflected: false };

  // Round the blocker by steering along the EDGE of its tangent cone, on the side toward the target.
  // (Aiming at the point abeam of the island instead lets a re-aiming hull spiral in — the chord to an
  // abeam point cuts the circle, closing to ~0.707·R. The tangent bearing grazes at exactly R.) The half-
  // angle of the cone is asin(R/dC); a small margin (R·1.06) keeps the graze OUTSIDE the land, not on it.
  const toCx = block.x - sx, toCy = block.y - sy;
  const dC = Math.hypot(toCx, toCy) || 1;
  const ux = toCx / dC, uy = toCy / dC;                 // unit ship→island
  const theta = Math.asin(Math.min(0.999, (blockR * 1.06) / dC)); // tangent-cone half-angle (+margin)
  const side = ((tx - sx) * -uy + (ty - sy) * ux) >= 0 ? 1 : -1; // pass on the side the target lies
  const a = theta * side, ca = Math.cos(a), sa = Math.sin(a);
  const ax = ux * ca - uy * sa, ay = ux * sa + uy * ca; // ship→island bearing rotated off by the half-angle
  const reach = Math.max(dC, blockR + 1);               // aim along that bearing, past the island (stable heading)
  return { x: sx + ax * reach, y: sy + ay * reach, deflected: true };
}
