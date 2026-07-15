// World dynamics — SEASONS + named STORMS + seasonal TRADE WINDS. The sky over the sandbox has
// a rhythm and a temper: a turning year that swells and starves the harvest and sets the sea's
// mood, and named tempests that wander the map and send ships to the bottom. Deterministic
// (seeded 'weather' stream), serialisable (world.season + world.storms are plain data). PURE.
//
//   • SEASONS cycle Spring→Summer→Autumn→Winter every SEASON_DAYS. Each sets a production
//     multiplier (a bumper autumn harvest; a lean winter), how stormy the sea is, and the
//     PREVAILING WIND — the trade winds that wind.js eases the global vector toward, so the
//     sea has a seasonal set to it that a captain can plan around.
//   • STORMS spawn (more often in autumn/winter), drift across the map, and dissipate. A ship
//     caught inside one risks foundering — a named, watchable hazard ("lost to Storm Cyrus").

import { streamFloat } from './rng.js';
import { logEvent } from './events.js';
import { skill01, awardSeamanshipXp } from './captains.js';
import { damageHull, damageRig, hullRisk } from './repair.js';

const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function initWeather(world) {
  const t = world.rules;
  const seasons = t.SEASONS || [];
  world.season = { idx: 0, name: seasons.length ? seasons[0].name : 'Summer', day: 0 };
  world.storms = [];
  world._weatherDay = -1;
  applySeason(world); // set per-island production + prevailing wind for the opening season
}

/** The prevailing wind the trade winds set toward this season — read by wind.js's rollTarget. */
export function prevailingWind(world) {
  const s = seasonSpec(world);
  return s ? { dir: s.windDir, str: s.windStr } : null;
}

function seasonSpec(world) {
  const seasons = world.rules.SEASONS;
  if (!world.season || !seasons || !seasons.length) return null;
  return seasons[world.season.idx % seasons.length];
}

/** Set each island's seasonal production multiplier (food staples swing hardest with the year). */
function applySeason(world) {
  const t = world.rules, s = seasonSpec(world);
  if (!s) return;
  const foodRaws = t.FOOD_RAWS || [];
  for (const isl of world.islands) {
    isl._prodMult = foodRaws.includes(isl.primary) ? s.food : s.prod;
  }
}

export function weather(world, h) {
  const t = world.rules;
  const daySec = t.SIM_DAY_SECONDS;

  // Advance the season on a day boundary.
  const day = Math.floor(world.simTime / daySec);
  if (day !== world._weatherDay) {
    world._weatherDay = day;
    const seasons = t.SEASONS || [];
    if (seasons.length) {
      const idx = Math.floor(day / t.SEASON_DAYS) % seasons.length;
      if (idx !== world.season.idx) {
        world.season = { idx, name: seasons[idx].name, day };
        applySeason(world);
        logEvent(world, 'season', `The season turns to ${seasons[idx].name}.`, {});
      }
    }
    maybeSpawnStorm(world);
  }

  // Drift + age every storm (per substep, so motion is identical at any fast-forward).
  if (world.storms && world.storms.length) {
    const days = h / daySec;
    for (const st of world.storms) {
      st.x += st.vx * h; st.y += st.vy * h;
      st.life -= days;
    }
    // Bounce storms that wander off the map so they linger over the sea rather than vanish instantly.
    for (const st of world.storms) {
      if (st.x < 0 || st.x > world.mapW) st.vx *= -1;
      if (st.y < 0 || st.y > world.mapH) st.vy *= -1;
      st.x = Math.max(0, Math.min(world.mapW, st.x));
      st.y = Math.max(0, Math.min(world.mapH, st.y));
    }
    world.storms = world.storms.filter((s) => s.life > 0);

    // Ships caught inside a storm are BATTERED — hull & rig ground down (a master mariner shelters most
    // of it), the worst hulls thrown down outright, and a poor navigator blown off course. The deadly,
    // watchable part — but now a ship usually LIMPS OUT crippled and seeking repair, not simply vanishing.
    if (world.storms.length) {
      let sunk = false;
      const days = h / daySec;
      for (const ship of world.ships) {
        if (ship._sunk) continue;
        const st = stormOver(world, ship.x, ship.y);
        if (!st) continue;
        if (stormBatter(world, ship, st, days)) sunk = true;
      }
      if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
    }
  }
}

/** A storm batters a ship each substep it spends inside one: hull & rig ground down by the tempest (a
 *  captain's SEAMANSHIP shelters much of it), a rare chance the worst hulls are thrown down outright, and
 *  a chance a poor navigator loses the bearings and is blown ADRIFT. Weathering it earns seamanship.
 *  Returns true if the ship foundered. */
