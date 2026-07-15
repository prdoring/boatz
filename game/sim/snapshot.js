// Wire projections (server → client) + the SHARED field-name constants imported by
// BOTH the server projection here and the client StateBuffer/InfoPanel — one source
// of truth, so a field rename is a single grep-able edit, not silent client drift.
// PURE (imports only sibling sim modules). LOSSY — not a save format (see serialize.js).

import { bidAsk } from './pricing.js';
import { GOLD, cargoUnits } from './resources.js';
import { foodDays } from './island.js';
import { intelSummary, currentDay } from './beliefs.js';
import { factSummary } from './intel.js';
import { rankOf, skill01, totalXp } from './captains.js';
import { foodDaysAboard } from './crew.js';
import { magRank, magSkill, ambitionLabel } from './magistrate.js';

// StateBuffer field descriptors for ships (the interpolated `entities` map). Only the HOT fields
// ride the ~10 Hz channel (position lerps; the art/marker fields copy). Everything else — the panel
// detail and slow-changing bulk (captain, the intel LOG, route, cargo, morale…) — travels on the
// ~1 Hz COLD channel (snapshotShipsCold) and is merged client-side by id. At ~2000 ships the log +
// captain alone were ~60% of a 2 MB/frame stream; splitting them off cuts the hot frame ~7×.
export const SHIP_LERP = ['x', 'y'];
export const SHIP_ANGLE = ['heading'];
export const SHIP_COPY = ['state', 'type', 'pirate', 'privateer']; // hot, non-interpolated (art/marker)

/** A ship's LOGBOOK for the panel — the ports it currently carries intel on, freshest first, each
 *  tagged with how many days old the sighting is and any danger/haven it noted. This is the physical
 *  information payload the ship is carrying (destroy/interrogate it and that knowledge is lost). */
function shipLog(world, ship, day) {
  const intel = ship.intel;
  if (!intel) return [];
  const out = [];
  for (const id in intel) {
    const r = intel[id];
    out.push({ id, age: day - r.day, danger: round2(r.danger || 0), haven: !!r.haven, foodDays: round1(r.foodDays != null ? r.foodDays : 0) });
  }
  out.sort((a, b) => a.age - b.age);
  return out.slice(0, 14); // the freshest dozen-odd — enough for the panel, bounded on the wire
}

// Display state (for art + panel) from the internal sim state.
function displayState(ship) {
  if (ship._sheltered) return 'docked'; // fleeing hull riding out a raider in a refuge → berthed like any docked ship
  const s = ship.state;
  if (s === 'trading') return 'docked';
  if (s === 'outbound' || s === 'inbound') return 'sailing';
  return 'idle';
}

function compactCargo(cargo) {
  const out = {};
  for (const k in cargo) {
    if (k === GOLD) continue;
    if (cargo[k] > 0.01) out[k] = Math.round(cargo[k]);
  }
  return out;
}

/** id → ship HOT fields (position + art/marker state) — the ~10 Hz interpolated stream. Kept small:
 *  the panel-detail and slow bulk go on the cold channel (snapshotShipsCold). */
export function snapshotShips(world) {
  const out = {};
  for (const s of world.ships) {
    out[s.id] = {
      x: s.x, y: s.y, heading: s.heading,
      state: displayState(s),
      type: s.type,
      pirate: !!s.pirate, // flying the black flag → distinct art + panel + map marker
      privateer: !!s.privateer, // a commissioned pirate-hunter → distinct art + panel + marker
    };
  }
  return out;
}

/** id → ship COLD fields — the slow-changing / panel-only bulk, sent at ~1 Hz and merged client-side
 *  by id onto the interpolated hot entity. The intel LOG and captain object dominate the payload and
 *  barely change frame-to-frame, so this is where the bandwidth savings live. */
