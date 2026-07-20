// Vessel names — so ships (and the wrecks and pirates they become) are recurring characters,
// not anonymous dots. "the Iron Gull", "the Salt Maiden". Deterministic (seeded 'shipname'
// stream) and stored on the ship, so it serialises for free. PURE.
//
// UNIQUENESS is a PREFERENCE, not a guarantee: a fresh name is re-rolled up to TRIES times to
// dodge one already borne by a LIVING ship, then whatever came up is accepted. So the sea reads
// as ~12k distinct hulls (ADJ×NOUN) with only rare collisions, yet the generator never loops
// forever or throws if the pool is somehow exhausted — it just tolerates a repeat. Deriving the
// "taken" set from world.ships (not a persisted ledger) keeps it a pure function of live state,
// so it survives serialize→deserialize identically and a lost ship's name can sail again.

import { streamFloat } from './rng.js';

const ADJ = [
  // colour & material
  'Iron', 'Salt', 'Golden', 'Silver', 'Crimson', 'Scarlet', 'Azure', 'Emerald', 'Sable', 'Ivory',
  'Cobalt', 'Argent', 'Ashen', 'Amber', 'Jade', 'Onyx',
  // weather & element
  'Storm', 'Thunder', 'Tempest', 'Frost', 'Misty', 'Gale', 'Northern', 'Southern', 'Squall', 'Windward',
  'Tidal', 'Stormborn', 'Winter', 'Sunlit', 'Roaring', 'Freezing',
  // temperament
  'Bold', 'Dauntless', 'Valiant', 'Gallant', 'Fearless', 'Relentless', 'Defiant', 'Fierce', 'Savage', 'Ruthless',
  'Merciless', 'Proud', 'Haughty', 'Noble', 'Regal', 'Sovereign',
  // motion & bearing
  'Wandering', 'Restless', 'Wayward', 'Vagrant', 'Errant', 'Roving', 'Nimble', 'Swift', 'Fleet', 'Silent',
  'Lucky', 'Wild', 'Free', 'Eager', 'Steadfast', 'Vigilant',
  // haunted & spent
  'Weary', 'Ragged', 'Hollow', 'Forsaken', 'Forgotten', 'Lost', 'Drowned', 'Sunken', 'Phantom', 'Ghostly',
  'Spectral', 'Eternal', 'Undying', 'Shrouded', 'Veiled', 'Fallen',
  // grim & gilded
  'Grim', 'Stern', 'Grey', 'Wintry', 'Bright', 'Radiant', 'Blazing', 'Burning', 'Gilded', 'Jagged',
  'Rugged', 'Weathered', 'Battered', 'Dreadful', 'Vengeful', 'Wrathful',
];
const NOUN = [
  // seabirds
  'Gull', 'Petrel', 'Albatross', 'Tern', 'Skua', 'Gannet', 'Fulmar', 'Shearwater', 'Kittiwake', 'Cormorant',
  'Osprey', 'Heron', 'Curlew', 'Puffin', 'Auk', 'Frigatebird',
  // creatures of the deep
  'Kraken', 'Serpent', 'Marlin', 'Orca', 'Narwhal', 'Leviathan', 'Barracuda', 'Manta', 'Dolphin', 'Nautilus',
  'Siren', 'Mermaid', 'Selkie', 'Hydra', 'Sturgeon', 'Ray',
  // weather & sky
  'Tempest', 'Gale', 'Squall', 'Typhoon', 'Monsoon', 'Comet', 'Meridian', 'Zenith', 'Aurora', 'Eclipse',
  'Tide', 'Maelstrom', 'Thunder', 'Lightning', 'Nimbus', 'Cyclone',
  // gear of the trade
  'Compass', 'Lantern', 'Anchor', 'Cutlass', 'Sabre', 'Dagger', 'Harpoon', 'Keel', 'Helm', 'Sextant',
  'Astrolabe', 'Doubloon', 'Beacon', 'Rudder', 'Spyglass', 'Halyard',
  // heraldry & fate
  'Fortune', 'Valor', 'Glory', 'Vengeance', 'Defiance', 'Liberty', 'Sovereign', 'Empress', 'Regent', 'Crown',
  'Scepter', 'Banner', 'Herald', 'Triumph', 'Legacy', 'Reckoning',
  // myth
  'Wraith', 'Phantom', 'Specter', 'Revenant', 'Banshee', 'Valkyrie', 'Phoenix', 'Griffin', 'Basilisk', 'Chimera',
  'Nomad', 'Rover', 'Wanderer', 'Corsair', 'Marauder', 'Buccaneer',
  // bloom & gem
  'Rose', 'Thistle', 'Laurel', 'Amaranth', 'Emerald', 'Sapphire', 'Ruby', 'Pearl', 'Opal', 'Amber',
  'Jade', 'Onyx', 'Ivy', 'Bramble', 'Fern', 'Lotus',
  // beast & voyage
  'Dawn', 'Dusk', 'Twilight', 'Horizon', 'Voyager', 'Odyssey', 'Venture', 'Quest', 'Falcon', 'Raven',
  'Hawk', 'Griffon', 'Wolf', 'Lynx', 'Panther', 'Stallion',
];

// Re-rolls to dodge a name a living ship already bears before giving up and tolerating a repeat.
// 96×128 = 12,288 possible names, so this reliably finds a free one for thousands of hulls.
const TRIES = 40;

const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];
const compose = (world) => `the ${pick(ADJ, streamFloat(world, 'shipname'))} ${pick(NOUN, streamFloat(world, 'shipname'))}`;

/** Names borne by ships currently afloat — the set a fresh name prefers to avoid. */
function livingShipNames(world) {
  const set = new Set();
  const ships = world && world.ships;
  if (ships) for (const s of ships) if (s.name) set.add(s.name);
  return set;
}

/** A fresh vessel name like "the Salt Wraith", preferring one no LIVING ship already carries.
 *  `taken` (optional) is a caller-owned Set of names to avoid AND extend — pass it when naming a
 *  batch (world genesis) so the whole fleet dedupes in one O(n) pass instead of rescanning per hull.
 *  Omit it for a one-off spawn: the avoid-set is derived from world.ships on the spot. */
export function shipName(world, taken) {
  const avoid = taken || livingShipNames(world);
  let name = compose(world);
  for (let t = 0; t < TRIES && avoid.has(name); t++) name = compose(world);
  if (taken) taken.add(name); // keep a caller-owned batch set in step (self-derived sets are throwaway)
  return name;
}
