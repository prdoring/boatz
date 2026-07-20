// Ship condition — the two 0..1 tracks a hull carries, and how they are worn and mended. PURE.
//
//   HULL — structural integrity: the combat HP pool, the founder-risk multiplier at sea and in a
//          storm, and what a ship dies of when it reaches 0.
//   RIG  — sails & rigging: multiplies effective speed, so a shot-away rig means a ship can't
//          outrun a pirate, chase prey, or make its voyage on time.
//
// Both wear from combat (piracy/antipiracy/shore) and storms (weather) — added in later phases — and
// are MENDED AT PORT from WOOD (hull) and FIBER (rig): a new, sustained demand ports near dangerous
// waters feel most, quicker and less wasteful the better the captain's SEAMANSHIP. A hull-class ARMOR
// value divides incoming damage (a galleon shrugs off what staves a sloop). Mirrors provisionCrew
// (crew.js): a HOME port mends free from its own stores; a foreign yard sells timber/canvas at ask.

import { GOLD, transfer, cargoUnits } from './resources.js';
import { bidAsk } from './pricing.js';
import { skill01, awardSeamanshipXp, awardCommandXp } from './captains.js';
import { logEvent, logEventThrottled } from './events.js';

/** Give a fresh hull full condition (called from createShip). */
export function initCondition(ship) {
  ship.hull = 1;
  ship.rig = 1;
}

/** Speed multiplier from rigging condition — a dismasted hull still crawls (RIG_SPEED_FLOOR), never
 *  fully frozen (so a crippled ship can always limp somewhere — no softlock). A whole rig → ×1. */
export function rigMult(ship, rules) {
  const rig = ship.rig != null ? ship.rig : 1;
  const floor = rules.RIG_SPEED_FLOOR != null ? rules.RIG_SPEED_FLOOR : 0.2;
  return floor + (1 - floor) * Math.max(0, Math.min(1, rig));
}

/** Founder-risk multiplier from hull condition — a battered, leaky hull founders far more readily.
 *  A whole hull → ×1 (neutral); a staved-in one → ×(1 + HULL_LEAK_RISK). */
export function hullRisk(ship, rules) {
  const hull = ship.hull != null ? ship.hull : 1;
  return 1 + (rules.HULL_LEAK_RISK || 0) * (1 - Math.max(0, Math.min(1, hull)));
}

/** A hull's damage resistance (its class armour), dividing incoming hull/rig damage. */
function armorOf(ship, rules) {
  const spec = rules.SHIP_TYPES && rules.SHIP_TYPES[ship.type];
  return (spec && spec.armor) || 1;
}

/** Apply hull damage (armour-divided), clamped to [0,1]. Returns the new hull. */
export function damageHull(ship, amt, rules) {
  if (ship.hull == null) ship.hull = 1;
  ship.hull = Math.max(0, ship.hull - Math.max(0, amt) / armorOf(ship, rules));
  return ship.hull;
}

/** Apply rigging damage (armour-divided), clamped to [0,1]. Returns the new rig. */
export function damageRig(ship, amt, rules) {
  if (ship.rig == null) ship.rig = 1;
  ship.rig = Math.max(0, ship.rig - Math.max(0, amt) / armorOf(ship, rules));
  return ship.rig;
}

/** Is the ship in DISTRESS — dismasted (rig at/below the floor) or already adrift? (starvation and
 *  the aid response come in a later phase). The trigger a passing ally answers with aid. */
export function inDistress(ship, rules) {
  const rig = ship.rig != null ? ship.rig : 1;
  if (rig <= (rules.RIG_DISTRESS != null ? rules.RIG_DISTRESS : 0.12)) return true;
  if (ship.adrift) return true;
  return false;
}

/** Mend one condition track at a port, consuming its material (Wood for hull, Fiber for rig). Home
 *  mends free (an operating cost); a foreign yard sells at ask from the ship's purse. A port keeps a
 *  reserve of its own timber/canvas — when it hasn't enough to help a badly-hurt ship, that's a story.
 *  Returns the condition actually restored. */
