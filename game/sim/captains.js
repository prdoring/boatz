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
import { GIVEN, SURNAME, EPITHET, pick, composeUniqueName } from './names.js';

// Captain names — a given + family name, or a given + pirate byname — from the shared person-name
// pools in names.js, preferring a name no captain currently afloat already bears (see makeCaptain).

/** Names borne by captains of ships currently afloat — the set a fresh captain prefers to dodge. */
function livingCaptainNames(world) {
  const set = new Set();
  const ships = world && world.ships;
  if (ships) for (const s of ships) if (s.captain && s.captain.name) set.add(s.captain.name);
  return set;
}

// Rank tiers by lifetime XP (low → high). The last whose threshold is met wins. Spaced so a
// captain climbs through most of the ladder over a long session rather than maxing out in days.
const RANKS = [
  [0, 'Novice'], [100, 'Journeyman'], [280, 'Seasoned'], [620, 'Veteran'], [1300, 'Master'], [2600, 'Legendary'],
];

/** A stable "writing-voice" seed for a person, derived (RNG-FREE) from their already-drawn portrait
 *  seed — so it consumes no RNG stream (determinism-safe: adds no draw to perturb seeded runs) yet
 *  varies per person and decorrelates from the portrait. The CLIENT maps this opaque seed onto its
 *  loaded style catalogue (seed % N) so each keeper's log reads in a distinct hand; the sim never
 *  needs to know the catalogue, exactly mirroring how `portrait` is an opaque seed the client expands. */
