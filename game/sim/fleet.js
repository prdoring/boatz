// Per-home fleet census — one O(S) pass that replaces the O(N·S) / O(S²) "count a port's
// ships by scanning the whole fleet" pattern scattered across the sim (dispatch's ship-demand,
// maybeSink's last-ship guard, development, havens' pirate count, anti-piracy's privateer
// count, the buy-ship gate). Each consuming SIM system rebuilds it at its own start so reads are
// O(1); `fleetAt` also self-heals if the fleet changed since (so direct unit calls stay correct).
// It is a DERIVED index — never serialized; rebuilt from world.ships. PURE.
//
//   world.fleetByHome: Map<homeId, { total, pirate, privateer }>
//   (merchant count = total - pirate - privateer)

const EMPTY = Object.freeze({ total: 0, pirate: 0, privateer: 0 });

function build(world) {
  const m = new Map();
  for (const s of world.ships) {
    const e = m.get(s.homeId);
    if (!e) { m.set(s.homeId, { total: 1, pirate: s.pirate ? 1 : 0, privateer: (!s.pirate && s.privateer) ? 1 : 0 }); continue; }
    e.total++;
    if (s.pirate) e.pirate++; else if (s.privateer) e.privateer++;
  }
  world.fleetByHome = m;
  // Freshness stamp: the exact array we counted and its length. A ship removal replaces the
  // array (new ref); a spawn/push keeps the ref but grows the length — either invalidates.
  world._fleetRef = world.ships;
  world._fleetLen = world.ships.length;
  return m;
}

/** Rebuild the per-home census (O(S)). A SIM system calls this at its start so its reads are O(1). */
export function computeFleetByHome(world) { return build(world); }

/** Per-home census entry {total,pirate,privateer}. Reuses the built index while it's still valid
 *  for the current world.ships (same array + length), else rebuilds — so a read after mutating the
 *  fleet is never stale, while the bulk of pipeline reads stay O(1). Read-only; don't mutate it. */
export function fleetAt(world, homeId) {
  const fresh = world.fleetByHome && world._fleetRef === world.ships && world._fleetLen === world.ships.length;
  const m = fresh ? world.fleetByHome : build(world);
  return m.get(homeId) || EMPTY;
}