function mendTrack(world, island, ship, track, good, perFull, capFrac, atHome) {
  const r = world.rules;
  const cond = ship[track] != null ? ship[track] : 1;
  const missing = 1 - cond;
  if (missing < 0.02) return 0;
  const want = Math.min(missing, capFrac);              // condition we'd restore this dock
  const needMat = want * (perFull || 10);               // timber/canvas that would take
  const target = island.targets && island.targets[good] ? island.targets[good] : 0;
  const reserve = target * (r.REPAIR_RESERVE || 0);
  const spare = Math.max(0, (island.stock[good] || 0) - reserve);
  const ask = island.price && island.price[good] ? bidAsk(island.price[good].mid, r.SPREAD).ask : 0;
  const afford = atHome ? Infinity : (ask > 0 ? (ship.cargo[GOLD] || 0) / ask : Infinity);
  const mat = Math.min(needMat, spare, afford);
  if (mat < 0.5) {
    if (missing > 0.3 && spare < 0.5) // a hurt ship, and the yard is bare — a shortage worth a headline
      logEventThrottled(world, 'refitshort', r.SIM_DAY_SECONDS,
        `${island.name} had no ${good === 'Wood' ? 'timber' : 'canvas'} to mend ${ship.name || 'a battered ship'}.`,
        { islandId: island.id, shipId: ship.id });
    return 0;
  }
  island.stock[good] = Math.max(0, (island.stock[good] || 0) - mat);            // material consumed (goods aren't conserved)
  if (!atHome && ask > 0) transfer(ship.cargo, GOLD, island, 'gold', Math.min(ship.cargo[GOLD] || 0, mat * ask));
  const gained = mat / (perFull || 10);
  ship[track] = Math.min(1, cond + gained);
  return gained;
}

/** Refit a docked ship — mend hull (Wood) then rig (Fiber), each up to a per-dock cap widened by the
 *  captain's SEAMANSHIP. Called wherever provisionCrew is (departure, each dock, safe harbour, home). */
export function repairAtPort(world, island, ship) {
  const r = world.rules;
  if (!island || !island.stock) return;
  if (ship.hull == null) ship.hull = 1;
  if (ship.rig == null) ship.rig = 1;
  // A ship's own faction mends her free: a home port her merchants, a HAVEN its rogues (the den's
  // shipwrights). A foreign yard sells timber & canvas at ask like any other good.
  const atHome = island.id === ship.homeId || (island.haven && ship.pirate);
  const skill = skill01(ship.captain, r, 'sea');
  const cap = (r.REPAIR_PER_DOCK || 0.6) * (1 + (r.REPAIR_SKILL_BONUS || 0) * skill);
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const hull0 = ship.hull;
  mendTrack(world, island, ship, 'hull', goods.hull, r.REPAIR_WOOD_PER_HULL, cap, atHome);
  mendTrack(world, island, ship, 'rig', goods.rig, r.REPAIR_FIBER_PER_RIG, cap, atHome);
  if (hull0 < 0.5 && ship.hull - hull0 > 0.2) // a real refit of a battered hull — a quiet good-news beat
    logEventThrottled(world, 'refit', r.SIM_DAY_SECONDS,
      `${ship.name || 'A battered ship'} was refitted at ${island.name}.`, { islandId: island.id, shipId: ship.id });
}

/** Mend one track AT SEA from a good CARRIED ABOARD (no port, no purchase) — capped by `cap` condition. */
function mendFromHold(ship, track, good, perFull, cap) {
  const cond = ship[track] != null ? ship[track] : 1;
  const missing = 1 - cond;
  if (missing < 0.005 || cap <= 0) return;
  const want = Math.min(missing, cap);
  const mat = Math.min(want * (perFull || 10), ship.cargo[good] || 0);
  if (mat < 0.01) return;
  ship.cargo[good] = (ship.cargo[good] || 0) - mat;   // stores consumed (goods aren't conserved)
  ship[track] = Math.min(1, cond + mat / (perFull || 10));
}

/** A cautious captain lays in SPARE Wood & Fiber for at-sea jury-rigging — but only into hold space left
 *  after crew, guns, trade cargo, and working capital (never displacing the voyage), and only from the home
 *  port's own surplus above its reserve. A bold captain runs light and trusts to speed. Free (an operating
 *  cost, like arming); any spar not used at sea simply comes home again. Called last in loadForVoyage. */
export function stowRepairKit(world, home, ship) {
  const r = world.rules;
  if (!home || !home.stock) return;
  const bold = ship.captain && ship.captain.traits && ship.captain.traits.boldness;
  if ((bold != null ? bold : 0.5) >= (r.JURYRIG_CAUTION_TRAIT || 0.5)) return; // only the careful bother
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const batch = r.JURYRIG_KIT_BATCH || 6;
  for (const g of [goods.hull, goods.rig]) {
    const space = Math.max(0, ship.capacity - cargoUnits(ship, r.GOLD_PER_CARGO_UNIT));
    if (space < 1) break;
    const target = home.targets && home.targets[g] ? home.targets[g] : 0;
    const spare = Math.max(0, (home.stock[g] || 0) - target * (r.REPAIR_RESERVE || 0));
    const load = Math.min(batch, spare, space);
    if (load >= 1) transfer(home.stock, g, ship.cargo, g, load);
  }
}

/** Goods a ship can SPARE of one kind — what it carries above a reserve it keeps for its own needs.
 *  So a tapped-out friend genuinely can't help, and no one gives away the crew's last biscuit. */
export function spareAboard(ship, good, keep) {
  return Math.max(0, (ship.cargo[good] || 0) - (keep || 0));
}