export function voiceSeedFrom(portrait) {
  let x = ((portrait >>> 0) ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

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

/** A pirate captain — an epithet name ("Cormac Redhand"), bold and greedy, and already blooded
 *  (some starting experience). The kind who takes a ship by force and sails it under the black flag.
 *  `taken` (optional) is a caller-owned set of names to avoid + extend for batch naming at genesis;
 *  omit it and the avoid-set is derived from captains currently afloat. */
export function makePirateCaptain(world, taken) {
  const avoid = taken || livingCaptainNames(world);
  const name = composeUniqueName(
    () => `${pick(GIVEN, streamFloat(world, 'captain'))} ${pick(EPITHET, streamFloat(world, 'captain'))}`,
    avoid,
  );
  const traits = { boldness: 0.7 + 0.3 * streamFloat(world, 'captain'), wanderlust: trait(world), greed: 0.6 + 0.4 * streamFloat(world, 'captain') };
  const portrait = Math.floor(streamFloat(world, 'captain') * 0x7fffffff) >>> 0;
  const s = Math.floor(180 + streamFloat(world, 'captain') * 420); // already blooded — starts every facet equal
  return { name, xp: { sea: s, gun: s, cmd: s }, traits, personality: personalityOf(traits), portrait, voiceSeed: voiceSeedFrom(portrait) };
}

/** An HONEST captain who leads his OWN crew into piracy — the same man, harder now. He keeps his name,
 *  portrait, and voiceSeed (so the ship's log stays in his hand, an unbroken fall from trade to the black
 *  flag), but leans into boldness + greed and is blooded for the fight ahead, so a merchant master makes a
 *  credible raider. No RNG draw — determinism-neutral, mutating the captain in place. */
export function hardenToPirate(captain) {
  if (!captain) return captain;
  const tr = captain.traits || (captain.traits = { boldness: 0.5, wanderlust: 0.5, greed: 0.5 });
  tr.boldness = Math.max(tr.boldness, 0.7);
  tr.greed = Math.max(tr.greed, 0.6);
  captain.personality = personalityOf(tr);
  const xp = captain.xp && typeof captain.xp === 'object' ? captain.xp : (captain.xp = { sea: 0, gun: 0, cmd: 0 });
  xp.gun = Math.max(xp.gun || 0, 180);  // a hard first season under the black flag — enough to fight
  xp.sea = Math.max(xp.sea || 0, 120);
  xp.cmd = Math.max(xp.cmd || 0, 120);
  return captain;
}

/** A fresh captain with a seeded name (preferring one no living captain bears — see `taken` on
 *  makePirateCaptain), personality, and zero experience. */
export function makeCaptain(world, taken) {
  const avoid = taken || livingCaptainNames(world);
  const name = composeUniqueName(() => {
    const f = pick(GIVEN, streamFloat(world, 'captain'));
    return streamFloat(world, 'captain') < 0.22
      ? `${f} ${pick(EPITHET, streamFloat(world, 'captain'))}`
      : `${f} ${pick(SURNAME, streamFloat(world, 'captain'))}`;
  }, avoid);
  const traits = { boldness: trait(world), wanderlust: trait(world), greed: trait(world) };
  // A single seed int the client expands into a head-and-shoulders portrait (PortraitRenderer).
  const portrait = Math.floor(streamFloat(world, 'captain') * 0x7fffffff) >>> 0;
  return { name, xp: { sea: 0, gun: 0, cmd: 0 }, traits, personality: personalityOf(traits), portrait, voiceSeed: voiceSeedFrom(portrait) };
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

/** How many guns a MERCHANT captain chooses to mount for DEFENCE — a decision that varies by CHARACTER:
 *  a baseline every trader carries, MORE the more timid (1−boldness) and the more her JUDGMENT (Command)
 *  reads danger on the KNOWN route, but LESS the more GREEDY she is (she grudges hold space to powder
 *  when it could carry saleable cargo). So a prudent captain sails a floating battery into bad waters
 *  while a greedy one runs light and fat and trusts her heels. Capped at weaponCap·ARM_DEFENSE_CAP_FRAC
 *  so a trader is never a warship (she fights defensively — chain-shot at the rig to flee — never out-guns
 *  a pirate). `routeDanger` (0..1) is belief-based and supplied by the caller. Read by ship.js (load from
 *  the home armoury) AND goals.js (buy the shortfall en route) off the SAME formula, so they never drift. */
export function defensiveArmTarget(captain, rules, weaponCap, routeDanger) {
  const tr = T(captain);
  const judgment = skill01(captain, rules, 'cmd'); // Command — a captain's read on risk
  const thrift = 1 - tr.greed * (rules.ARM_GREED_THRIFT || 0); // the greedy hoard hold space for cargo, not guns
  const target = rules.ARM_WEAPONS_BASE
    + ((1 - tr.boldness) * rules.ARM_WEAPONS_CAUTION                     // the cautious always mount some
       + (routeDanger || 0) * rules.ARM_DANGER_BONUS * (0.5 + judgment)) // known peril, weighed by judgment
      * thrift;                                                          // …but a greedy captain trims the lot
  return Math.min(target, weaponCap * rules.ARM_DEFENSE_CAP_FRAC);
}

// ── Skill facets ────────────────────────────────────────────────────────────
// Experience is tracked in THREE pools, each grown by a different kind of deed, so captains
// specialise — a grizzled navigator can be a poor gunner, a bloodthirsty raider a middling sailor:
//   sea — SEAMANSHIP: wind & tacking, weathering storms, finding a lost bearing, boat speed.
//   gun — GUNNERY:    fighting — how hard the crew presses a boarding action.
//   cmd — COMMAND:    leading the crew — provisioning, morale, quelling a mutiny.
// `captain.xp` is `{ sea, gun, cmd }`. A LEGACY numeric xp (an old save, or a test that sets
// `.xp = 5000`) reads as the same value for every facet, and is converted in place on the first award.

/** One facet's xp, tolerating a legacy numeric xp. */
function facetXp(captain, facet) {
  const xp = captain && captain.xp;
  if (xp == null) return 0;
  return typeof xp === 'number' ? xp : (xp[facet] || 0);
}

/** A captain's headline xp — their strongest suit, so "overall" skill/rank track what they're best at
 *  (and stay neutral vs. the old single pool: a merchant's is its voyage-built sea/cmd, a pirate's its gun). */
export function overallXp(captain) {
  const xp = captain && captain.xp;
  if (xp == null) return 0;
  return typeof xp === 'number' ? xp : Math.max(xp.sea || 0, xp.gun || 0, xp.cmd || 0);
}

/** Total lifetime xp across every facet — a raw measure of how much a captain has done. */
export function totalXp(captain) {
  const xp = captain && captain.xp;
  if (xp == null) return 0;
  return typeof xp === 'number' ? xp : (xp.sea || 0) + (xp.gun || 0) + (xp.cmd || 0);
}

/** captain.xp as a mutable facet object (converting a legacy number in place). */
function pools(captain) {
  if (typeof captain.xp === 'number') { const x = captain.xp; captain.xp = { sea: x, gun: x, cmd: x }; }
  else if (!captain.xp || typeof captain.xp !== 'object') captain.xp = { sea: 0, gun: 0, cmd: 0 };
  return captain.xp;
}

/** Skill 0..1 from experience — steep early, asymptotic to 1 (diminishing returns). With a `facet`
 *  ('sea'|'gun'|'cmd') it reads that pool; without one, the captain's headline (strongest) suit. */
export function skill01(captain, rules, facet) {
  if (!captain) return 0;
  const xp = facet ? facetXp(captain, facet) : overallXp(captain);
  return 1 - Math.exp(-xp / rules.XP_SCALE);
}

/** Rank label for the captain's headline experience (paced on the strongest facet, so the ladder
 *  keeps its old calibration whether the captain built xp by trade or by the gun). */
export function rankOf(captain) {
  const xp = overallXp(captain);
  let label = RANKS[0][1];
  for (const [min, name] of RANKS) if (xp >= min) label = name;
  return label;
}

/** Note a captain's rank against the last one seen (`captain._rank`). Returns the NEW rank label when it
 *  has RISEN (so the caller can log a promotion beat), else null. The first call just records the baseline
 *  (no news). Pure — the caller owns the logEvent, so this stays free of an events.js import cycle. */
export function rankUp(captain) {
  if (!captain) return null;
  const rank = rankOf(captain);
  if (captain._rank == null) { captain._rank = rank; return null; }
  if (rank === captain._rank) return null;
  captain._rank = rank;
  return rank;
}

/** The structured payload tagged onto a HANDOVER event (mutiny/prize/pirate/recovered on a ship,
 *  overthrow on an island) so the client can split the durable log into REGIMES and narrate each span
 *  in the voice of whoever kept it. `from`/`to` are lite `{name, voiceSeed, rank}` records (the outgoing
 *  and incoming keeper); `cause` labels the kind of succession so the handover reads right ("the crew
 *  handed me the log" vs "I took her as a prize"). Pure — the caller owns the logEvent. */
export function regimeData(from, to, cause) {
  const lite = (p) => (p ? { name: p.name || null, voiceSeed: p.voiceSeed != null ? p.voiceSeed : null, rank: p.rank || null } : null);
  return { regime: { from: lite(from), to: lite(to), cause } };
}

/** A completed voyage trains SEAMANSHIP and COMMAND (not gunnery) — a flat run reward plus a bonus
 *  per extra hop. So a career trader grows into a fine sailor and leader but stays a poor gunner. */
export function awardVoyageXp(captain, rules, stops) {
  if (!captain) return;
  const gain = rules.XP_PER_RUN * (1 + rules.XP_STOP_BONUS * Math.max(0, stops - 1));
  const p = pools(captain);
  p.sea += gain; p.cmd += gain;
}

/** Award experience for a COMBAT exploit — a prize taken, a pirate hunted down, a haven skirmish won.
 *  Fighting trains GUNNERY, so a feared raider or celebrated hunter grows a deadlier gunner the longer
 *  it survives — and that rising skill feeds back into which fights it presses (piracy/antipiracy). */
export function awardCombatXp(captain, amount, facet = 'gun') {
  if (!captain) return;
  pools(captain)[facet] += (amount || 0);
}

/** Award COMMAND xp — for holding a crew together through a crisis (quelling a mutiny). */
export function awardCommandXp(captain, amount) {
  if (!captain) return;
  pools(captain).cmd += (amount || 0);
}

/** Award SEAMANSHIP xp — for weathering a storm or finding a lost bearing at sea. */
export function awardSeamanshipXp(captain, amount) {
  if (!captain) return;
  pools(captain).sea += (amount || 0);
}
