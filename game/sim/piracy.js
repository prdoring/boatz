// Piracy — the antagonist. A crew that mutinies sometimes raises the BLACK FLAG instead of just
// swapping captains: the ship leaves the merchant economy and turns predator. Pirates hunt
// merchant ships, run them down, and fight — the outcome decided by CAPTAIN SKILL, CREW MORALE,
// and WEAPONS ABOARD (a ship loaded with guns fights hard but carries less trade; a fat, unarmed
// trader is easy meat). The winner plunders the loser's cargo and coin; the loser is sunk or
// flees stripped. Combat BURNS weapons (a real sink for a good the economy over-produces), and
// pirates need to eat like anyone — so a pirate that can't take prizes or raid a port starves.
// That plus a hard fleet-fraction cap keeps piracy self-limiting. Rich, recurring characters:
// a feared captain "the Redhand" you can follow across the map. PURE. Runs as its own SIM system
// (after `ship`); the merchant ship system skips pirate vessels, the crew system still feeds them.

import { streamFloat } from './rng.js';
import { transfer, cargoUnits, GOLD, PEOPLE } from './resources.js';
import { logEvent, logEventThrottled, maybeSink } from './events.js';
import { makePirateCaptain, hardenToPirate, skill01, awardCombatXp, rankOf, regimeData } from './captains.js';
import { windMult } from './wind.js';
import { rigMult, damageHull, damageRig } from './repair.js';
import { markDanger, postBounty, payBounty } from './bounty.js';
import { computeFleetByHome } from './fleet.js';
import { nearestIsland as gridNearestIsland, buildShipGrid, eachShipInRange, nearestShip } from './grid.js';
import { orbitPoint, orbitStep, orbitDir, awayPoint } from './steering.js';
import { steerAroundIslands, islandLandRadius } from './navigation.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** A small structured record of the OTHER ship in a fight, ridden on the event's `data` payload so the
 *  chronicler can reference a recurring foe ("the second Coralbay hull to strike to her"). Presentation
 *  only — the sim never reads it back. */
export function foeData(world, foe) {
  if (!foe) return undefined;
  const home = world.islandsById.get(foe.homeId);
  return { foeId: foe.id, foeName: foe.name || null, foeHome: home ? home.name : null };
}

/** Record what a ship is doing right now, for the info panel's activity line. k is a short activity key,
 *  id the island/ship it concerns (or null). Mutates a reused object so it makes no per-tick garbage. */
export function setAct(s, k, id) {
  if (!s._act) s._act = { k, id: id || null };
  else { s._act.k = k; s._act.id = id || null; }
}

/** Local straight-line move (piracy can't import ship.js — that would cycle). Returns arrival. Faces the
 *  travel direction even on the arrival snap, so an orbiting blockader (whose next point sits ~one step
 *  ahead every tick) points along its circle instead of freezing on a stale heading. */
function moveToward(ship, tx, ty, speed, h) {
  const dx = tx - ship.x, dy = ty - ship.y, d = Math.hypot(dx, dy), step = speed * h;
  if (d > 1e-6) ship.heading = Math.atan2(dy, dx);
  if (d <= Math.max(step, 1e-6)) { ship.x = tx; ship.y = ty; return true; }
  ship.x += (dx / d) * step; ship.y += (dy / d) * step;
  return false;
}

/** A holding station a broadside `gap` off `foe`, on the side the ship is already on — so two hulls
 *  trading fire keep sea-room between them (you can see the shots cross) instead of drifting hull-to-hull,
 *  while a chaser still shadows a prize clawing for the horizon. If the ship has crept inside the gap the
 *  station sits BEHIND it, so easing to it opens the range back out. When the pair is COINCIDENT (the old
 *  stacking bug fed the chaser the foe's own coordinates, welding them), pick a deterministic per-hull
 *  bearing off the foe so the station is a real point `gap` away — pushing them apart, not together. */
export function standoffPoint(foe, ship, gap) {
  let dx = ship.x - foe.x, dy = ship.y - foe.y, d = Math.hypot(dx, dy);
  if (d < 1e-3) { // stacked — id-derived golden-angle bearing (pure, replay-safe; mirrors separation.js)
    const a = (parseInt(String(ship.id).replace(/\D/g, ''), 10) || 0) * 2.399963229728653;
    dx = Math.cos(a); dy = Math.sin(a); d = 1;
  }
  return { x: foe.x + (dx / d) * gap, y: foe.y + (dy / d) * gap };
}

export function pirateCount(world) { let n = 0; for (const s of world.ships) if (s.pirate) n++; return n; }

/** Weapons a ship has to fight with (offense + defense). */
export function weaponsAboard(ship) { return ship.cargo.Weapons || 0; }

/** A ship's fighting strength: base + a trained gun-crew (the GUNNERY facet) + crew spirit + guns
 *  aboard + a bold captain's ferocity (+ a pirate's/hunter's edge), scaled by the HULL's fighting
 *  character (a brig fights above its weight, a sloop below it, and it can mount only as many guns as
 *  its class allows — a galleon out-guns a sloop). A battered hull FIGHTS WORSE: guns dismount, the
 *  crew fights the water instead of the foe — so a wallowing wreck is easy meat (the core domino). */
export function combatStrength(world, ship) {
  const t = world.rules;
  const spec = (t.SHIP_TYPES && t.SHIP_TYPES[ship.type]) || null;
  const wcap = spec ? spec.weaponCap : t.COMBAT_WEAPON_CAP;
  const cmult = spec ? spec.combat : 1;
  const guns = Math.min(weaponsAboard(ship), wcap) * t.COMBAT_WEAPON_W;
  const tr = (ship.captain && ship.captain.traits) || {};
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  const hull = ship.hull != null ? ship.hull : 1;
  const s = t.COMBAT_BASE
    + skill01(ship.captain, t, 'gun') * t.COMBAT_SKILL_W          // GUNNERY — a drilled gun crew
    + (ship.morale != null ? ship.morale : 0.6) * t.COMBAT_MORALE_W
    + guns
    + (bold - 0.5) * (t.COMBAT_BOLD_AGGRO || 0)                   // bold crews fight ferociously (traits → combat)
    + (ship.pirate ? t.COMBAT_PIRATE_BONUS : 0)
    + (ship.privateer ? t.COMBAT_PRIVATEER_BONUS : 0); // a professional hunter's edge
  const hullFactor = 1 - (t.COMBAT_HULL_STRENGTH_W || 0) * (1 - hull); // a staved-in hull fights feebly
  return Math.max(0.05, s * cmult * hullFactor);
}

