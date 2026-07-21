// The PIRATE LORD — the dark mirror of the magistrate. When a port FALLS to the black flag (havens.js)
// its lawful magistrate is cast out and a Pirate Lord seizes the wharves: a named cutthroat who runs a
// WAR economy where the magistrate ran a lawful one. Where a magistrate builds workshops, taxes, and
// governs toward an ambition, the Lord keeps its den's WAR works (Weapons + Ships), builds raiders from
// fenced plunder, entrenches against sieges, and skims fenced wealth into a private hoard — driven by
// TRAITS (cruelty / cunning / avarice) and an AGENDA (plunder / armada / fortress / hoard).
//
// It mirrors the magistrate's SHAPE (name + portrait + opaque voiceSeed + xp/skill + agenda + hoard), so
// the Story tab narrates the haven span in the Lord's own pirate voice exactly as a magistrate's reign
// reads in theirs (positional attribution via the regime handover marker). Seated in fall(), cleared in
// redeem(). PURE + deterministic (seeded streams; plain-data state serialises whole with the island).

import { streamFloat } from './rng.js';
import { voiceSeedFrom } from './captains.js';
import { GIVEN, EPITHET, pick, composeUniqueName } from './names.js';

// Pirate-lord traits (each 0..1): CRUELTY — brutal raiding (more plunder, faster-rising danger/heat);
// CUNNING — smart entrenchment/evasion (the den survives sieges longer); AVARICE — skims fenced plunder
// into a private hoard instead of reinvesting (the corruption echo; scattered on redeem or the lord's fall).
function trait(world) { return (streamFloat(world, 'lord') + streamFloat(world, 'lord')) / 2; } // triangular → moderates common

// Agendas are the war analog of a magistrate's ambition.
const AGENDA_META = {
  plunder:  { label: 'Plunder',  verb: 'raid' },       // raid hard — more raiders, more heat
  armada:   { label: 'Armada',   verb: 'arm' },        // build the biggest raider fleet (a Ships-workshop focus)
  fortress: { label: 'Fortress', verb: 'fortify' },    // dig in, survive sieges → havenStrength
  hoard:    { label: 'Hoard',    verb: 'hoard' },       // amass fenced wealth
};

export function pirateLordAgendaLabel(lord) {
  const a = lord && lord.agenda;
  return a && AGENDA_META[a.kind] ? AGENDA_META[a.kind].label : '';
}
export function pirateLordAgendaVerb(kind) { return (AGENDA_META[kind] || {}).verb || 'reave'; }

/** Names of the pirate lords currently holding a den — the set a fresh lord prefers to dodge. */
function livingLordNames(world) {
  const set = new Set();
  if (world && world.islands) for (const i of world.islands) if (i.pirateLord && i.pirateLord.name) set.add(i.pirateLord.name);
  return set;
}

/** Choose a war agenda suited to the den (seeded, weighted): a fallen SHIPYARD / Ships-capable den leans
 *  ARMADA (mass-produce raiders); a well-walled den leans FORTRESS; else PLUNDER / HOARD. */
function chooseAgenda(world, island) {
  const w = { plunder: 2, armada: 1, fortress: 1, hoard: 1 };
  const makesShips = (island.workshops || []).some((s) => s.good === 'Ships');
  if (island.type === 'shipyard' || makesShips) w.armada += 3;
  if ((island.havenStrength || 0) >= 0.85) w.fortress += 1;
  const kinds = Object.keys(w);
  const total = kinds.reduce((a, k) => a + w[k], 0);
  let r = streamFloat(world, 'lord') * total;
  for (const k of kinds) { r -= w[k]; if (r <= 0) return k; }
  return 'plunder';
}

/** The pirate-lord skill curve (mirrors magSkill): 0 (green) → 1 (a legend of the sea), rising with the
 *  xp a lord earns holding a den through raids + sieges. */
export function pirateLordSkill(lord, rules) {
  return lord ? 1 - Math.exp(-(lord.xp || 0) / (rules.PIRATELORD_XP_SCALE || 320)) : 0;
}

/** A fresh pirate lord: an epithet name ("Cormac Redhand"), cruelty/cunning/avarice traits, a portrait +
 *  opaque voiceSeed (its writing hand for the Story tab), and a war agenda suited to the den it seizes. */
export function makePirateLord(world, island = null) {
  const avoid = livingLordNames(world);
  const name = composeUniqueName(() => `${pick(GIVEN, streamFloat(world, 'lord'))} ${pick(EPITHET, streamFloat(world, 'lord'))}`, avoid);
  const traits = {
    cruelty: 0.5 + 0.5 * streamFloat(world, 'lord'), // a lord seizes a den by force — never gentle
    cunning: trait(world),
    avarice: 0.4 + 0.5 * streamFloat(world, 'lord'),
  };
  const portrait = Math.floor(streamFloat(world, 'lord') * 0x7fffffff) >>> 0;
  return { name, xp: 0, traits, portrait, voiceSeed: voiceSeedFrom(portrait), agenda: { kind: chooseAgenda(world, island || {}) }, hoard: 0 };
}

/** Seat a fresh pirate lord over a fallen port; returns the lord. */
export function installPirateLord(world, island) {
  island.pirateLord = makePirateLord(world, island);
  return island.pirateLord;
}
