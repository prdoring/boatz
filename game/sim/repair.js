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
import { logEvent, logEventThrottled, maybeSink } from './events.js';

/** Give a fresh hull full condition (called from createShip). hullSound/rigSound are the STRUCTURAL
 *  ceilings the working hull/rig can be nursed back up to at sea; they erode with damage and only a real
 *  dry-dock rebuilds them (see damageHull/juryRig/repairAtPort). */
export function initCondition(ship) {
  ship.hull = 1;
  ship.rig = 1;
  ship.hullSound = 1;
  ship.rigSound = 1;
}

/** The structural-soundness CEILING of a track ('hull'/'rig'), defaulting to 1 for old saves / raw test
 *  ships that never carried the field — the load-bearing NaN guard for every soundness read. */
function soundOf(ship, track) {
  const v = ship[track + 'Sound'];
  return v != null ? v : 1;
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

/** Erode a track's structural SOUNDNESS by a fraction of the hull/rig actually lost — permanent harm only
 *  a dry-dock undoes — floored so a jury-rigged hull stays seaworthy. `applied` is the armour-divided delta. */
function wearSoundness(ship, track, applied, rules) {
  const wear = (track === 'hull'
    ? (rules.SOUNDNESS_WEAR_HULL != null ? rules.SOUNDNESS_WEAR_HULL : 0.3)
    : (rules.SOUNDNESS_WEAR_RIG != null ? rules.SOUNDNESS_WEAR_RIG : 0.2));
  const floor = rules.SOUNDNESS_FLOOR != null ? rules.SOUNDNESS_FLOOR : 0.45;
  ship[track + 'Sound'] = Math.max(floor, soundOf(ship, track) - wear * Math.max(0, applied));
}

/** Apply hull damage (armour-divided), clamped to [0,1]; a fraction erodes structural soundness. Returns hull. */
export function damageHull(ship, amt, rules) {
  if (ship.hull == null) ship.hull = 1;
  const before = ship.hull;
  ship.hull = Math.max(0, before - Math.max(0, amt) / armorOf(ship, rules));
  wearSoundness(ship, 'hull', before - ship.hull, rules);
  if (ship.hull > ship.hullSound) ship.hull = ship.hullSound; // invariant hull <= hullSound (belt-and-braces)
  return ship.hull;
}

/** Apply rigging damage (armour-divided), clamped to [0,1]; a fraction erodes structural soundness. Returns rig. */
export function damageRig(ship, amt, rules) {
  if (ship.rig == null) ship.rig = 1;
  const before = ship.rig;
  ship.rig = Math.max(0, before - Math.max(0, amt) / armorOf(ship, rules));
  wearSoundness(ship, 'rig', before - ship.rig, rules);
  if (ship.rig > ship.rigSound) ship.rig = ship.rigSound;
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
  const ceil = soundOf(ship, track);                    // can't mend the working track above its structural soundness
  const missing = ceil - cond;                          // (a foreign yard patches to soundness; only a dry-dock raised it)
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
  ship[track] = Math.min(ceil, cond + gained);
  return gained;
}

/** Refit a docked ship — mend hull (Wood) then rig (Fiber), each up to a per-dock cap widened by the
 *  captain's SEAMANSHIP. Called wherever provisionCrew is (departure, each dock, safe harbour, home). */
export function repairAtPort(world, island, ship) {
  const r = world.rules;
  if (!island || !island.stock) return;
  if (ship.hull == null) ship.hull = 1;
  if (ship.rig == null) ship.rig = 1;
  if (ship.hullSound == null) ship.hullSound = 1;
  if (ship.rigSound == null) ship.rigSound = 1;
  // A ship's own faction mends her free: a home port her merchants, a HAVEN its rogues (the den's
  // shipwrights). A foreign yard sells timber & canvas at ask like any other good.
  const atHome = island.id === ship.homeId || (island.haven && ship.pirate);
  const skill = skill01(ship.captain, r, 'sea');
  const cap = (r.REPAIR_PER_DOCK || 0.6) * (1 + (r.REPAIR_SKILL_BONUS || 0) * skill);
  // A REAL DRY-DOCK (home port / own haven) rebuilds structural SOUNDNESS toward whole — re-planking a
  // ship a jury-rig or a foreign yard never could. Done BEFORE mending so the working track can then be
  // filled to the raised ceiling. A foreign yard leaves soundness untouched (it only patches to it).
  if (atHome) {
    const restore = (r.SOUNDNESS_REFIT_PER_DOCK || 0.25) * (1 + (r.REPAIR_SKILL_BONUS || 0) * skill);
    ship.hullSound = Math.min(1, ship.hullSound + restore);
    ship.rigSound = Math.min(1, ship.rigSound + restore);
  }
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const hull0 = ship.hull;
  mendTrack(world, island, ship, 'hull', goods.hull, r.REPAIR_WOOD_PER_HULL, cap, atHome);
  mendTrack(world, island, ship, 'rig', goods.rig, r.REPAIR_FIBER_PER_RIG, cap, atHome);
  if (hull0 < 0.5 && ship.hull - hull0 > 0.2) // a real refit of a battered hull — a quiet good-news beat
    logEventThrottled(world, 'refit', r.SIM_DAY_SECONDS,
      `${ship.name || 'A battered ship'} was refitted at ${island.name}.`, { islandId: island.id, shipId: ship.id });
}

/** Mend one track from an ISLAND's stock, up to `ceil`, by at most `rate` condition. */
function mendFromStock(island, ship, track, good, perFull, rate, ceil) {
  const cond = ship[track] != null ? ship[track] : 1;
  const room = ceil - cond;
  if (room < 1e-6 || rate <= 0) return;
  const want = Math.min(room, rate);
  const mat = Math.min(want * (perFull || 10), island.stock[good] || 0);
  if (mat < 1e-9) return;
  island.stock[good] = Math.max(0, (island.stock[good] || 0) - mat);   // the den/port spends its own timber
  ship[track] = Math.min(ceil, cond + mat / (perFull || 10));
}

/** GRADUAL dry-dock — a pirate HAVEN mends its raiders (or a guard port its privateers) a small step EACH
 *  TICK while they lie in its roads, from its own Wood/Fiber, paced by `dDay` (like the food resupply) and
 *  capped by structural soundness (which, as a real dry-dock, it also slowly rebuilds). Unlike repairAtPort's
 *  per-dock CHUNK, this mends SMOOTHLY over a day or two — no instant full-heal jump on a ship that never
 *  visibly stopped. Free to its own; called every substep the ship is in range (the caller gates on combat). */
export function refitGradual(world, island, ship, dDay) {
  const r = world.rules;
  if (!island || !island.stock) return;
  if (ship.hull == null) ship.hull = 1;
  if (ship.rig == null) ship.rig = 1;
  if (ship.hullSound == null) ship.hullSound = 1;
  if (ship.rigSound == null) ship.rigSound = 1;
  const skill = skill01(ship.captain, r, 'sea');
  const rate = (r.HAVEN_MEND_PER_DAY != null ? r.HAVEN_MEND_PER_DAY : 0.6) * (1 + (r.REPAIR_SKILL_BONUS || 0) * skill) * dDay;
  if (rate <= 0) return;
  // Rebuild structural soundness slowly (a real dry-dock), then mend the working track up to it.
  const srate = (r.SOUNDNESS_REFIT_PER_DAY != null ? r.SOUNDNESS_REFIT_PER_DAY : 0.35) * dDay;
  ship.hullSound = Math.min(1, ship.hullSound + srate);
  ship.rigSound = Math.min(1, ship.rigSound + srate);
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const hull0 = ship.hull;
  mendFromStock(island, ship, 'hull', goods.hull, r.REPAIR_WOOD_PER_HULL, rate, ship.hullSound);
  mendFromStock(island, ship, 'rig', goods.rig, r.REPAIR_FIBER_PER_RIG, rate, ship.rigSound);
  if (hull0 < 0.5 && ship.hull >= 0.7 && hull0 < ship.hull) // crossed back to seaworthy — a quiet good-news beat, once
    logEventThrottled(world, 'refit', r.SIM_DAY_SECONDS,
      `${ship.name || 'A battered ship'} was refitted at ${island.name}.`, { islandId: island.id, shipId: ship.id });
}

/** Mend one track AT SEA from a good CARRIED ABOARD (no port, no purchase) — `rate` is the condition
 *  restorable this tick; `ceil` is the hard ceiling a jury-rig can reach (min of structural soundness and
 *  the track's JURYRIG_REACH). A field patch can never exceed it — that's what keeps a real dry-dock worth
 *  seeking. */
function mendFromHold(ship, track, good, perFull, rate, ceil) {
  const cond = ship[track] != null ? ship[track] : 1;
  const room = ceil - cond;
  if (room < 0.005 || rate <= 0) return;
  const want = Math.min(room, rate);
  const mat = Math.min(want * (perFull || 10), ship.cargo[good] || 0);
  if (mat < 1e-9) return; // any positive mend applies — jury-rig is called PER SUBSTEP, so it must accumulate small gains (not be rejected as "too tiny" each tick)
  ship.cargo[good] = (ship.cargo[good] || 0) - mat;   // stores consumed (goods aren't conserved)
  ship[track] = Math.min(ceil, cond + mat / (perFull || 10));
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
  const gpu = r.GOLD_PER_CARGO_UNIT;
  let helped = false;
  // Hand SPARE canvas, timber & victuals into the victim's OWN HOLD — she MENDS HERSELF with them over the
  // following days (juryRig, in ship.js), rather than being patched whole on the spot: a rescued ship
  // recovers GRADUALLY at her own hands. Only spare goods change hands (spareAboard), and only what fits.
  const give = (good, batch, keep) => {
    const amt = Math.min(batch || 0, spareAboard(helper, good, keep || 0), Math.max(0, victim.capacity - cargoUnits(victim, gpu)));
    if (amt < 1) return false;
    helper.cargo[good] = (helper.cargo[good] || 0) - amt;
    victim.cargo[good] = (victim.cargo[good] || 0) + amt;
    return true;
  };
  // CANVAS → so she can jury-rig her dismasted rig back and make sail; TIMBER → to shore up a holed hull.
  if ((victim.rig != null ? victim.rig : 1) < soundOf(victim, 'rig') && give(goods.rig, r.RESCUE_FIBER_BATCH, r.RESCUE_KEEP_FIBER)) helped = true;
  if ((victim.hull != null ? victim.hull : 1) < soundOf(victim, 'hull') && give(goods.hull, r.RESCUE_WOOD_BATCH, r.RESCUE_KEEP_WOOD)) helped = true;
  // VICTUALS → the crew eats at once and takes heart (food is consumed, not a repair material).
  const foodKeep = (r.CREW_FOOD_PER_DAY || 1) * (r.PROVISION_DAYS || 1);
  if (give('Food', r.RESCUE_FOOD_BATCH, foodKeep)) { victim.morale = Math.min(1, (victim.morale != null ? victim.morale : 0.5) + 0.1); helped = true; }
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
export function juryRig(world, ship, h, mult = 1) {
  const r = world.rules;
  const days = h / (r.SIM_DAY_SECONDS || 60);
  const sea = skill01(ship.captain, r, 'sea');
  const rate = (r.JURYRIG_PER_DAY || 0) * (0.3 + sea) * days * mult; // a master shipwright's hand mends faster; mult>1 when hove-to
  if (rate <= 0) return;
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  // The ceiling a field patch can reach: the track's structural soundness, but never above its JURYRIG_REACH
  // (rig is more jury-riggable than hull — a raider mends its sails to run further than it mends its frame).
  const hullCeil = Math.min(soundOf(ship, 'hull'), r.JURYRIG_REACH_HULL != null ? r.JURYRIG_REACH_HULL : 0.55);
  const rigCeil = Math.min(soundOf(ship, 'rig'), r.JURYRIG_REACH_RIG != null ? r.JURYRIG_REACH_RIG : 0.75);
  mendFromHold(ship, 'hull', goods.hull, r.REPAIR_WOOD_PER_HULL, rate, hullCeil);
  mendFromHold(ship, 'rig', goods.rig, r.REPAIR_FIBER_PER_RIG, rate, rigCeil);
}

/** Does a jury-rig still have room to lift a track (soundness/REACH ceiling above current condition)? */
function juryHelps(ship, r) {
  const hullCeil = Math.min(soundOf(ship, 'hull'), r.JURYRIG_REACH_HULL != null ? r.JURYRIG_REACH_HULL : 0.55);
  const rigCeil = Math.min(soundOf(ship, 'rig'), r.JURYRIG_REACH_RIG != null ? r.JURYRIG_REACH_RIG : 0.75);
  return (ship.hull != null ? ship.hull : 1) < hullCeil - 0.005 || (ship.rig != null ? ship.rig : 1) < rigCeil - 0.005;
}

/** HEAVE TO and jury-rig (pirates & privateers, driven from their sim loops). A crippled hull with repair
 *  timber aboard and no dry-dock in reach lies-to DEAD IN THE WATER and patches itself at JURYRIG_HEAVE_MULT
 *  the passive rate — COMMITTED for HEAVE_COMMIT_SECONDS (`_heaveUntil`): a real "repair vs. run" decision,
 *  and the latch keeps the sim substep-exact (the move/no-move choice can't flip mid-step) and steadies the
 *  careen art. It does NOT move the ship, but IS catchable — a modest founder/exposure check runs so a leaky
 *  hull isn't safest sitting still. Returns true if hove-to THIS tick (the caller then skips its own move and
 *  checks `ship._sunk`). Kit runs dry → it breaks off. `setAct` is inlined to avoid a repair.js→piracy.js
 *  import cycle. */
export function maybeHeaveToRepair(world, ship, h) {
  const r = world.rules;
  const latched = world.simTime < (ship._heaveUntil || 0);
  const goods = r.REPAIR_GOODS || { hull: 'Wood', rig: 'Fiber' };
  const kitMin = r.HEAVE_KIT_MIN || 3;
  const hasKit = (ship.cargo[goods.hull] || 0) >= kitMin || (ship.cargo[goods.rig] || 0) >= kitMin;
  if (latched && !hasKit) { ship._heaveUntil = 0; return false; }           // ran out of timber mid-repair — break off
  if (!latched && !(hasKit && juryHelps(ship, r))) return false;            // nothing to gain (or no kit) — don't heave to
  if (!latched) {
    ship._heaveUntil = world.simTime + (r.HEAVE_COMMIT_SECONDS || 24);
    // Log the careen beat ONCE per episode via a PER-SHIP gate (logEventThrottled is global-per-kind and
    // would mute every other ship's careen). tier:'log' keeps it in the ship's Story tab, off the crawl.
    const day = r.SIM_DAY_SECONDS || 60;
    if (world.simTime - (ship._careenLoggedAt != null ? ship._careenLoggedAt : -1e9) > day) {
      ship._careenLoggedAt = world.simTime;
      logEvent(world, 'careen', `${ship.name || 'A ship'} hove to and jury-rigged her hull and rigging.`,
        { shipId: ship.id, tier: 'log', x: ship.x, y: ship.y });
    }
  }
  if (!ship._act) ship._act = { k: 'careen', id: null };                    // inline setAct (no piracy.js import → no cycle)
  else { ship._act.k = 'careen'; ship._act.id = null; }
  juryRig(world, ship, h, r.JURYRIG_HEAVE_MULT || 2.5);
  // Dead in the water is not safe: a modest founder check, so heaving-to in a swell with a holed hull
  // still carries risk (CAREEN_FOUNDER_MULT scales a normal sailing tick's exposure).
  maybeSink(world, ship, (ship.speed || r.SHIP_SPEED || 0) * h * (r.CAREEN_FOUNDER_MULT != null ? r.CAREEN_FOUNDER_MULT : 1));
  return true;
}