/** The ONE pirate budget (FM #5): the base fleet-fraction cap, LIFTED while pirate HAVENS stand (each den
 *  can sustain a few raiders). Haven-built raiders, sea-risen rogues, and captured prizes ALL draw from
 *  this single budget — reconciling the old split between the haven build-cap and the global rogue cap. */
export function pirateBudget(world) {
  const t = world.rules;
  let havens = 0;
  for (const i of world.islands) if (i.haven) havens++;
  const lift = Math.min(1 + havens * (t.HAVEN_PIRATE_LIFT || 0.5), t.HAVEN_PIRATE_LIFT_MAX || 2.5);
  const frac = t.PIRATE_MAX_FRAC != null ? t.PIRATE_MAX_FRAC : 0.08; // NB: keep a literal 0 as 0 (tests force it)
  return Math.max(1, Math.floor(world.ships.length * frac * lift)); // floor 1 (matches the old canTurnPirate)
}

/** Whether the seas can bear another pirate (the unified budget → self-limiting). */
export function canTurnPirate(world) {
  return pirateCount(world) < pirateBudget(world);
}

/** Raise the black flag. WHO commands under it depends on how she came to it:
 *   • the SITTING captain leads his own crew into piracy (kept, hardened — a continuous fall from trade,
 *     his hand still in the log; cause 'rogue'), OR
 *   • the crew throw him over for a NEW, fearsome pirate master (cause 'pirate').
 *  A bold, greedy captain with a still-loyal crew tends to LEAD; a timid one, or a mutinous/desperate
 *  crew, gets cast out. `opts.overthrow` (a mutiny that turned pirate) forces the new master; `opts.fresh`
 *  (a seeded or haven-built raider, no honest past) does too and records no prior keeper. */
export function turnPirate(world, ship, opts = {}) {
  const t = world.rules;
  const prev = ship.captain ? { name: ship.captain.name, voiceSeed: ship.captain.voiceSeed, rank: rankOf(ship.captain) } : null;
  let lead = false;
  if (!opts.overthrow && !opts.fresh && ship.captain) {
    const tr = ship.captain.traits || {};
    const bold = tr.boldness != null ? tr.boldness : 0.5;
    const greed = tr.greed != null ? tr.greed : 0.5;
    const morale = ship.morale != null ? ship.morale : (t.MORALE_STEADY || 0.7);
    const pLead = Math.max(0.05, Math.min(0.92,
      t.ROGUE_LEAD_BASE + t.ROGUE_LEAD_BOLD * (bold - 0.5) + t.ROGUE_LEAD_GREED * (greed - 0.5) + t.ROGUE_LEAD_MORALE * (morale - 0.5)));
    lead = streamFloat(world, 'mutiny') < pLead;
  }
  ship.pirate = true;
  if (lead) hardenToPirate(ship.captain);        // the same man, harder — keeps name/voiceSeed
  else ship.captain = makePirateCaptain(world);   // a new, fearsome master takes command
  ship.morale = 0.85; ship.unrest = 0; ship.uprising = null; ship.hunger = 0;
  ship.voyage = null; ship.leg = null; ship.legIdx = 0;
  ship._prey = null; ship._plunder = 0; ship._raidCd = 0;
  ship.state = 'outbound'; // displays as 'sailing'; the piracy system drives it
  const home = world.islandsById.get(ship.homeId);
  const tag = home ? ` — a ${home.name} vessel gone rogue` : '';
  const vessel = ship.name || 'a ship';
  const text = lead
    ? `Black flag! Capt. ${ship.captain.name} led the crew of ${vessel} into piracy${tag}.`
    : prev
      ? `Black flag! The crew of ${vessel} cast out Capt. ${prev.name} and rose under Capt. ${ship.captain.name}${tag}.`
      : `Black flag! ${vessel[0] === vessel[0].toUpperCase() ? vessel : 'A raider, ' + vessel + ','} hoists the black flag under Capt. ${ship.captain.name}${tag}.`;
  logEvent(world, 'pirate', text,
    { x: ship.x, y: ship.y, shipId: ship.id,
      data: regimeData(opts.fresh ? null : prev, { name: ship.captain.name, voiceSeed: ship.captain.voiceSeed, rank: rankOf(ship.captain) }, lead ? 'rogue' : 'pirate') });
}

/** A bold, greedy merchant captain may raise the black flag of his OWN accord — no mutiny, no fallen
 *  haven, just ambition, emboldened by lawless waters or a restless crew. The classic fall of an honest
 *  master, and the main wellspring of 'rogue' turns (he keeps command, so the log stays in his hand).
 *  Rare and self-limiting: gated to genuinely bold+greedy captains, throttled per ship, capped by the
 *  fleet fraction. Draws from its own 'temptation' RNG stream so it perturbs no other system. The organic
 *  turnPirate then decides lead-vs-overthrow — and since he's bold+greedy, it comes up 'rogue' nearly
 *  always. Returns true if she turned. */
export function maybeTurnRogue(world, ship) {
  const t = world.rules;
  if (ship.pirate || ship.privateer || !ship.captain || ship.uprising) return false;
  if (world.simTime < (ship._temptCd || 0)) return false;
  ship._temptCd = world.simTime + (t.ROGUE_TEMPT_COOLDOWN_DAYS || 4) * t.SIM_DAY_SECONDS; // weigh it now and then, not every substep
  const tr = ship.captain.traits || {};
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  const greed = tr.greed != null ? tr.greed : 0.5;
  if (bold < (t.ROGUE_TEMPT_BOLD_MIN || 0.6) || greed < (t.ROGUE_TEMPT_GREED_MIN || 0.6)) return false; // only the boldest+greediest tempt
  if (ship.morale != null && ship.morale < (t.MUTINY_MORALE || 0.3)) return false; // a rebellious crew MUTINIES; it doesn't follow him rogue
  if (!canTurnPirate(world)) return false; // the seas won't bear another rogue
  const home = world.islandsById.get(ship.homeId);
  const lawless = home ? (home.lawlessness || 0) : 0;
  const disaffection = Math.max(0, (t.MORALE_STEADY || 0.7) - (ship.morale != null ? ship.morale : 0.7));
  const drive = Math.max(0, bold - 0.5) + Math.max(0, greed - 0.5); // 0..0.8 — rises with both, not too steep
  const p = Math.min(t.ROGUE_TEMPT_MAX || 0.35,
    (t.ROGUE_TEMPT_BASE || 0) * drive * (1 + (t.ROGUE_TEMPT_LAWLESS || 0) * lawless + (t.ROGUE_TEMPT_MORALE || 0) * disaffection));
  if (streamFloat(world, 'temptation') < p) { turnPirate(world, ship); return true; }
  return false;
}

