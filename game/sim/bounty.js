// Bounties + sea danger — the MARKET's response to piracy, and the seam that couples the
// predators (piracy.js) to their hunters (antipiracy.js) without an import cycle: piracy WRITES
// danger/bounties here on each attack, antipiracy READS them to route merchants around trouble
// and to commission privateers. When a pirate robs a ship or sacks a port, the aggrieved island
// posts GOLD on that pirate's head (a treasury sink) and word raises the DANGER of those waters.
// Killing the pirate pays its accumulated bounty to the victor's home (a gold flow, not a mint —
// the economy is deliberately non-conserving; see events/upkeep). PURE.

import { logEvent } from './events.js';

/** The island nearest a point — the "aggrieved" port for an attack out at sea. */
export function nearestIsland(world, x, y) {
  let best = null, bestD = Infinity;
  for (const p of world.islands) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Word of an attack raises the danger of the nearest waters (0..1, decays in antipiracy). */
export function markDanger(world, x, y, kind) {
  const t = world.rules;
  const isl = nearestIsland(world, x, y);
  if (!isl) return;
  const bump = kind === 'raid' ? t.DANGER_RAID : kind === 'fight' ? t.DANGER_FIGHT : t.DANGER_PLUNDER;
  isl.danger = Math.min(1, (isl.danger || 0) + bump);
}

/** An aggrieved island puts gold on a pirate's head — bounded by what it can spare (keeping a
 *  reserve) and a per-pirate ceiling. The gold leaves the treasury now; it's paid out only if the
 *  pirate is killed (else it's a sink — the cost of living under the black flag's shadow). */
export function postBounty(world, pirate, islandId, kind) {
  const t = world.rules;
  const isl = world.islandsById.get(islandId);
  if (!isl || !pirate.pirate) return;
  const want = kind === 'raid' ? t.BOUNTY_RAID : t.BOUNTY_PLUNDER;
  const spare = Math.max(0, (isl.gold || 0) - t.PRIVATEER_TREASURY_MIN) * t.BOUNTY_TREASURY_FRAC;
  const headroom = Math.max(0, t.BOUNTY_MAX - (pirate.bounty || 0));
  const amt = Math.floor(Math.min(want, spare, headroom));
  if (amt < 1) return;
  isl.gold -= amt;
  const first = !pirate.bounty;
  pirate.bounty = (pirate.bounty || 0) + amt;
  pirate.bountyFrom = islandId;
  if (first) logEvent(world, 'bounty', `${isl.name} put ${amt}g on the head of ${pirate.name} — Capt. ${pirate.captain ? pirate.captain.name : 'the rogue'} is now wanted.`, { islandId, shipId: pirate.id });
}

/** Pay a dead pirate's bounty to the victor's home port (a gold flow). Returns the sum paid. */
export function payBounty(world, pirate, killerIslandId) {
  const amt = pirate.bounty || 0;
  pirate.bounty = 0;
  if (amt <= 0) return 0;
  const isl = killerIslandId && world.islandsById.get(killerIslandId);
  if (isl) isl.gold += amt;
  return amt;
}
