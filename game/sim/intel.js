// intel.js — the generalized, ship-carried KNOWLEDGE layer. The sibling of beliefs.js.
//
// beliefs.js models imperfect PRICE knowledge (an island holds the last-heard mid for each
// good at each other port, refreshed only when a ship carries fresh observations). This
// extends that exact "information travels only by sea" principle to the OTHER things an
// island would otherwise magically know about distant ports:
//   • danger       — how pirate-HAUNTED a port's waters are (a raided route).
//   • haven        — whether a port has FALLEN to a pirate haven (raise the black flag).
//   • foodDays     — how STARVING it is (so an ally answers a famine it has actually HEARD of).
//   • civ          — how PROSPEROUS it is (so migrants follow prosperity they've actually heard of).
//   • lawlessness  — how disorderly it is (colour for a magistrate's opinion; UI).
// An island holds an `intel` book: the last thing it HEARD about each subject port, tagged
// with the sim-day it heard it. A ship holds the same book as its LOGBOOK. A ship OBSERVES a
// port's live facts firsthand when it docks and REPORTS its logbook to that port, so news of
// a fallen port or a raided lane spreads along shipping lanes and lags on the far side of the
// sea. Ships also SIGHT ports firsthand as they sail past (fresher than the home's orders).
//
// Deliberately FIRSTHAND, not transitive gossip — same reasoning as beliefs.js: letting a
// port re-spread everything it has ever heard saturates the whole map within days and the
// information friction (the entire point) vanishes. Carrying only what a ship has seen with
// its own eyes keeps knowledge geographic.
//
//   island.intel[subjectId] = { day, danger, haven, foodDays, lawless }
//   ship.intel[subjectId]   = { day, danger, haven, foodDays, lawless }   (its logbook)
// Both round-trip through serialize.js for free (they live on the island/ship objects). PURE.

import { currentDay } from './beliefs.js';
import { foodDays } from './island.js';
import { eachIslandInRange } from './grid.js';

/** The live, observable facts about a port — what a ship sees with its own eyes on arrival. */
export function liveFact(world, island, day) {
  return {
    day,
    danger: island.danger || 0,
    haven: !!island.haven,
    foodDays: foodDays(island, world.rules),
    civ: island.civ || 0,
    lawless: island.lawlessness || 0,
    festival: island.festival ? island.festival.until : 0, // a celebration in progress (its end-day) — carried home as a rumour
  };
}

/** Write a fact into a knowledge book, newest-wins (a fresher sighting supersedes an older one). */
function note(book, subjectId, fact) {
  const cur = book[subjectId];
  if (!cur || fact.day >= cur.day) book[subjectId] = fact;
}

/** Drop intel older than the forget horizon, and — the SCALING guard — if a book still holds
 *  more than INTEL_MAX_SUBJECTS ports, keep only the freshest (bounds per-island memory so the
 *  sim can reach ~1000 islands without every port remembering every other). */
function prune(world, book, day) {
  const t = world.rules;
  const forget = t.INTEL_FORGET_DAYS || 40;
  const cap = t.INTEL_MAX_SUBJECTS || 64;
  let ids = Object.keys(book);
  for (const id of ids) if (day - book[id].day > forget) delete book[id];
  ids = Object.keys(book);
  if (ids.length > cap) {
    ids.sort((a, b) => book[b].day - book[a].day); // freshest first
    for (const id of ids.slice(cap)) delete book[id];
  }
}

/** A ship docks at `port`: it OBSERVES the port's live facts firsthand, then hands the port its
 *  logbook — the firsthand sightings it has gathered elsewhere. Mirrors beliefs.observeAndGossip
 *  (called right beside it at the dock) but for FACTS rather than prices. */
export function observeFacts(world, port, ship) {
  const day = currentDay(world);
  if (!ship.intel) ship.intel = {};
  if (!port.intel) port.intel = {};

  // 1) OBSERVE — the ship sees this port's live facts with its own eyes (today).
  note(ship.intel, port.id, liveFact(world, port, day));

  // 2) REPORT — the port adopts the ship's firsthand sightings of everywhere it has been (it
  //    knows its OWN state live, so skip itself). Newer sighting wins.
  for (const id in ship.intel) {
    if (id === port.id) continue;
    note(port.intel, id, ship.intel[id]);
  }
  prune(world, port.intel, day);
}

/** While under sail, a ship SIGHTS any port within sight range and records its live facts
 *  firsthand — this is why a captain at sea holds fresher information than the home that gave
 *  the orders (it can see a port ablaze or flying the black flag as it passes). PURE. */