export function snapshotShipsCold(world) {
  const out = {};
  const day = currentDay(world);
  for (const s of world.ships) {
    const v = s.voyage;
    const cur = v ? v.stops[v.index] : null;
    const moving = s.state === 'outbound' || s.state === 'inbound';
    const eta = moving ? Math.round(Math.hypot(s.targetX - s.x, s.targetY - s.y) / s.speed) : 0;
    out[s.id] = {
      homeId: s.homeId,
      destId: cur ? cur.islandId : (s.state === 'inbound' ? s.homeId : null),
      reason: v ? v.reason : null,
      eta,
      route: v ? v.stops.map((st) => st.islandId) : [], // full multi-hop route for the panel
      cap: s.capacity,
      used: Math.round(cargoUnits(s, world.rules.GOLD_PER_CARGO_UNIT)),
      cargo: compactCargo(s.cargo),
      gold: Math.round(s.cargo[GOLD] || 0),
      sick: !!s.infected,
      name: s.name || null,
      bounty: Math.round(s.bounty || 0), // gold on this (pirate's) head — shown in the panel/tip
      log: shipLog(world, s, day), // the intel this ship is carrying (its logbook) — for the panel's Log tab
      morale: round2(s.morale != null ? s.morale : 1),
      hull: round2(s.hull != null ? s.hull : 1),   // structural integrity 0..1 (panel gauge + damaged art)
      rig: round2(s.rig != null ? s.rig : 1),      // rigging condition 0..1 (panel gauge)
      foodDays: round1(foodDaysAboard(world, s)),
      act: s._act ? s._act.k : null,     // what it is DOING right now (blockade/hunt/assault/flee…) — panel activity line
      actId: s._act ? (s._act.id || null) : null, // the island/ship that action concerns (client resolves the name)
      revolt: !!s.uprising, // crew in open revolt (dead in the water) → highlighted on the map
      adrift: !!s.adrift,   // blown off course & lost at sea (storm) → distress marker on the map
      prey: s._prey || null,        // ship it hunts (pirate→merchant) / chases (privateer→pirate) → hunts overlay
      siege: s._blockadeId || null, // island a pirate is blockading → hunts overlay
      guard: s.privateer ? (s._guard || null) : null, // port a privateer protects → hunts overlay
      captain: s.captain ? {
        name: s.captain.name, rank: rankOf(s.captain), xp: Math.round(totalXp(s.captain)),
        skill: round2(skill01(s.captain, world.rules)), // overall (strongest facet)
        skills: { // the three facets the panel gauges
          sea: round2(skill01(s.captain, world.rules, 'sea')),
          gun: round2(skill01(s.captain, world.rules, 'gun')),
          cmd: round2(skill01(s.captain, world.rules, 'cmd')),
        },
        personality: s.captain.personality, traits: s.captain.traits,
        portrait: s.captain.portrait,
        voiceSeed: s.captain.voiceSeed, // opaque seed → the client picks this keeper's writing style for the Story tab
      } : null,
    };
  }
  return out;
}

/** Full economy projection (islands + a global summary). Dynamic fields; static
 *  layout (id/x/y/name/type/color) also travels once in WELCOME. */