/** RENDER AID at sea: a helper heaves-to alongside a stricken ship and hands over SPARE canvas, timber, and
 *  victuals — patching the victim's rig (to make sail again) and hull, and topping up its food + morale. Only
 *  spare goods change hands (spareAboard). The good deed is RECORDED ABOARD the helper (a pending rep bump)
 *  and paid out only when it next reaches home and reports — so goodwill travels by sea, never teleports. The
 *  captain earns seamanship + command for the seamanlike rescue. Returns true if any aid was actually given. */
export function renderAid(world, helper, victim) {
  const r = world.rules;
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  let helped = false;
  // Spare CANVAS → work the dismasted rig back to making sail.
  const fib = Math.min(r.RESCUE_FIBER_BATCH || 0, spareAboard(helper, goods.rig, r.RESCUE_KEEP_FIBER));
  if (fib >= 1 && (victim.rig != null ? victim.rig : 1) < 1) {
    helper.cargo[goods.rig] -= fib;
    victim.rig = Math.min(1, (victim.rig != null ? victim.rig : 1) + fib / (r.REPAIR_FIBER_PER_RIG || 8));
    helped = true;
  }
  // Spare TIMBER → shore up the battered hull.
  const wood = Math.min(r.RESCUE_WOOD_BATCH || 0, spareAboard(helper, goods.hull, r.RESCUE_KEEP_WOOD));
  if (wood >= 1 && (victim.hull != null ? victim.hull : 1) < 1) {
    helper.cargo[goods.hull] -= wood;
    victim.hull = Math.min(1, (victim.hull != null ? victim.hull : 1) + wood / (r.REPAIR_WOOD_PER_HULL || 10));
    helped = true;
  }
  // Spare VICTUALS → get the crew under way again and lift their spirits.
  const foodKeep = (r.CREW_FOOD_PER_DAY || 1) * (r.PROVISION_DAYS || 1);
  const food = Math.min(r.RESCUE_FOOD_BATCH || 0, spareAboard(helper, 'Food', foodKeep));
  if (food >= 1) {
    helper.cargo.Food -= food;
    victim.cargo.Food = (victim.cargo.Food || 0) + food;
    victim.morale = Math.min(1, (victim.morale != null ? victim.morale : 0.5) + 0.1);
    helped = true;
  }
  if (!helped) return false;
  awardSeamanshipXp(helper.captain, r.XP_RESCUE || 0);
  awardCommandXp(helper.captain, r.XP_RESCUE || 0);
  // Record the deed to be REPORTED at the next home dock (reputation lands at the quay, not mid-ocean).
  if (victim.homeId !== helper.homeId) {
    helper._aidDeeds = helper._aidDeeds || [];
    helper._aidDeeds.push({ otherHome: victim.homeId, day: Math.floor(world.simTime / (r.SIM_DAY_SECONDS || 60)) });
  }
  // A prolonged mercy — aiding the SAME stricken ship pass after pass — is ONE deed in the log, not
  // "hove to and aided her" ten times over. The aid still happens each pass (rep + patching above);
  // only the headline is deduped, per helper, until a different ship or a long spell resets it.
  const nowDay = Math.floor(world.simTime / (r.SIM_DAY_SECONDS || 60));
  const freshDeed = helper._aidId !== victim.id || (nowDay - (helper._aidDay != null ? helper._aidDay : -9999)) > (r.RESCUE_LOG_DAYS || 20);
  helper._aidId = victim.id; helper._aidDay = nowDay;
  if (freshDeed) logEvent(world, 'rescue', `${helper.name || 'A ship'} hove to and aided ${victim.name || 'a ship'}, sore stricken${helper.captain ? ` — Capt. ${helper.captain.name} shared canvas, timber, and victuals` : ''}.`, { x: victim.x, y: victim.y, shipId: helper.id });
  return true;
}

/** JURY-RIG at sea: a seamanlike captain slowly patches hull/rig from Wood/Fiber CARRIED ABOARD — the
 *  hold slots a cautious captain gives up to spare timber & canvas (stowRepairKit). No port, no coin —
 *  just the crew, their stores, and the captain's skill; enough to nurse a cripple toward port, not a
 *  full refit. This is what lets a dismasted or storm-battered ship claw its way home. */
export function juryRig(world, ship, h) {
  const r = world.rules;
  const days = h / (r.SIM_DAY_SECONDS || 60);
  const sea = skill01(ship.captain, r, 'sea');
  const rate = (r.JURYRIG_PER_DAY || 0) * (0.3 + sea) * days; // a master shipwright's hand mends faster
  if (rate <= 0) return;
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  mendFromHold(ship, 'hull', goods.hull, r.REPAIR_WOOD_PER_HULL, rate);
  mendFromHold(ship, 'rig', goods.rig, r.REPAIR_FIBER_PER_RIG, rate);
}
