// Vessel names — so ships (and the wrecks and pirates they become) are recurring characters,
// not anonymous dots. "the Iron Gull", "the Salt Maiden". Deterministic (seeded 'shipname'
// stream) and stored on the ship, so it serialises for free. PURE.

import { streamFloat } from './rng.js';

const ADJ = [
  'Iron', 'Salt', 'Black', 'Golden', 'Wandering', 'Crimson', 'Silent', 'Storm', 'Bright', 'Grey',
  'Bold', 'Lucky', 'Restless', 'Emerald', 'Wild', 'Scarlet', 'Northern', 'Dauntless', 'Weary', 'Azure',
];
const NOUN = [
  'Gull', 'Petrel', 'Maiden', 'Serpent', 'Fortune', 'Kraken', 'Marlin', 'Albatross', 'Tide', 'Rover',
  'Osprey', 'Corsair', 'Mermaid', 'Compass', 'Lantern', 'Anchor', 'Wraith', 'Gale', 'Nomad', 'Herron',
];

const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];

/** A fresh vessel name like "the Salt Wraith". */
export function shipName(world) {
  return `the ${pick(ADJ, streamFloat(world, 'shipname'))} ${pick(NOUN, streamFloat(world, 'shipname'))}`;
}