export function snapshotEconomy(world) {
  const spread = world.rules.SPREAD;
  const day = currentDay(world);
  const docked = {};
  const fleet = new Map(); // per-home census {total,pirate,privateer} → the naval-strength overlay
  let pirates = 0, privateers = 0;
  for (const s of world.ships) {
    if (s.state === 'trading' && s.goal) (docked[s.goal.partnerId] ||= []).push(s.id);
    if (s.pirate) pirates++; else if (s.privateer) privateers++;
    let f = fleet.get(s.homeId); if (!f) { f = { total: 0, pirate: 0, privateer: 0 }; fleet.set(s.homeId, f); }
    f.total++; if (s.pirate) f.pirate++; else if (s.privateer) f.privateer++;
  }
  // Embargo partners (severed trade) indexed per island from the global bloc state, so the client's
  // "blocs" overlay can draw the severed-trade edges without a new global wire field.
  const embargoBy = {};
  if (world._blocState) {
    for (const key in world._blocState) {
      if (world._blocState[key] !== 'embargo') continue;
      const i = key.indexOf('|'); const a = key.slice(0, i), b = key.slice(i + 1);
      (embargoBy[a] ||= []).push(b); (embargoBy[b] ||= []).push(a);
    }
  }
  const ZERO_FLEET = { total: 0, pirate: 0, privateer: 0 };
  let havenCount = 0;
  const islands = world.islands.map((isl) => {
    if (isl.haven) havenCount++;
    const buy = {}, sell = {}, stock = {};
    for (const res in isl.price) {
      const { bid, ask } = bidAsk(isl.price[res].mid, spread);
      buy[res] = round2(bid);   // price the island PAYS to buy from a ship
      sell[res] = round2(ask);  // price the island CHARGES to sell to a ship
      stock[res] = Math.round(isl.stock[res]);
    }
    const rel = repSummary(world, isl, day);
    return {
      // STATIC layout (id/x/y/name/type/color/k/primary/secondary/produces) travels ONCE in WELCOME
      // and the client merges by id — so it's omitted here (only `id` stays, as the merge key).
      id: isl.id,
      population: Math.floor(isl.population),
      gold: Math.floor(isl.gold),
      civ: round2(isl.civ),
      foodDays: round1(foodDays(isl, world.rules)), // days of food on hand → panel + food overlay

      stock, buy, sell,
      dockedShipIds: docked[isl.id] || [],
      allies: rel.allies, rivals: rel.rivals,
      blight: isl.blight ? isl.blight.res : null, // afflicted resource, for the map/panel
      plague: !!isl.plague,
      intel: intelSummary(world, isl, day), // { known, fresh } — reach of its price knowledge
      facts: factSummary(world, isl, day),  // { known, fresh } — reach of its NON-price intel (danger/haven/food)
      awaiting: isl.expecting ? Object.keys(isl.expecting).length : 0, // ships it still expects home (voyages.js ledger)
      loyalty: round2(isl.loyalty != null ? isl.loyalty : 1),
      rebellion: !!isl.rebellion, // aflame in revolt → fire highlight on the map
      danger: round2(isl.danger || 0), // how pirate-haunted its waters are → panel/map cue
      lawlessness: round2(isl.lawlessness || 0), // civil disorder 0..1 → panel/map cue (seed of havens)
      grievance: round2(isl.grievance || 0), // resentment from rebellions crushed by force → panel/map cue
      haven: isl.haven ? { strength: round2(isl.havenStrength || 0) } : null, // fallen to the black flag → map/panel
      fleet: fleet.get(isl.id) || ZERO_FLEET, // {total,pirate,privateer} home fleet → naval-strength overlay
      havenPressure: round1(isl._havenPressure || 0), // days sliding toward the black flag → "haven risk" overlay
      unrest: round1(isl.unrest || 0), // days simmering below the rebel line → "rebel pressure" overlay
      embargoes: embargoBy[isl.id] || [], // ports this island has severed trade with → blocs overlay

      contract: isl.contract ? { good: isl.contract.good, reward: Math.round(isl.contract.reward) } : null, // open WANTED posting
      magistrate: isl.magistrate ? {
        name: isl.magistrate.name, rank: magRank(isl.magistrate),
        skill: round2(magSkill(isl.magistrate, world.rules)),
        personality: isl.magistrate.personality, traits: isl.magistrate.traits,
        portrait: isl.magistrate.portrait,
        voiceSeed: isl.magistrate.voiceSeed, // opaque seed → the client picks this ruler's writing style for the Story tab
        ambition: isl.magistrate.ambition ? { kind: isl.magistrate.ambition.kind, label: ambitionLabel(isl.magistrate), progress: round2(isl.magistrate.ambition.progress || 0) } : null,
      } : null,
    };
  });
  return {
    islands,
    economy: {
      totalGold: Math.round(world.totals.gold), shipCount: world.ships.length,
      people: Math.round((world.totals && world.totals.people) || 0), // total souls across the sea → almanac
      pirates, privateers, havens: havenCount, // fleet-composition + fallen-ports summary → almanac header
    },
    events: world.events.slice(-60), // recent news for the ticker + the client's per-entity chronicles
  };
}

/** Global wind for the ships-message header — direction it blows toward + strength 0..1. */
export function windSnapshot(world) {
  const w = world.wind;
  return w ? { dir: round2(w.dir), str: round2(w.str) } : { dir: 0, str: 0 };
}

/** Active storms for the ships-message header (they move, so they ride the frequent channel). */
export function stormsSnapshot(world) {
  if (!world.storms || !world.storms.length) return [];
  return world.storms.map((s) => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y), r: Math.round(s.r) }));
}

/** Static island layout for the WELCOME message (positions/identity/production never change), so it
 *  is sent once and the ~1 Hz econ frame omits it (merged by id on the client). */
export function snapshotLayout(world) {
  return world.islands.map((i) => ({
    id: i.id, x: i.x, y: i.y, name: i.name, type: i.type, color: i.color, k: i.k,
    primary: i.primary, secondary: i.secondary, produces: i.produces,
  }));
}

/** Top few allies (fondest) and rivals (most hostile) for the info panel. This is a PURELY COSMETIC
 *  wire field (never read by the sim), and an island's dense rep map only shifts materially on the
 *  once-per-sim-day reputation tick — so it's cached per sim-day in an off-island map (world._repTop,
 *  not serialized) rather than re-sorting every island's whole rep map on every ~1 Hz broadcast
 *  (the O(N² log N) econ wall). Intra-day trade nudges show up on the next day's refresh. */
function repSummary(world, isl, day) {
  let cache = world._repTop;
  if (!cache) cache = world._repTop = new Map();
  const hit = cache.get(isl.id);
  if (hit && hit.day === day) return hit;
  let allies = [], rivals = [];
  if (isl.rep) {
    const es = [];
    for (const id in isl.rep) es.push({ id, v: round2(isl.rep[id]) });
    es.sort((a, b) => b.v - a.v);
    allies = es.filter((e) => e.v > 0.05).slice(0, 3);
    rivals = es.filter((e) => e.v < -0.05).slice(-3).reverse();
  }
  const entry = { allies, rivals, day };
  cache.set(isl.id, entry);
  return entry;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }
