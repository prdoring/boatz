// Shared wire protocol — imported by BOTH the server (server/simHost.js, via a
// relative path) and the browser client (game/main.js, via /game/protocol.js).
// RELATIVE engine specifier so it resolves under bare `node`, the browser, and tests.
//
// Long-term contract: the authoritative sim runs at 1x wall-clock in multiplayer;
// SET_SPEED (pause / fast-forward) is an OBSERVER/ADMIN affordance, gated server-side
// by world.controls.allowTimeScale. Persistence/event time derives from wall-clock,
// not simTime.
import { defineMessageTypes } from '../engine/net/protocol.js';

export const M = defineMessageTypes(
  'WELCOME',      // S->C on connect: { protocolVersion, clientId, tickMs, mapW, mapH, goods, layout, shipInterval }
  'STATE_SHIPS',  // S->C ~10Hz HOT:  { tick, full, sentAt, simTime, speed, paused, entities:{id:{x,y,heading,state,type,pirate,privateer}} }
  'STATE_SHIPS_COLD', // S->C ~1Hz:   { tick, entities:{id:{captain,log,route,cargo,...}} } — panel/slow bulk, merged by id
  'STATE_ECON',   // S->C ~1Hz:       { tick, islands:[...], economy:{...} }
  'SET_SPEED',    // C->S:            { speed?, paused? }  (gated by allowTimeScale)
  'SET_VIEW',     // C->S (reserved): { x, y, w, h, zoom } — AOI viewport, unused in pass 1
);

export const SPEEDS = Object.freeze([0.5, 1, 3, 10, 20]);
export const PROTOCOL_VERSION = 1;
