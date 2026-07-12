// Full-state persistence — captures ALL authoritative state (including RNG stream
// positions and nextEntityId) so a world round-trips exactly and an authoritative
// restart resumes deterministically. DISTINCT from the lossy wire projection
// (snapshot.js). Rules/roster reload from data by version, not persisted inline.
// PURE.

import { prepareEconomy } from './world.js';

export function serializeWorld(world) {
  return JSON.parse(JSON.stringify({
    seed: world.seed,
    rngStreams: world.rngStreams,
    simTime: world.simTime,
    tick: world.tick,
    _repDay: world._repDay,
    _eventDay: world._eventDay,
    _blocState: world._blocState,
    _evCd: world._evCd,
    _govDay: world._govDay,
    _devDay: world._devDay,
    _contractDay: world._contractDay,
    _havenDay: world._havenDay,
    _evSeq: world._evSeq,
    events: world.events,
    wind: world.wind,
    season: world.season,
    storms: world.storms,
    _weatherDay: world._weatherDay,
    _stormSeq: world._stormSeq,
    speed: world.speed,
    paused: world.paused,
    controls: world.controls,
    mapW: world.mapW,
    mapH: world.mapH,
    nextEntityId: world.nextEntityId,
    agents: world.agents,
    intents: world.intents,
    totals: world.totals,
    islands: world.islands,
    ships: world.ships,
  }));
}

/** Rebuild a live world from serialized state + the (current) economy definition. */
export function deserializeWorld(data, economy) {
  prepareEconomy(economy);
  const d = JSON.parse(JSON.stringify(data));
  return {
    seed: d.seed,
    rngStreams: d.rngStreams,
    simTime: d.simTime,
    tick: d.tick,
    _repDay: d._repDay,
    _eventDay: d._eventDay,
    _blocState: d._blocState || {},
    _evCd: d._evCd || {},
    _govDay: d._govDay,
    _devDay: d._devDay,
    _contractDay: d._contractDay,
    _havenDay: d._havenDay,
    _evSeq: d._evSeq || 0,
    events: d.events || [],
    wind: d.wind,
    season: d.season,
    storms: d.storms || [],
    _weatherDay: d._weatherDay,
    _stormSeq: d._stormSeq || 0,
    mapW: d.mapW,
    mapH: d.mapH,
    speed: d.speed,
    paused: d.paused,
    dtSim: 0,
    controls: d.controls,
    rules: economy.tuning,
    economy,
    agents: d.agents,
    intents: d.intents,
    nextEntityId: d.nextEntityId,
    islands: d.islands,
    islandsById: new Map(d.islands.map((i) => [i.id, i])),
    ships: d.ships,
    spatialIndex: null,
    totals: d.totals,
  };
}
