// Captains — every ship is run by a named captain with a PERSONALITY who earns experience by
// completing voyages. Experience becomes SKILL (0..1): a better sailor sheds more of the
// headwind penalty by tacking (wind.js), earns a small seamanship bonus, and knows when to
// wait out a foul wind (ship.js). Personality is three traits that shape WHAT they choose to
// do (goals.js / ship.js):
//   boldness   — risk appetite: ranges farther for a trade, sails into worse odds, rarely dawdles.
//   wanderlust — exploration drive: scouts sooner, farther, and more of the map.
//   greed      — profit focus: holds out for fat margins instead of shuttling pennies.
// Two captains of equal skill can therefore run their ships very differently. Names, traits,
// and progression are deterministic (seeded 'captain' stream) and live on the ship, so they
// serialise for free. PURE.

import { streamFloat } from './rng.js';

// Deterministically-composed captain names — a given/epithet surname with the odd nickname.
const FIRST = [
  'Bartholomew', 'Anne', 'Edward', 'Mary', 'Henry', 'Jack', 'Grace', 'Samuel', 'Eliza',
  'Roderick', 'Isabel', 'Cutler', 'Morgan', 'Selby', 'Oona', 'Diego', 'Fen', 'Cormac',
  'Halvard', 'Nadia', 'Tobias', 'Wren', 'Amara', 'Lorcan', 'Sim', 'Petra', 'Osric', 'Yara',
];
const SUR = [
  'Blackwood', 'Ironside', 'Vane', 'Roberts', 'Bonny', 'Teague', 'Kidd', 'Sharpe', 'Thorne',
  'Doubloon', 'Marlowe', 'Ashgrave', 'Quill', 'Storm', 'Bellweather', 'Crane', 'Voss',
  'Hollick', 'Dunmore', 'Salt', 'Redfern', 'Copperhand', 'Yarrow', 'Finch', 'Mercer',
];
const EPITHET = [
  'the Bold', 'the Shrewd', 'Redhand', 'the Patient', 'Stormborn', 'the Lucky', 'Ironwill',
  'the Quiet', 'Longreach', 'the Fair',
];

// Rank tiers by lifetime XP (low → high). The last whose threshold is met wins. Spaced so a
// captain climbs through most of the ladder over a long session rather than maxing out in days.
const RANKS = [
  [0, 'Novice'], [100, 'Journeyman'], [280, 'Seasoned'], [620, 'Veteran'], [1300, 'Master'], [2600, 'Legendary'],
];

function pick(list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; }

// Bias a uniform roll toward the middle (average of two rolls ~ triangular), so most captains
// are moderate and the extremes (very bold / timid etc.) are rarer and more characterful.
function trait(world) { return (streamFloat(world, 'captain') + streamFloat(world, 'captain')) / 2; }

/** A one-word personality from the most pronounced trait (else "Steady"). */
export function personalityOf(traits) {
  const items = [['boldness', traits.boldness], ['wanderlust', traits.wanderlust], ['greed', traits.greed]];
  let key = null, dev = 0.14, sign = 0;
  for (const [k, v] of items) { const d = Math.abs(v - 0.5); if (d > dev) { dev = d; key = k; sign = v >= 0.5 ? 1 : -1; } }
  if (!key) return 'Steady';
  return { boldness: sign > 0 ? 'Bold' : 'Cautious', wanderlust: sign > 0 ? 'Wanderer' : 'Homebody', greed: sign > 0 ? 'Shrewd' : 'Easygoing' }[key];
}

/** A fresh captain with a seeded name, personality, and zero experience. */
export function makeCaptain(world) {
  const f = pick(FIRST, streamFloat(world, 'captain'));
  const s = pick(SUR, streamFloat(world, 'captain'));
  const name = streamFloat(world, 'captain') < 0.22
    ? `${f} ${pick(EPITHET, streamFloat(world, 'captain'))}`
    : `${f} ${s}`;
  const traits = { boldness: trait(world), wanderlust: trait(world), greed: trait(world) };
  // A single seed int the client expands into a head-and-shoulders portrait (PortraitRenderer).
  const portrait = Math.floor(streamFloat(world, 'captain') * 0x7fffffff) >>> 0;
  return { name, xp: 0, traits, personality: personalityOf(traits), portrait };
}

const T = (c) => (c && c.traits) || { boldness: 0.5, wanderlust: 0.5, greed: 0.5 };

/** Decision knobs derived from a captain's personality, read by goals.js/ship.js:
 *   travelMult — how heavily travel distance counts against a trade (bold/wandering → less → range farther)
 *   profitMult — the min-profit bar as a fraction of the base (greedy → higher → skips penny trades)
 *   scoutStale — days of staleness before a port is worth scouting (wanderlust → lower → scouts sooner)
 *   scoutStops — how many ports a recon visits (wanderlust → more)
 *   patient    — whether this captain will ever hold in port for wind (bold captains won't) */
export function navProfile(captain, rules) {
  const t = T(captain);
  return {
    travelMult: Math.max(0.2, 1 - (t.boldness * 0.6 + t.wanderlust * 0.4) * rules.TRAIT_TRAVEL_RANGE),
    profitMult: 0.4 + t.greed * rules.TRAIT_PROFIT_RANGE,
    scoutStale: rules.SCOUT_MIN_STALE_DAYS * (1 - t.wanderlust * rules.TRAIT_SCOUT_RANGE),
    scoutStops: Math.max(1, Math.round(rules.SCOUT_STOPS * (0.5 + t.wanderlust))),
    patient: t.boldness < rules.BOLD_WAIT_MAX,
  };
}

/** Skill 0..1 from experience — steep early, asymptotic to 1 (diminishing returns). */
export function skill01(captain, rules) {
  if (!captain) return 0;
  return 1 - Math.exp(-(captain.xp || 0) / rules.XP_SCALE);
}

/** Rank label for the captain's current experience. */
export function rankOf(captain) {
  const xp = (captain && captain.xp) || 0;
  let label = RANKS[0][1];
  for (const [min, name] of RANKS) if (xp >= min) label = name;
  return label;
}

/** Award experience for a completed voyage — a flat run reward plus a bonus per extra hop
 *  (multi-stop routes are harder to run well). */
export function awardVoyageXp(captain, rules, stops) {
  if (!captain) return;
  captain.xp = (captain.xp || 0) + rules.XP_PER_RUN * (1 + rules.XP_STOP_BONUS * Math.max(0, stops - 1));
}
