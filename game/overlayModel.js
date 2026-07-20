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
    this.stats = null;    // active SCALAR overlay: { min,p50,max,mean,count,lo,hi, leaderboard }
    this.edges = null;    // active LINKS overlay: positioned edge array
    this.trouble = null;  // world tallies (recomputed whenever islands are present)
    this._sk = null;      // last synced scalar-overlay key
    this._ek = null;      // last synced links-overlay key
    this._t = -1e9;
    this._n = -1;
  }

  /** Recompute (throttled) the derived data for the two INDEPENDENT active layers — a scalar
   *  overlay (`scalarSpec`) and an edges/links overlay (`edgesSpec`), either of which may be an
   *  `off` spec. Cheap to call every frame: early-returns unless a layer key changed, the island
   *  count changed, or the throttle window elapsed. `stats`/`edges` are each cleared when their
   *  layer is off, so the two never clobber each other and can both paint at once. */
  sync(islands, scalarSpec, edgesSpec, shipsById, islandsById, now) {
    if (!islands) return;
    const sk = scalarSpec && scalarSpec.kind === 'scalar' ? scalarSpec.key : 'off';
    const ek = edgesSpec && edgesSpec.kind === 'edges' ? edgesSpec.key : 'off';
    const stale = sk !== this._sk || ek !== this._ek || islands.length !== this._n || (now - this._t) >= THROTTLE_MS;
    if (!stale) return;
    this._sk = sk; this._ek = ek; this._t = now; this._n = islands.length;

    this.trouble = troubleCounts(islands);

    if (scalarSpec && scalarSpec.kind === 'scalar') {
      const s = aggregate(islands, scalarSpec);
      s.leaderboard = leaderboard(islands, scalarSpec, LEADER_N);
      this.stats = s;
    } else {
      this.stats = null;
    }

    if (edgesSpec && edgesSpec.kind === 'edges') {
      this.edges = buildEdges(edgesSpec, islands, shipsById, islandsById);
    } else {
      this.edges = null;
    }
  }
}
