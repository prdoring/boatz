// Wire projections (server → client) + the SHARED field-name constants imported by
// BOTH the server projection here and the client StateBuffer/InfoPanel — one source
// of truth, so a field rename is a single grep-able edit, not silent client drift.
// PURE (imports only sibling sim modules). LOSSY — not a save format (see serialize.js).

import { bidAsk } from './pricing.js';
import { GOLD, cargoUnits } from './resources.js';
import { intelSummary, currentDay } from './beliefs.js';
import { rankOf, skill01 } from './captains.js';
import { foodDaysAboard } from './crew.js';
import { magRank, magSkill } from './magistrate.js';

// StateBuffer field descriptors for ships (the interpolated `entities` map).
export const SHIP_LERP = ['x', 'y'];
export const SHIP_ANGLE = ['heading'];
export const SHIP_COPY = ['state', 'type', 'homeId', 'destId', 'reason', 'eta', 'cargo', 'gold', 'route', 'cap', 'used', 'sick', 'captain', 'morale', 'foodDays', 'revolt', 'name', 'pirate', 'privateer', 'bounty'];

// Display state (for art + panel) from the internal sim state.
function displayState(s) {
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

/** id → ship, the map StateBuffer interpolates. */
export function snapshotShips(world) {
  const out = {};
  for (const s of world.ships) {
    const v = s.voyage;
    const cur = v ? v.stops[v.index] : null;
    const moving = s.state === 'outbound' || s.state === 'inbound';
    const eta = moving ? Math.round(Math.hypot(s.targetX - s.x, s.targetY - s.y) / s.speed) : 0;
    out[s.id] = {
      x: s.x, y: s.y, heading: s.heading,
      state: displayState(s.state),
      type: s.type,
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
      pirate: !!s.pirate, // flying the black flag → distinct art + panel + map marker
      privateer: !!s.privateer, // a commissioned pirate-hunter → distinct art + panel + marker
      bounty: Math.round(s.bounty || 0), // gold on this (pirate's) head — shown in the panel/tip
      morale: round2(s.morale != null ? s.morale : 1),
      foodDays: round1(foodDaysAboard(world, s)),
      revolt: !!s.uprising, // crew in open revolt (dead in the water) → highlighted on the map
      captain: s.captain ? {
        name: s.captain.name, rank: rankOf(s.captain), xp: Math.round(s.captain.xp || 0),
        skill: round2(skill01(s.captain, world.rules)),
        personality: s.captain.personality, traits: s.captain.traits,
        portrait: s.captain.portrait,
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
  for (const s of world.ships) {
    if (s.state === 'trading' && s.goal) (docked[s.goal.partnerId] ||= []).push(s.id);
  }
  const islands = world.islands.map((isl) => {
    const buy = {}, sell = {}, stock = {};
    for (const res in isl.price) {
      const { bid, ask } = bidAsk(isl.price[res].mid, spread);
      buy[res] = round2(bid);   // price the island PAYS to buy from a ship
      sell[res] = round2(ask);  // price the island CHARGES to sell to a ship
      stock[res] = Math.round(isl.stock[res]);
    }
    const rel = repSummary(isl);
    return {
      id: isl.id, x: isl.x, y: isl.y, name: isl.name, type: isl.type, color: isl.color,
      population: Math.floor(isl.population), k: isl.k,
      gold: Math.floor(isl.gold),
      civ: round2(isl.civ),
      primary: isl.primary, secondary: isl.secondary, produces: isl.produces,
      stock, buy, sell,
      dockedShipIds: docked[isl.id] || [],
      allies: rel.allies, rivals: rel.rivals,
      blight: isl.blight ? isl.blight.res : null, // afflicted resource, for the map/panel
      plague: !!isl.plague,
      intel: intelSummary(world, isl, day), // { known, fresh } — reach of its price knowledge
      loyalty: round2(isl.loyalty != null ? isl.loyalty : 1),
      rebellion: !!isl.rebellion, // aflame in revolt → fire highlight on the map
      danger: round2(isl.danger || 0), // how pirate-haunted its waters are → panel/map cue
      contract: isl.contract ? { good: isl.contract.good, reward: Math.round(isl.contract.reward) } : null, // open WANTED posting
      magistrate: isl.magistrate ? {
        name: isl.magistrate.name, rank: magRank(isl.magistrate),
        skill: round2(magSkill(isl.magistrate, world.rules)),
        personality: isl.magistrate.personality, traits: isl.magistrate.traits,
        portrait: isl.magistrate.portrait,
      } : null,
    };
  });
  return {
    islands,
    economy: { totalGold: Math.round(world.totals.gold), shipCount: world.ships.length },
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

/** Static island layout for the WELCOME message (positions never change). */
export function snapshotLayout(world) {
  return world.islands.map((i) => ({ id: i.id, x: i.x, y: i.y, name: i.name, type: i.type, color: i.color, k: i.k }));
}

/** Top few allies (fondest) and rivals (most hostile) for the info panel. */
function repSummary(isl) {
  if (!isl.rep) return { allies: [], rivals: [] };
  const es = [];
  for (const id in isl.rep) es.push({ id, v: round2(isl.rep[id]) });
  es.sort((a, b) => b.v - a.v);
  const allies = es.filter((e) => e.v > 0.05).slice(0, 3);
  const rivals = es.filter((e) => e.v < -0.05).slice(-3).reverse();
  return { allies, rivals };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }
