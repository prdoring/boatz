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
import { shoreBatteries } from './shore.js';
import { separation } from './separation.js';
import { crew } from './crew.js';
import { wind } from './wind.js';
import { weather } from './weather.js';
import { upkeep } from './upkeep.js';
import { reputation } from './reputation.js';
import { events } from './events.js';
import { governance } from './magistrate.js';
import { policy } from './policy.js';
import { havens } from './havens.js';
import { contracts } from './contracts.js';
import { reckonVoyages } from './voyages.js';

export const SIM_SYSTEMS = [
  applyIntents,
  weather,    // seasons (production swing) + named storms + prevailing trade winds — before wind
  wind,       // drift the global wind before ships read it for movement/decisions
  produceBase,
  produceGoods,
  population,
  pricing,
  dispatch,
  ship,
  piracy,     // pirate vessels hunt/fight/raid (the ship system skips them)
  antipiracy, // danger decay + bounties + privateers hunting pirates (after piracy, before crew)
  shoreBatteries, // islands fire back: armed ports shell loitering pirates, havens shell besiegers — after both fleets move
  separation, // light ship-to-ship collision avoidance (COLREGS starboard give-way) — after all movement
  crew,       // provisioning/morale/mutiny for at-sea ships, after movement (reads arrivals/docks)
  upkeep,     // gold flow (income/upkeep sinks) + spoilage, after production/trade/movement
  reputation, // daily decay of diplomatic opinions (trade itself updates them in ship.js)
  events,     // daily shocks: blight, plague lifecycle/mortality (wrecks fire in ship.js)
  governance, // island loyalty + magistrate + rebellion (production/income halt via effectiveRate/upkeep)
  policy,     // magistrate acts on its ambition: builds/switches/demolishes/repairs workshops (industry lever), daily — after governance (reads loyalty/civ), before havens
  havens,     // failed islands fall to pirate havens (harbour/build pirates); privateers redeem them — after governance (reads lawlessness) + antipiracy (assaults land this tick)
  // (fleet growth is no longer its own system — the magistrate's naval-expansion lever in `policy` drives
  //  it now, budgeted alongside every other treasury spend; development.js is retained as its executor.)
  contracts,   // ports post paid contracts for goods they acutely lack (directed relief), daily
  reckonVoyages, // the outstanding-voyage ledger: presume long-overdue ships lost at sea, daily
];
