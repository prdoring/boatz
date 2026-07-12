// Player-intent system — the seam by which client-issued commands become validated
// world mutations. Registered FIRST (before dispatch) so a player-set goal is not
// stomped by NPC dispatch. Empty in pass 1 (no players); exercised by a unit test.
// PURE.

function applyOne(world, intent) {
  switch (intent.type) {
    case 'setVoyage': {
      const ship = world.ships.find((s) => s.id === intent.shipId);
      if (!ship) return false;
      if (intent.by && ship.ownerId !== intent.by) return false; // ownership check
      if (ship.state !== 'idle') return false;
      ship.voyage = intent.voyage;
      return true;
    }
    default:
      return false;
  }
}

export function applyIntents(world) {
  if (!world.intents.length) return;
  for (const intent of world.intents) applyOne(world, intent);
  world.intents.length = 0;
}