function stormBatter(world, ship, st, days) {
  const t = world.rules;
  const sea = skill01(ship.captain, t, 'sea');   // a master mariner rides out a blow
  const shelter = 1 - 0.6 * sea;                  // seamanship absorbs up to ~60% of the battering
  damageHull(ship, (t.STORM_HULL_DMG_PER_DAY || 0) * st.intensity * days * shelter, t);
  damageRig(ship, (t.STORM_RIG_DMG_PER_DAY || 0) * st.intensity * days * shelter, t);
  awardSeamanshipXp(ship.captain, (t.XP_STORM || 0) * st.intensity * days); // hard-won weather sense
  // FOUNDER — a hull beaten to nothing, or a rare catastrophic knockdown (worse for an already-leaky hull).
  const knockdown = (t.STORM_SINK_PER_DAY || 0) * st.intensity * days * hullRisk(ship, t);
  if (ship.hull <= 0 || streamFloat(world, 'weather') < knockdown) {
    ship._sunk = true;
    const who = ship.captain ? ` under Capt. ${ship.captain.name}` : '';
    logEvent(world, 'stormloss', `${ship.name || 'A ship'}${who} was lost with all hands to Storm ${st.name}.`, { x: ship.x, y: ship.y, shipId: ship.id });
    return true;
  }
  // BLOWN OFF COURSE — low seamanship loses the bearings (a distress state: wanders, eats, easy prey).
  // Only merchants carry the drifting-voyage machine (ship.js); pirates/privateers ride the storm out.
  if (!ship.adrift && !ship.pirate && !ship.privateer) {
    const lostP = (t.STORM_LOST_CHANCE || 0) * st.intensity * days * (1 - sea);
    if (streamFloat(world, 'weather') < lostP) {
      ship.adrift = { since: world.simTime };
      const who = ship.captain ? ` under Capt. ${ship.captain.name}` : '';
      logEvent(world, 'adrift', `${ship.name || 'A ship'}${who} was blown off course by Storm ${st.name} — adrift, with no bearings.`, { x: ship.x, y: ship.y, shipId: ship.id });
    }
  }
  return false;
}

/** The storm covering a point (with a 0..1 intensity that falls off toward the edge), or null. */
export function stormOver(world, x, y) {
  if (!world.storms) return null;
  for (const st of world.storms) {
    const d = Math.hypot(st.x - x, st.y - y);
    if (d < st.r) return { ...st, intensity: 1 - d / st.r };
  }
  return null;
}

function maybeSpawnStorm(world) {
  const t = world.rules;
  const s = seasonSpec(world);
  if (!s || !t.STORM_NAMES || !t.STORM_NAMES.length) return;
  if ((world.storms.length || 0) >= t.STORM_MAX) return;
  const rate = t.STORM_BASE_RATE * (s.stormRate || 1); // storms/day this season
  if (streamFloat(world, 'weather') >= Math.min(0.95, rate)) return;

  // Born at a random spot, drifting broadly with the prevailing wind.
  const x = streamFloat(world, 'weather') * world.mapW;
  const y = streamFloat(world, 'weather') * world.mapH;
  const drift = s.windDir + (streamFloat(world, 'weather') - 0.5) * 1.2;
  const r = t.STORM_RADIUS_MIN + streamFloat(world, 'weather') * (t.STORM_RADIUS_MAX - t.STORM_RADIUS_MIN);
  const life = t.STORM_LIFE_DAYS * (0.6 + 0.8 * streamFloat(world, 'weather'));
  const name = t.STORM_NAMES[Math.floor(streamFloat(world, 'weather') * t.STORM_NAMES.length) % t.STORM_NAMES.length];
  const id = 'st' + (world._stormSeq = (world._stormSeq || 0) + 1);
  world.storms.push({ id, name, x, y, r, life, vx: Math.cos(drift) * t.STORM_SPEED, vy: Math.sin(drift) * t.STORM_SPEED });
  logEvent(world, 'storm', `Storm ${name} is building over the ${compass(x, y, world)} seas.`, { x, y });
}

function compass(x, y, world) {
  const ns = y < world.mapH / 3 ? 'northern' : y > world.mapH * 2 / 3 ? 'southern' : 'central';
  const ew = x < world.mapW / 3 ? 'western' : x > world.mapW * 2 / 3 ? 'eastern' : '';
  return (ns + (ew ? ' ' + ew : '')).trim();
}