/** SIM system: drive every pirate — hunt and fight prey, run from a hunter, blockade a port, or make
 *  for a haven to victual and fence. What a pirate DOES is shaped by its captain's character (bold /
 *  timid / wandering / greedy), so no two raiders behave alike. */
export function piracy(world, h) {
  const t = world.rules;
  computeFleetByHome(world); // fresh per-home census for maybeSink's last-ship guard (O(S))
  // Havens are few and change slowly; scan a per-substep haven list (built O(N) once) instead of
  // sweeping all N islands per pirate. Preserves world.islands order → same nearest tie-break.
  const havenList = world.islands.filter((i) => i.haven);
  // Prey (non-pirate ships) are fixed for this pass — only `ship`/`antipiracy` move them, and both
  // ran / run outside piracy — so one O(S) grid replaces the per-pirate full-fleet prey scans (the
  // O(P·S) walls in nearestPrey/nearestSeaMerchant). A by-id map turns the per-pirate `_prey`
  // re-lookup from an O(S) find into O(1). Both are rebuilt fresh each substep (ships move).
  world._merchGrid = buildShipGrid(world, world.ships.filter((s) => !s.pirate && !s._sunk));
  world._shipsById = new Map(world.ships.map((s) => [s.id, s]));
  // Privateers hunt pirates; a timid raider needs to see one bearing down to run. Few in number and
  // fixed for this pass (antipiracy runs later), so one small grid covers the flee check.
  const privGrid = buildShipGrid(world, world.ships.filter((s) => s.privateer && !s._sunk));
  const day = Math.floor(world.simTime / t.SIM_DAY_SECONDS);
  let sunk = false;
  for (const ship of world.ships) {
    if (!ship.pirate || ship._sunk) continue;
    const speed = (ship.speed || t.SHIP_SPEED) * t.PIRATE_SPEED_MULT; // per-hull (a captured galleon is slow)
    const tr = (ship.captain && ship.captain.traits) || {};
    const bold = (tr.boldness != null ? tr.boldness : 0.5) >= t.PIRATE_BOLD_TRAIT;
    const timid = (tr.boldness != null ? tr.boldness : 0.5) <= t.PIRATE_TIMID_TRAIT;
    const wander = (tr.wanderlust != null ? tr.wanderlust : 0.5) >= t.PIRATE_WANDER_TRAIT;
    const minPrize = (tr.greed != null ? tr.greed : 0.5) >= 0.6 ? t.PIRATE_GREED_MIN_PRIZE : 0; // the greedy scorn a lean hull
    // EXPERIENCE shapes the hunt: a seasoned raider's nose for a prize reaches farther (a green hand
    // engages only what stumbles across its bow); a veteran also presses a defence a novice would flinch
    // from. Neutral at average skill, so it adds spread without shifting the baseline.
    const skill = skill01(ship.captain, t);
    const reach = 1 + (skill - 0.5) * (t.PIRATE_SKILL_REACH || 0);
    const boldness = tr.boldness != null ? tr.boldness : 0.5;
    // How much punishment a captain bears before he quits the hunt to mend: the bold press on with a
    // staved-in hull, the timid sheer off at the first serious wound (continuous across boldness).
    const critHull = (t.PIRATE_FLEE_HULL || 0.4) - (boldness - 0.5) * (t.PIRATE_FLEE_HULL_BOLD || 0);
    const crippled = (ship.hull != null ? ship.hull : 1) < critHull;
    const den = nearestHaven(havenList, ship);
    const nearDen = den && dist(ship, den) <= t.HAVEN_DEFEND_RANGE;

    // A PIRATE-HUNTER BEARING DOWN — every raider now weighs it (not just the timid): STAND and give
    // battle to a hunter it can match, or BREAK OFF and run for a haven to mend and shelter. The odds a
    // captain will accept are set by his character — the bold engage even at a disadvantage, the timid
    // only a plainly weaker foe; a raider already too mauled to trade blows always runs. (A siege right
    // off the raider's OWN den is left to HAVEN DEFENCE below, which contests those waters rather than
    // fleeing them.) This is what makes a hunted pirate decide — turn and fight, or flee — instead of
    // blindly pressing its own chase while a privateer shoots it to pieces.
    if (!nearDen) {
      const hunter = nearestShip(privGrid, ship.x, ship.y, null, t.PIRATE_FLEE_PRIVATEER_RANGE * reach);
      if (hunter) {
        const fightOdds = (t.PIRATE_FIGHTBACK_ODDS || 0.9) + (0.5 - boldness) * (t.PIRATE_FIGHTBACK_BOLD || 0)
          - (skill - 0.5) * (t.PIRATE_DEFEND_SKILL_EDGE || 0); // bold accept parity/worse; timid want a clear edge
        const stand = !crippled && combatStrength(world, ship) >= combatStrength(world, hunter) * fightOdds;
        ship._blockadeId = null;
        if (stand) { // turn and give battle — close to gun-range, then trade broadsides (attrition, no plunder)
          ship._prey = null;
          setAct(ship, 'fight', hunter.id);
          if (dist(ship, hunter) <= t.PIRATE_COMBAT_RANGE) {
            if (world.simTime >= (ship._fightCd || 0)) { if (skirmish(world, ship, hunter, false)) sunk = true; }
            else { const st = standoffPoint(hunter, ship, t.COMBAT_STANDOFF || 80); if (sail(world, ship, st.x, st.y, speed, h) === 'sunk') sunk = true; }
          } else if (sail(world, ship, hunter.x, hunter.y, speed, h) === 'sunk') sunk = true;
        } else { // outmatched, timid, or too mauled to fight — run for a haven to mend (or just open water)
          ship._prey = null;
          setAct(ship, 'flee', hunter.id);
          const to = den || awayPoint(hunter.x, hunter.y, ship.x, ship.y, t.PIRATE_HUNT_RANGE);
          if (sail(world, ship, to.x, to.y, speed, h) === 'sunk') sunk = true;
        }
        continue;
      }
    }

    // DEFEND THE HAVEN — a raider lying off its stronghold turns on a privateer come to assault it (home and
    // larder are worth a fight). With the privateer now clearing this screen before it bombards
    // (antipiracy.js), this turns the old "two lines facing off, nobody engaging" into a real battle. A
    // pirate that can trade blows CHARGES to board; one plainly outgunned SHADOWS the besieger at a menacing
    // distance — ready to pounce if its guns run dry or a consort closes — rather than throwing itself away.
    // Only the BOLD press the attack (pirates skew bold, so most do).
    if (nearDen) {
      const besieger = nearestShip(privGrid, den.x, den.y, null, t.HAVEN_DEFEND_RANGE);
      if (besieger) {
        ship._blockadeId = null;
        setAct(ship, 'defend', den.id);
        const oddsBar = t.PIRATE_DEFEND_ODDS - (skill - 0.5) * (t.PIRATE_DEFEND_SKILL_EDGE || 0); // the seasoned press closer fights
        const matched = combatStrength(world, ship) >= combatStrength(world, besieger) * oddsBar;
        if (bold && matched) {
          ship._prey = besieger.id;
          if (dist(ship, besieger) <= t.PIRATE_COMBAT_RANGE) {
            if (world.simTime >= (ship._fightCd || 0)) { if (skirmish(world, ship, besieger)) sunk = true; }
            // Reloading: hold a broadside gap off the hunter instead of grinding hull-to-hull off the den.
            else { const st = standoffPoint(besieger, ship, t.COMBAT_STANDOFF || 80); if (sail(world, ship, st.x, st.y, speed, h) === 'sunk') sunk = true; }
          } else if (sail(world, ship, besieger.x, besieger.y, speed, h) === 'sunk') sunk = true;
        } else { // outmatched or cautious: shadow the hunter, keeping the haven's waters contested
          ship._prey = null;
          const radius = t.PIRATE_BLOCKADE_RANGE;
          const p = orbitPoint(besieger.x, besieger.y, ship.x, ship.y, radius, orbitDir(ship.id), orbitStep(speed, radius, h));
          if (sail(world, ship, p.x, p.y, speed, h) === 'sunk') sunk = true;
        }
        continue;
      }
    }

    // SELF-PRESERVATION — a raider mauled past what its captain will bear breaks off the hunt and limps to
    // its nearest haven to mend, EVEN WITH a fat prize in sight (a wreck takes no prizes — this is what
    // stops a shot-to-pieces pirate blindly pressing a chase). With no haven to run to it fights on to
    // survive; the gentler 'battered' valve below still catches a lesser hurt when the seas are quiet.
    if (crippled && den) {
      ship._blockadeId = null; ship._prey = null;
      setAct(ship, 'resupply', den.id);
      if (dist(ship, den) > t.HAVEN_RESUPPLY_RANGE * 0.5 && sail(world, ship, den.x, den.y, speed, h) === 'sunk') sunk = true;
      continue;
    }

    // HUNGER makes a keener hunter — for a starving crew the prize IS food, so it can't afford to be picky.
    // A fed pirate between raids lies low with its loot (rests) and, while HOLDING a blockade, shrinks its
    // prey range to the snap to stay on station rather than chase distant traffic. A HUNGRY pirate does
    // NEITHER: it never rests, ranges to its full reach even off a blockaded port, and scorns no prize,
    // however lean (dropping the greedy captain's minimum). That's what sends a starving raider after ships.
    const hungry = (ship.cargo.Food || 0) < t.CREW_FOOD_PER_DAY;
    const resting = !hungry && world.simTime < (ship._huntCd || 0);
    const holding = !wander && ship._blockadeId && world.simTime < (ship._blockadeUntil || 0);
    const preyRange = (holding && !hungry ? t.PIRATE_BLOCKADE_SNAP : t.PIRATE_HUNT_RANGE) * reach;
    let prey = null;
    if (!resting && ship._prey) { const p = world._shipsById.get(ship._prey); if (p && !p.pirate && !p._sunk && dist(ship, p) <= preyRange && !(dist(ship, p) > t.PIRATE_COMBAT_RANGE && shelteredAtPort(world, p))) prey = p; }
    if (!resting && !prey) { prey = nearestPrey(world, ship, preyRange, hungry ? 0 : minPrize); ship._prey = prey ? prey.id : null; }

    if (prey) {
      setAct(ship, 'hunt', prey.id);
      // A running battle of broadsides paced by _fightCd — no longer one dice roll. FIRE a round when in
      // gun-range and reloaded; resolveCombat decides when the fight ENDS (a prize struck & plundered, the
      // raider sheering off, or a hull foundering) and clears ship._prey / sets the hunt cooldown itself.
      // Otherwise CLOSE IN — running the merchant down at sea, and staying glued alongside between broadsides
      // so a merchant clawing for the horizon while the guns reload doesn't simply slip away.
      if (dist(ship, prey) <= t.PIRATE_COMBAT_RANGE && world.simTime >= (ship._fightCd || 0)) {
        ship._fightCd = world.simTime + (t.COMBAT_ROUND_SEC || 1.2);
        if (resolveCombat(world, ship, prey)) sunk = true;
      } else if (dist(ship, prey) <= t.PIRATE_COMBAT_RANGE) {
        // Reloading, already at gun-range: hold a broadside gap off the prize rather than piling onto her
        // hull — leaves sea-room to see the shots cross — while still shadowing her so she can't slip away.
        const st = standoffPoint(prey, ship, t.COMBAT_STANDOFF || 80);
        if (sail(world, ship, st.x, st.y, speed, h) === 'sunk') sunk = true;
      } else if (sail(world, ship, prey.x, prey.y, speed, h) === 'sunk') sunk = true;
      continue;
    }

    // No prey in sight. A hungry or plunder-laden pirate makes for its nearest HAVEN to victual and
    // fence its loot (havens.js does the transfer once it's in range) — a base is what lets a pirate
    // survive and a haven grow rich.
    const laden = cargoUnits(ship) > ship.capacity * 0.5 || (ship.cargo[GOLD] || 0) > 150;
    const battered = (ship.hull != null ? ship.hull : 1) < t.REPAIR_HAVEN_HULL; // a mauled raider runs for the den to mend
    const haven = den; // nearest haven, already found above
    if (haven && (hungry || laden || battered)) {
      ship._blockadeId = null;
      setAct(ship, 'resupply', haven.id);
      if (dist(ship, haven) > t.HAVEN_RESUPPLY_RANGE * 0.5 && sail(world, ship, haven.x, haven.y, speed, h) === 'sunk') sunk = true;
      // else: loitering in the haven's roads — resupply/fence happens in havens.js this same tick
      continue;
    }

    const isle = gridNearestIsland(world, ship.x, ship.y);
    // A BOLD raider raids a port when merely peckish; a cautious one only when truly starving (raiding
    // is dangerous, so the timid would sooner hunt or slink to a haven).
    const willRaid = hungry && (bold || (ship.cargo.Food || 0) <= 0);
    // Can it actually strike NOW, or is it (or the port) on a post-raid cooldown? A port just hit — or one
    // already stripped of food — must NOT become a trap the raider steers onto and parks dead-centre inside
    // while it waits out the cooldown (that was the "pirate stuck in the middle of an island" bug). When it
    // can't raid, it falls through to blockade the port's approaches instead — orbiting, never on the wharf.
    const canRaid = world.simTime >= (ship._raidCd || 0) && world.simTime >= (isle._raidCd || 0);
    if (willRaid && isle && canRaid && dist(ship, isle) <= t.PIRATE_RAID_RANGE) {
      ship._blockadeId = null;
      setAct(ship, 'raid', isle.id);
      raidIsland(world, ship, isle);
      continue;
    }
    if (willRaid && isle && canRaid) { // starving with no haven to run to: close on the port to raid it (the
      ship._blockadeId = null;         // crew must eat) — but only to raid range, never onto the wharf itself.
      setAct(ship, 'raid', isle.id);
      if (dist(ship, isle) > t.PIRATE_RAID_RANGE * 0.6 && sail(world, ship, isle.x, isle.y, speed, h) === 'sunk') sunk = true;
      continue;
    }

    // No prey in snap range: a WANDERER — or any HUNGRY pirate — roves the lanes for wherever trade is
    // actually moving, instead of camping a port whose whole fleet shelters in harbour the moment a raider
    // arrives (an idle hull is safe from nearestPrey, so a blockade scares off the very prey the crew needs
    // to eat). Everyone else BLOCKADES — orbiting the approaches (never the wharf, which would pin the fleet
    // and gridlock trade), chasing what ventures close, and stoking the fear of these waters. A rover with
    // no trade in sight falls through to blockade too.
    const seaPrey = (wander || hungry) ? nearestSeaMerchant(world, ship) : null;
    if (seaPrey) {
      ship._blockadeId = null;
      setAct(ship, 'hunt', seaPrey.id);
      if (sail(world, ship, seaPrey.x, seaPrey.y, speed, h) === 'sunk') sunk = true;
    } else if (isle) {
      if (!ship._blockadeId || world.simTime >= (ship._blockadeUntil || 0) || !world.islandsById.has(ship._blockadeId)) {
        ship._blockadeId = isle.id;
        ship._blockadeUntil = world.simTime + t.PIRATE_BLOCKADE_DAYS * t.SIM_DAY_SECONDS;
      }
      const port = world.islandsById.get(ship._blockadeId) || isle;
      setAct(ship, 'blockade', port.id);
      if (ship._blockadeDay !== day) { // once a day, word of the blockade makes these waters feared (draws privateers)
        ship._blockadeDay = day;
        port.danger = Math.min(1, (port.danger || 0) + t.PIRATE_BLOCKADE_DANGER);
      }
      // Bold blockaders choke in tight; the timid keep a looser noose out in the approaches.
      const radius = t.PIRATE_BLOCKADE_RANGE * (bold ? 0.8 : timid ? 1.25 : 1);
      const p = orbitPoint(port.x, port.y, ship.x, ship.y, radius, orbitDir(ship.id), orbitStep(speed, radius, h));
      if (sail(world, ship, p.x, p.y, speed, h) === 'sunk') sunk = true;
    } else { // no port anywhere in reach (open ocean) — drift toward any moving trade
      const target = nearestSeaMerchant(world, ship);
      setAct(ship, target ? 'hunt' : 'rove', target ? target.id : null);
      if (target && sail(world, ship, target.x, target.y, speed, h) === 'sunk') sunk = true;
    }
  }
  if (sunk) world.ships = world.ships.filter((s) => !s._sunk);
}

