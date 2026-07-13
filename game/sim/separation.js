// Ship-to-ship COLLISION AVOIDANCE, with a nod to the actual rules of the road (COLREGS). Runs after
// all movement (ship/piracy/antipiracy) so it reads final positions + headings, and nudges any at-sea
// hulls that are crowding each other apart — a LIGHT touch, just enough that they don't stack. Two parts:
//
//   • SEPARATION — a gentle radial shove when two hulls close inside SHIP_SEPARATION_RANGE, so they never
//     pile up. Applies in every case (even a stand-on vessel), the safety net of COLREGS Rule 17.
//   • RIGHT-OF-WAY — when a hull is CLOSING on another that lies ahead, it eases to STARBOARD (its right):
//       – head-on, BOTH veer right and pass port-to-port (Rule 14);
//       – crossing, the vessel with the other on its STARBOARD side gives way while the other holds (Rule 15);
//       – overtaking, the faster hull coming up from astern keeps clear (Rule 13).
//     The bow leans into the manoeuvre so the veer reads as a turn, not a sideways crab.
//
// Two hulls locked in a chase (a pirate and its prey, a privateer and its quarry — either side's `_prey`)
// are EXEMPT: a boarding action is meant to close and grapple, not politely give way. Only ships under way
// are touched (docked/idle hulls sit at berths the renderer assigns, not their raw sim position).
//
// PURE + deterministic: every nudge is gathered from ONE position/heading snapshot, then applied — so it is
// order-independent and needs no RNG. Conserves nothing economic (only x/y/heading of moving hulls).

import { buildShipGrid, eachShipInRange } from './grid.js';

const GOLDEN = 2.399963229728653; // rad — spreads exactly-stacked hulls along distinct bearings by id

/** SIM system: nudge crowding at-sea ships apart (COLREGS-flavoured). Registered after antipiracy. */
export function separation(world, h) {
  const t = world.rules;
  const SEP = t.SHIP_SEPARATION_RANGE || 0;
  if (SEP <= 0) return;
  const AVOID = Math.max(SEP, t.SHIP_AVOID_RANGE || 0);
  const atSea = world.ships.filter((s) => !s._sunk && (s.state === 'outbound' || s.state === 'inbound'));
  if (atSea.length < 2) return;
  const grid = buildShipGrid(world, atSea);
  const sepPush = t.SHIP_SEPARATION_PUSH || 0;
  const veerPush = t.SHIP_AVOID_VEER || 0;
  const fwdCos = t.SHIP_AVOID_FWD_COS != null ? t.SHIP_AVOID_FWD_COS : 0.3;

  const moves = []; // gather first (from the snapshot), apply after — order-independent
  for (const s of atSea) {
    const fx = Math.cos(s.heading), fy = Math.sin(s.heading); // forward unit
    const stx = -fy, sty = fx;                                // starboard unit (screen coords, y-down)
    const sSpd = s.speed || t.SHIP_SPEED;
    let sepx = 0, sepy = 0, veerx = 0, veery = 0;
    eachShipInRange(grid, s.x, s.y, AVOID, (o) => {
      if (o === s) return;
      if (o.id === s._prey || s.id === o._prey) return; // a chase closes and grapples — never give way to prey
      const dx = s.x - o.x, dy = s.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= AVOID) return;
      if (d < 1e-3) { // exactly stacked — split along a deterministic per-hull bearing
        const nid = parseInt(String(s.id).replace(/\D/g, ''), 10) || 0;
        sepx += Math.cos(nid * GOLDEN); sepy += Math.sin(nid * GOLDEN);
        return;
      }
      // SEPARATION: shove away from a hull inside the hard radius (weight rises as they close).
      if (d < SEP) { const w = (SEP - d) / SEP; sepx += (dx / d) * w; sepy += (dy / d) * w; }
      // RIGHT-OF-WAY: ease to starboard when CLOSING on a hull that lies ahead.
      const tox = -dx / d, toy = -dy / d;              // unit vector from us toward o
      const ahead = fx * tox + fy * toy;               // 1 = o dead ahead
      const side = stx * tox + sty * toy;              // >0 = o on our starboard side
      const ofx = Math.cos(o.heading), ofy = Math.sin(o.heading);
      const align = fx * ofx + fy * ofy;               // 1 = same course, -1 = opposed
      const oSpd = o.speed || t.SHIP_SPEED;
      const closing = (sSpd * fx - oSpd * ofx) * tox + (sSpd * fy - oSpd * ofy) * toy > 0;
      if (!closing) return;
      const headOn = align < -0.6 && ahead > fwdCos;         // meeting head-on → both veer right
      const overtaking = align > 0.6 && ahead > 0.4;         // coming up astern of a slower hull ahead
      const giveWay = side > 0.05 && ahead > -0.3;           // o on our starboard, forward of the beam
      if (headOn || overtaking || giveWay) {
        const w = (AVOID - d) / AVOID;                       // firmer the closer they are
        veerx += stx * w; veery += sty * w;
      }
    });
    const sep = clampVec(sepx, sepy, sepPush);
    const veer = clampVec(veerx, veery, veerPush);
    const ax = sep.x + veer.x, ay = sep.y + veer.y;
    if (ax !== 0 || ay !== 0) moves.push({ s, ax, ay, fwd: sSpd * h });
  }
  // Apply: nudge position, and lean the bow into the resulting motion so a veer looks like a turn.
  for (const m of moves) {
    m.s.x += m.ax; m.s.y += m.ay;
    const hx = Math.cos(m.s.heading) * m.fwd + m.ax, hy = Math.sin(m.s.heading) * m.fwd + m.ay;
    if (hx !== 0 || hy !== 0) m.s.heading = Math.atan2(hy, hx);
  }
}

/** Scale (x,y) so a summed-weight of 1 maps to `max` units and anything more is clamped to `max`. */
function clampVec(x, y, max) {
  const m = Math.hypot(x, y);
  if (m < 1e-9 || max <= 0) return { x: 0, y: 0 };
  const f = (max * Math.min(m, 1)) / m;
  return { x: x * f, y: y * f };
}
