// The ordered SIM pipeline. `world.js` runs this list once per fixed 0.05s substep.
// Order matters: intents (player commands) → production → consumption/population →
// pricing → dispatch (assign goals) → ship (move/trade). PURE.

import { applyIntents } from './intents.js';
import { produceBase, produceGoods } from './production.js';
import { population } from './population.js';
import { pricing } from './pricing.js';
import { dispatch } from './trade.js';
import { ship } from './ship.js';
import { piracy } from './piracy.js';
import { antipiracy } from './antipiracy.js';
import { crew } from './crew.js';
import { wind } from './wind.js';
import { upkeep } from './upkeep.js';
import { reputation } from './reputation.js';
import { events } from './events.js';
import { governance } from './magistrate.js';
import { development } from './development.js';
import { contracts } from './contracts.js';

export const SIM_SYSTEMS = [
  applyIntents,
  wind,       // drift the global wind before ships read it for movement/decisions
  produceBase,
  produceGoods,
  population,
  pricing,
  dispatch,
  ship,
  piracy,     // pirate vessels hunt/fight/raid (the ship system skips them)
  antipiracy, // danger decay + bounties + privateers hunting pirates (after piracy, before crew)
  crew,       // provisioning/morale/mutiny for at-sea ships, after movement (reads arrivals/docks)
  upkeep,     // gold flow (income/upkeep sinks) + spoilage, after production/trade/movement
  reputation, // daily decay of diplomatic opinions (trade itself updates them in ship.js)
  events,     // daily shocks: blight, plague lifecycle/mortality (wrecks fire in ship.js)
  governance, // island loyalty + magistrate + rebellion (production/income halt via effectiveRate/upkeep)
  development, // wealthy ports invest surplus gold into new hulls (fleet growth + a gold sink), daily
  contracts,   // ports post paid contracts for goods they acutely lack (directed relief), daily
];