function sail(world, ship, tx, ty, speed, h) {
  const aim = steerAroundIslands(world, ship, tx, ty); // round any landmass between the raider and its mark
  const heading = Math.atan2(aim.y - ship.y, aim.x - ship.x);
  const eff = speed * rigMult(ship, world.rules) * windMult(world, heading, skill01(ship.captain, world.rules, 'sea'));
  if (maybeSink(world, ship, eff * h)) return 'sunk';
  moveToward(ship, aim.x, aim.y, eff, h);
  return 'sailing';
}

/** Has this merchant reached the SHELTER of a lawful port — tucked in its roads, under its guns? Then a
 *  raider can't run her down: chasing prey that hugs a defended shore just leaves the pirate circling the
 *  island forever, unable to close (the "bouncing back and forth on the port" bug — steerAroundIslands keeps
 *  deflecting it around the landmass). Such prey is dropped BEYOND gun-range (a raider already alongside
 *  still boards her); the pirate falls through to BLOCKADE and waits for her to stand back into open water. */
function shelteredAtPort(world, s) {
  const t = world.rules;
  const isl = gridNearestIsland(world, s.x, s.y);
  if (!isl || isl.haven) return false; // a den is no shelter for a merchant
  return dist(s, isl) <= islandLandRadius(isl, t) + (t.SHIP_ISLAND_CLEARANCE || 0) + (t.PORT_SHELTER_MARGIN || 70);
}