export function sightAtSea(world, ship) {
  const t = world.rules;
  const range = t.SIGHT_RANGE_AT_SEA || 700;
  const day = currentDay(world);
  if (!ship.intel) ship.intel = {};
  // Static island grid → only the ports within sight range are visited, not the whole roster.
  // Exact: same set as the full-scan distance filter; note() is newest-wins and every sighting
  // carries the same `day`, so visitation order is immaterial.
  eachIslandInRange(world, ship.x, ship.y, range, (isl) => note(ship.intel, isl.id, liveFact(world, isl, day)));
}

/** Believed pirate-danger of `subjectId`, as `island` understands it on `day`. Unknown → 0
 *  (no news is good news — you don't fear a lane you've heard nothing about). A known sighting
 *  DECAYS toward 0 as it ages (an old report of trouble fades — "that was a while back, likely
 *  cleared"), fully forgotten after INTEL_STALE_DAYS. Mirrors beliefs.beliefMid's decay. */
export function believedDanger(world, island, subjectId, day) {
  const rec = island.intel && island.intel[subjectId];
  if (!rec) return 0;
  const stale = world.rules.INTEL_STALE_DAYS || 12;
  const w = Math.min(1, Math.max(0, (day - rec.day) / stale));
  return (rec.danger || 0) * (1 - w);
}

/** Worst KNOWN danger along a planned route — the max believedDanger over its stops, as `home`
 *  understands them on `day`. Unknown ports contribute 0 (a captain can't prepare for peril nobody
 *  has spoken of), so this is how much fear a captain sails with. "Information travels by sea." */
export function routePeril(world, home, stops, day) {
  let d = 0;
  for (const s of (stops || [])) d = Math.max(d, believedDanger(world, home, s.islandId, day));
  return d;
}

/** Whether `island` BELIEVES `subjectId` has fallen to a pirate haven. A haven sighting is
 *  trusted until it goes stale (INTEL_HAVEN_FORGET days), after which the island discounts it —
 *  word that a port fell is old, and it may since have been redeemed. Unknown → false (a newly
 *  fallen port is NOT instantly shunned by the far side of the sea; a ship must carry the news). */
export function believedHaven(world, island, subjectId, day) {
  const rec = island.intel && island.intel[subjectId];
  if (!rec || !rec.haven) return false;
  const forget = world.rules.INTEL_HAVEN_FORGET || 25;
  return (day - rec.day) <= forget;
}

/** Whether `island` has heard `subjectId` is holding a FESTIVAL right now — a rumour a ship carried
 *  home (liveFact.festival = the celebration's end-day). Trusted until that end-day, then it's over.
 *  Unknown → false (a port only diverts to a feast it has had word of; no omniscience). */
export function believedFestival(world, island, subjectId, day) {
  const rec = island.intel && island.intel[subjectId];
  if (!rec || !rec.festival) return false;
  return day <= rec.festival;
}

/** Believed food-security (in days) of `subjectId`. Unknown → a large safe number: an island
 *  can't answer a famine it hasn't heard of. A known-low reading blends UP toward "probably
 *  recovered" as it ages, so stale famine news doesn't trigger endless aid. */
export function believedFoodDays(world, island, subjectId, day) {
  const rec = island.intel && island.intel[subjectId];
  if (!rec) return 999;
  const stale = world.rules.INTEL_STALE_DAYS || 12;
  const safe = (world.rules.FOOD_SECURITY_DAYS || 2) * 2;
  const w = Math.min(1, Math.max(0, (day - rec.day) / stale));
  return (rec.foodDays != null ? rec.foodDays : safe) * (1 - w) + safe * w;
}

/** Believed PROSPERITY (civ, 0..1) of `subjectId`, as `island` understands it. This is what makes
 *  migration follow REPORTED prosperity, not omniscient truth: people flock to a port they have
 *  heard is thriving. Unknown → a neutral prior (you don't flock to a place nobody speaks of, but a
 *  desperate refugee will still try it over a failing home). A known reading blends toward that
 *  neutral prior as it ages — yesterday's boom town may since have foundered. */
export function believedCiv(world, island, subjectId, day) {
  const prior = world.rules.INTEL_CIV_PRIOR != null ? world.rules.INTEL_CIV_PRIOR : 0.3;
  const rec = island.intel && island.intel[subjectId];
  if (!rec) return prior;
  const stale = world.rules.INTEL_STALE_DAYS || 12;
  const w = Math.min(1, Math.max(0, (day - rec.day) / stale));
  return (rec.civ != null ? rec.civ : prior) * (1 - w) + prior * w;
}

/** Compact per-island intel summary for the UI: how many other ports this island holds any
 *  read on, and how many are fresh (younger than half INTEL_STALE_DAYS). */
export function factSummary(world, island, day) {
  const stale = world.rules.INTEL_STALE_DAYS || 12;
  let known = 0, fresh = 0;
  const b = island.intel || {};
  for (const id in b) { known++; if (day - b[id].day < stale / 2) fresh++; }
  return { known, fresh };
}
