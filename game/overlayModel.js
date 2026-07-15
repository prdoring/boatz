// The per-frame overlay MODEL — owned by SimScene, driven from update(). It runs the O(N)
// aggregation / leaderboard / edge-extraction math (from ./overlays.js) on a THROTTLE so the
// renderer + almanac read precomputed results instead of each recomputing 60×/s. The underlying
// econ snapshot only refreshes ~1 Hz, so a ~400 ms throttle is invisible. This module is pure
// data (no canvas): the renderer paints from `stats`/`edges`; the dashboard reads all three.

import { aggregate, leaderboard, troubleCounts, relationEdges, laneEdges, aidEdges, embargoEdges, huntEdges } from './overlays.js';

const THROTTLE_MS = 400;
const LEADER_N = 8;

/** Build the positioned edge set for an `edges` overlay (Phase 2+). Returns null for scalar/off. */
function buildEdges(spec, islands, shipsById, islandsById) {
  switch (spec.key) {
    case 'alliances': return relationEdges(islands, islandsById);
    case 'lanes': return laneEdges(shipsById, islandsById);
    case 'aid': return aidEdges(shipsById, islandsById);
    case 'blocs': return relationEdges(islands, islandsById).concat(embargoEdges(islands, islandsById));
    case 'hunts': return huntEdges(shipsById, islandsById);
    default: return null;
  }
}

export class OverlayModel {
  constructor() {
    this.stats = null;    // active SCALAR: { min,p50,max,mean,count,lo,hi, leaderboard }
    this.edges = null;    // active EDGES: positioned edge array
    this.trouble = null;  // world tallies (recomputed whenever islands are present)
    this._key = null;
    this._t = -1e9;
    this._n = -1;
  }

  /** Recompute (throttled) the derived data for the active `spec`. Cheap to call every frame:
   *  it early-returns unless the metric changed, the island count changed, or the throttle
   *  window elapsed. Safe with a null/off spec (clears stats/edges, still tallies trouble). */
  sync(islands, spec, shipsById, islandsById, now) {
    if (!islands) return;
    const key = spec ? spec.key : 'off';
    const stale = key !== this._key || islands.length !== this._n || (now - this._t) >= THROTTLE_MS;
    if (!stale) return;
    this._key = key; this._t = now; this._n = islands.length;

    this.trouble = troubleCounts(islands);

    if (spec && spec.kind === 'scalar') {
      const s = aggregate(islands, spec);
      s.leaderboard = leaderboard(islands, spec, LEADER_N);
      this.stats = s;
      this.edges = null;
    } else if (spec && spec.kind === 'edges') {
      this.stats = null;
      this.edges = buildEdges(spec, islands, shipsById, islandsById);
    } else {
      this.stats = null;
      this.edges = null;
    }
  }
}