/** Nearest merchant (non-pirate, at sea) within `range` — the fatter the prize the better. Visits
 *  only the ships the merchant grid holds within range (grid excludes pirates); keeps the exact
 *  in-port skip and prize scoring. `minPrize` lets a greedy captain scorn a near-empty hull. */
function nearestPrey(world, ship, range, minPrize = 0) {
  const t = world.rules;
  let best = null, bestScore = -Infinity;
  eachShipInRange(world._merchGrid, ship.x, ship.y, range, (s) => {
    if (s._sunk || s.state === 'idle' || s.state === 'trading') return; // ships in port are safe
    const prize = (s.cargo[GOLD] || 0) + cargoUnits(s) * 10; // rough worth of the haul
    if (prize < minPrize) return; // not worth a greedy captain's powder
    if (dist(ship, s) > t.PIRATE_COMBAT_RANGE && shelteredAtPort(world, s)) return; // reached a port's guns — can't be chased onto the wharf
    const score = prize - dist(ship, s) * 2; // near + rich preferred
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return best;
}

/** Nearest merchant already UNDER WAY (outbound/inbound) — a pirate's real prey lives on the lanes,
 *  not in port (ships in harbour are safe and are skipped by nearestPrey). No range cap: it gives a
 *  prowling pirate a heading toward wherever trade is actually moving. Expanding-ring nearest over
 *  the merchant grid (excludes pirates); same lowest-index tie-break as the old first-min scan. */
function nearestSeaMerchant(world, ship) {
  return nearestShip(world._merchGrid, ship.x, ship.y,
    (s) => !s.privateer && !s._sunk && (s.state === 'outbound' || s.state === 'inbound') && !shelteredAtPort(world, s));
}

/** Nearest pirate HAVEN — a stronghold a raider can run to for food and to fence loot (havens.js).
 *  Scans the pre-filtered per-substep haven list (built once in piracy()), which preserves
 *  world.islands order so the first-min tie-break is unchanged. */
function nearestHaven(havens, ship) {
  let best = null, bestD = Infinity;
  for (const p of havens) { const d = dist(ship, p); if (d < bestD) { bestD = d; best = p; } }
  return best;
}

const burn = (ship, amt) => { ship.cargo.Weapons = Math.max(0, (ship.cargo.Weapons || 0) - amt); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** ONE ROUND of a gunnery duel (the shared heart of every ship-to-ship fight). Both ships fire: each
 *  removes HULL & RIG from the other in proportion to its OWN combatStrength share (armour-divided in
 *  damageHull/Rig), so the stronger ship both deals more and takes less — a lopsided fight ends fast, an
 *  even one grinds. Chain-shot doctrine differs by flag: a PIRATE aims at the RIG (COMBAT_CHAIN_FRAC) to
 *  cripple-and-board; a MERCHANT aims even HIGHER at the rig (COMBAT_CHAIN_MERCHANT) — defensive fire to
 *  shoot away the pursuer's sails and FLEE, only occasionally holing the hull; a PRIVATEER/navy pounds the
 *  HULL (COMBAT_CHAIN_NAVY), out to sink. Both burn powder — a long fight leaves guns dry and offense
 *  fading — and morale drifts toward whoever's winning the exchange. Returns the two strengths (pre-round). */
export function exchangeFire(world, A, B) {
  const t = world.rules;
  const sA = combatStrength(world, A), sB = combatStrength(world, B);
  const tot = sA + sB || 1;
  const base = t.COMBAT_DMG_BASE || 0.16;
  const toB = base * (sA / tot) * 2; // ×2: an even duel (share ½) strips ~base from each per round
  const toA = base * (sB / tot) * 2;
  const chain = (s) => (s.pirate ? (t.COMBAT_CHAIN_FRAC != null ? t.COMBAT_CHAIN_FRAC : 0.6)          // rig — cripple & board
                     : s.privateer ? (t.COMBAT_CHAIN_NAVY != null ? t.COMBAT_CHAIN_NAVY : 0.25)       // hull — kill
                                   : (t.COMBAT_CHAIN_MERCHANT != null ? t.COMBAT_CHAIN_MERCHANT : 0.75)); // rig — cripple & FLEE
  const chA = chain(A), chB = chain(B);
  damageRig(B, toB * chA, t); damageHull(B, toB * (1 - chA), t);
  damageRig(A, toA * chB, t); damageHull(A, toA * (1 - chB), t);
  burn(A, t.COMBAT_WEAPON_BURN); burn(B, t.COMBAT_WEAPON_BURN);
  const swing = 0.04 * ((sA - sB) / tot);
  A.morale = clamp01((A.morale != null ? A.morale : 0.6) + swing);
  B.morale = clamp01((B.morale != null ? B.morale : 0.6) - swing);
  return { sA, sB };
}

/** Will this ship STRIKE HER COLOURS this round? A merchant/privateer surrenders when her hull or morale
 *  breaks and her captain lacks the boldness+gunnery to fight on (bold, drilled captains hold out to a lower
 *  hull). A PIRATE never strikes — the noose awaits a captured rogue, so she fights or runs. */
function strikes(world, ship) {
  const t = world.rules;
  if (ship.pirate) return false;
  const tr = (ship.captain && ship.captain.traits) || {};
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  const grit = bold * 0.6 + skill01(ship.captain, t, 'gun') * 0.4; // resolve to fight on
  const hull = ship.hull != null ? ship.hull : 1;
  const mor = ship.morale != null ? ship.morale : 0.6;
  return hull <= (t.STRIKE_HULL || 0.3) * (1 - 0.5 * grit)
      || mor <= (t.STRIKE_MORALE || 0.2) * (1 - 0.5 * grit);
}

/** FIGHT OR FLEE — the running assessment BOTH combatants make each round (a pirate, a privateer, any
 *  captain in a duel): keep trading blows, or sheer off while she still can? A captain breaks off only
 *  when the odds AND his hull have BOTH turned against him — never on either alone (a stout ship trades
 *  blows even when outgunned; a battered one presses on while it's still winning the exchange). At an
 *  AVERAGE captain (boldness & skill 0.5) the bars are exactly FLEE_HULL / BREAKOFF_ODDS; character only
 *  widens the spread: NERVE (rising with boldness & seamanship) lowers both, so the bold & seasoned hold
 *  on through worse. The FEARLESS (boldness ≥ COMBAT_FEARLESS) never quit; a DISMASTED ship (rig ≤
 *  RIG_DISTRESS) can't run and must fight on or strike (the core domino). Returns true if `ship` should
 *  disengage from `foe`. */
export function assessFlee(world, ship, foe) {
  const t = world.rules;
  const tr = (ship.captain && ship.captain.traits) || {};
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  if (bold >= (t.COMBAT_FEARLESS != null ? t.COMBAT_FEARLESS : 0.8)) return false; // the fearless never quit a fight
  const rig = ship.rig != null ? ship.rig : 1;
  if (rig <= (t.RIG_DISTRESS || 0.12)) return false;                               // dismasted — can't run, must fight/strike
  const skill = skill01(ship.captain, t);
  const nerve = (bold - 0.5) + (skill - 0.5) * (t.FLEE_SKILL_NERVE || 0);           // steadier the bolder & more seasoned
  const hull = ship.hull != null ? ship.hull : 1;
  if (hull > (t.FLEE_HULL || 0.5) - nerve * (t.FLEE_NERVE_HULL || 0)) return false; // still stout enough to trade blows
  const oddsBar = Math.max(0.1, (t.BREAKOFF_ODDS || 0.65) - nerve * (t.FLEE_NERVE_ODDS || 0)); // the steady fight worse odds
  return combatStrength(world, ship) < combatStrength(world, foe) * oddsBar;        // ...break off only when truly outmatched
}

/** A pirate takes a struck merchant as a PRIZE — the hull itself, not just her cargo — manned by a green
 *  skeleton crew and sailed under the black flag (she'll soon make for a haven, growing the pirate fleet).
 *  Gated by the raider's GUNNERY & BOLDNESS (a skilled, bold crew can man a prize), the hull being worth
 *  taking (> PRIZE_MIN_HULL), and the fleet-fraction cap (canTurnPirate — capture stays self-limiting).
 *  Returns true if she was taken. */
function tryTakePrize(world, pirate, victim) {
  const t = world.rules;
  if ((victim.hull != null ? victim.hull : 1) < (t.PRIZE_MIN_HULL || 0.15)) return false; // too shot-up to sail
  if (!canTurnPirate(world)) return false; // the seas won't bear another rogue
  const gun = skill01(pirate.captain, t, 'gun');
  const tr = (pirate.captain && pirate.captain.traits) || {};
  const bold = tr.boldness != null ? tr.boldness : 0.5;
  const p = (t.PRIZE_CHANCE || 0) * (0.4 + 0.6 * gun) * (0.6 + 0.8 * bold);
  if (streamFloat(world, 'combat') >= p) return false;
  const prevCap = victim.captain ? { name: victim.captain.name, voiceSeed: victim.captain.voiceSeed, rank: rankOf(victim.captain) } : null;
  victim.pirate = true;
  // FM #4 — she flies the black flag now, no longer the origin's hull: RE-HOME her to the captor so the
  // origin's live fleet census stops counting her forever (and it re-orders a replacement). Its belief
  // ledger still HOPES for her until overdue, then presumes her lost — information-by-sea preserved.
  if (pirate.homeId) victim.homeId = pirate.homeId;
  victim.captain = makePirateCaptain(world);
  victim.morale = t.PRIZE_CREW_MORALE != null ? t.PRIZE_CREW_MORALE : 0.4; // a green prize crew, low spirits
  victim.unrest = 0; victim.uprising = null; victim.hunger = 0;
  victim.voyage = null; victim.leg = null; victim.legIdx = 0;
  victim._prey = null; victim._plunder = 0; victim._raidCd = 0; victim._blockadeId = null;
  victim.adrift = null; victim._aidDeeds = null;
  victim.state = 'outbound'; // displays as sailing; the piracy system drives it from here
  markDanger(world, victim.x, victim.y, 'plunder');
  logEvent(world, 'prize', `${pirate.name} took ${victim.name || 'a merchant'} as a PRIZE — Capt. ${victim.captain.name} sails her under the black flag now.`,
    { x: victim.x, y: victim.y, shipId: victim.id, data: regimeData(prevCap, { name: victim.captain.name, voiceSeed: victim.captain.voiceSeed, rank: rankOf(victim.captain) }, 'prize') });
  return true;
}

/** A merchant has struck to a pirate: she's BOARDED and plundered. Loot goes to the raider, who then
 *  rests with the spoils. Then, if the raider can man her, he takes the HULL as a PRIZE (tryTakePrize);
 *  otherwise she's occasionally scuttled (a coup de grâce), or freed to limp home stripped. */
function boardPrize(world, pirate, victim) {
  const t = world.rules;
  const loot = plunder(world, pirate, victim);
  awardCombatXp(pirate.captain, t.XP_PER_PRIZE); // a prize taken — the captain's legend (and gunnery) grows
  pirate.morale = Math.min(1, (pirate.morale || 0.6) + t.PIRATE_MORALE_PLUNDER);
  pirate._huntCd = world.simTime + t.PIRATE_HUNT_COOLDOWN; // lie low with the spoils
  pirate._prey = null;
  markDanger(world, victim.x, victim.y, 'plunder');   // these waters are now feared
  postBounty(world, pirate, victim.homeId, 'plunder'); // the robbed ship's home wants blood
  if (tryTakePrize(world, pirate, victim)) return;     // she changes flag — a consort, not a wreck
  const scuttle = streamFloat(world, 'combat') < (t.PIRATE_SINK_ON_LOSS || 0.06);
  logEvent(world, 'plunder', `${pirate.name} battered ${victim.name || 'a merchant'} into striking her colours — Capt. ${pirate.captain.name} took ${loot.goods} cargo and ${loot.gold}g${scuttle ? ', then scuttled her.' : '; she limped away stripped.'}`, { x: victim.x, y: victim.y, shipId: pirate.id, data: { ...foeData(world, victim), goods: loot.goods, gold: loot.gold, scuttle } });
  if (scuttle) { victim._sunk = true; return; }
  victim.morale = Math.max(0, (victim.morale != null ? victim.morale : 0.5) - 0.2);
  const home = world.islandsById.get(victim.homeId);
  victim.voyage = { reason: 'flee', stops: [], index: 0 };
  victim.leg = null; victim.legIdx = 0;
  victim.targetX = home ? home.x : victim.x; victim.targetY = home ? home.y : victim.y;
  victim.state = 'inbound';
}

/** A running battle between a pirate and a merchant, resolved ONE ROUND per call (paced by the caller's
 *  _fightCd). Both trade fire; then: a hull driven to 0 FOUNDERS (overkill — the loot goes down with her, so
 *  a canny raider batters a prize into STRIKING, not sinking); the merchant may STRIKE (→ boarded & plundered)
 *  or the raider, hull thinning, may BREAK OFF to run for a haven and repair. Returns true if a hull sank. */
function resolveCombat(world, pirate, victim) {
  const t = world.rules;
  exchangeFire(world, pirate, victim);
  if (victim.hull <= 0) { // overkill — the merchant founders, her cargo lost
    victim._sunk = true;
    pirate._huntCd = world.simTime + t.PIRATE_HUNT_COOLDOWN; pirate._prey = null;
    markDanger(world, victim.x, victim.y, 'plunder');
    postBounty(world, pirate, victim.homeId, 'plunder');
    logEvent(world, 'sunk', `${pirate.name} pounded ${victim.name || 'a merchant'} beneath the waves — her cargo lost with her.`, { x: victim.x, y: victim.y, shipId: pirate.id, data: foeData(world, victim) });
    return true;
  }
  if (pirate.hull <= 0) { // a well-armed merchant shot the raider to pieces
    pirate._sunk = true;
    awardCombatXp(victim.captain, t.XP_PER_DEFENSE); // the crew learned to fight
    victim.morale = Math.min(1, (victim.morale != null ? victim.morale : 0.5) + 0.1);
    const paid = payBounty(world, pirate, victim.homeId);
    logEvent(world, 'fended', `${victim.name || 'A merchant'} shot ${pirate.name} to pieces and sent her under — Capt. ${victim.captain ? victim.captain.name : 'the master'}'s guns won the day${paid ? ` (${paid}g bounty claimed)` : ''}.`, { x: victim.x, y: victim.y, shipId: victim.id, data: foeData(world, pirate) });
    return true;
  }
  if (strikes(world, victim)) { boardPrize(world, pirate, victim); return false; }
  if (assessFlee(world, pirate, victim)) { // the raider sheers off to lick its wounds at a haven
    pirate._prey = null;
    pirate._huntCd = world.simTime + t.PIRATE_HUNT_COOLDOWN * 0.5;
    victim.morale = Math.min(1, (victim.morale != null ? victim.morale : 0.5) + 0.05);
    logEventThrottled(world, 'brokeoff', t.SIM_DAY_SECONDS, `${pirate.name} broke off the chase of ${victim.name || 'a merchant'}, her hull too battered to press.`, { x: pirate.x, y: pirate.y, shipId: pirate.id });
    return false;
  }
  return false; // trade another broadside next round
}

/** A pirate↔privateer SKIRMISH: the two trade broadsides — a fight, not a robbery (no plunder). One ROUND
 *  per call, paced by _fightCd on BOTH ships (COMBAT_ROUND_SEC) so a duel plays out over several seconds and
 *  antipiracy's hunt doesn't double-resolve the same pair this tick. Attrition decides it — whoever's hull
 *  founders first goes down. `atHaven` picks the chronicle voice: a raider DEFENDING its den, or one that
 *  turned at bay on a hunter in the open sea. Returns true if a hull was sunk. */
function skirmish(world, pirate, priv, atHaven = true) {
  const t = world.rules;
  const round = t.COMBAT_ROUND_SEC || 1.2;
  pirate._fightCd = world.simTime + round;
  priv._fightCd = world.simTime + round;
  exchangeFire(world, pirate, priv);
  if (priv.hull <= 0) {
    priv._sunk = true;
    awardCombatXp(pirate.captain, t.XP_PER_DEFENSE); // drove off the hunter — a defender's renown
    pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.08);
    logEvent(world, 'hunterlost', atHaven
      ? `${priv.name || 'A privateer'} was beaten off a pirate haven and sunk by ${pirate.name || 'a raider'}.`
      : `${pirate.name || 'A raider'} turned at bay on the privateer ${priv.name || ''} and sent her under — Capt. ${pirate.captain ? pirate.captain.name : 'the master'} beat off the hunter.`,
      { x: priv.x, y: priv.y, shipId: pirate.id });
    return true;
  }
  if (pirate.hull <= 0) {
    pirate._sunk = true;
    awardCombatXp(priv.captain, t.XP_PER_KILL); // cut down a raider
    const paid = payBounty(world, pirate, priv.homeId);
    logEvent(world, 'hunted', atHaven
      ? `${priv.name || 'A privateer'} cut down ${pirate.name || 'a raider'} defending its haven${paid ? ` — ${paid}g bounty claimed` : ''}.`
      : `The privateer ${priv.name || ''} ran down ${pirate.name || 'a raider'} and sank her${paid ? ` — ${paid}g bounty claimed` : ''}.`,
      { x: pirate.x, y: pirate.y, shipId: priv.id, data: foeData(world, pirate) });
    return true;
  }
  return false;
}

/** Strip a beaten merchant: all its coin, then its cargo (food first — pirates must eat) into the
 *  pirate's hold, up to what will fit. Returns rough {goods, gold} for the chronicle. */
function plunder(world, pirate, victim) {
  const gpu = world.rules.GOLD_PER_CARGO_UNIT;
  const gold = Math.round(victim.cargo[GOLD] || 0);
  transfer(victim.cargo, GOLD, pirate.cargo, GOLD, victim.cargo[GOLD] || 0);
  let goods = 0;
  const keys = Object.keys(victim.cargo).sort((a, b) => (a === 'Food' ? -1 : b === 'Food' ? 1 : 0));
  for (const g of keys) {
    if (g === GOLD || g === PEOPLE) continue;
    const space = Math.max(0, pirate.capacity - cargoUnits(pirate, gpu));
    const take = Math.min(victim.cargo[g] || 0, space);
    if (take > 0.5) goods += transfer(victim.cargo, g, pirate.cargo, g, take);
  }
  return { goods: Math.round(goods), gold };
}

/** A coastal raid: a starving pirate carries off a port's food and coin (a hit to its loyalty),
 *  which feeds the crew but stokes hardship on the island (→ more famine, unrest, rebellion). */
function raidIsland(world, pirate, island) {
  const t = world.rules;
  island._raidCd = world.simTime + t.PIRATE_RAID_ISLAND_CD; // the port musters its defences afterward
  pirate._raidCd = world.simTime + 60;
  // Raiding a port is dangerous — its guns and mob can send the raider to the bottom.
  if (streamFloat(world, 'combat') < t.PIRATE_RAID_RISK) {
    pirate._sunk = true;
    const paid = payBounty(world, pirate, island.id); // the port claims the reward on its own defence
    logEvent(world, 'raidfail', `${island.name} beat off a raid by ${pirate.name} and sank her at the quay${paid ? ` (${paid}g bounty claimed)` : ''}.`, { islandId: island.id, shipId: pirate.id });
    return;
  }
  const food = Math.min(t.PIRATE_RAID_FOOD, island.stock.Food || 0);
  transfer(island.stock, 'Food', pirate.cargo, 'Food', food);
  const gold = Math.floor((island.gold || 0) * t.PIRATE_RAID_GOLD_FRAC);
  transfer(island, 'gold', pirate.cargo, GOLD, gold);
  if (island.loyalty != null) island.loyalty = Math.max(0, island.loyalty - t.PIRATE_RAID_LOYALTY_HIT);
  awardCombatXp(pirate.captain, t.XP_PER_PRIZE); // a port sacked — hard-won experience
  pirate.morale = Math.min(1, (pirate.morale || 0.6) + 0.15);
  markDanger(world, island.x, island.y, 'raid');       // a sacked port's waters are the most feared
  postBounty(world, pirate, island.id, 'raid');        // and it puts a price on the raider's head
  logEvent(world, 'raid', `${pirate.name} raided ${island.name} — Capt. ${pirate.captain.name} carried off ${Math.round(food)} food and ${gold}g.`, { islandId: island.id, shipId: pirate.id });
}
