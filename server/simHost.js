// Server-only wiring: WebSocket transport + the fixed-tick authoritative sim.
// RELATIVE engine specifiers (runs under bare `node server/main.js`, no loader).
// Kept as pure transport — the world + systems come from game/sim/*, so no game
// noun lives in server/.
import { WebSocketServer } from 'ws';
import { ServerLoop } from '../engine/net/ServerLoop.js';
import { serialize, deserialize } from '../engine/net/protocol.js';
import { M, SPEEDS, PROTOCOL_VERSION } from '../game/protocol.js';
import { buildWorld, stepWorld, worldTotals } from '../game/sim/world.js';
import { snapshotShips, snapshotEconomy, snapshotLayout, windSnapshot } from '../game/sim/snapshot.js';
import { generateRoster } from '../game/sim/roster.js';
import economyRaw from '../data/economy.json' with { type: 'json' };

const TICK_MS = 50;             // 20 Hz real tick
const SHIP_EVERY = 2;          // ships every 2 ticks -> ~10 Hz
const ECON_EVERY = 20;         // economy every 20 ticks -> ~1 Hz
const HEARTBEAT_MS = 15000;
const MAX_BUFFERED = 512 * 1024; // drop a snapshot for a client backed up past this

export function attachSimServer(server, { tickMs = TICK_MS, seed = 0xB0A7, rosterSeed } = {}) {
  // A fresh sea of islands every boot (unless a rosterSeed is pinned, e.g. in tests).
  const rSeed = (rosterSeed != null ? rosterSeed : (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  const roster = generateRoster(rSeed);
  const world = buildWorld({ economy: structuredClone(economyRaw), roster, seed });
  world.rosterSeed = rSeed; // recorded so a specific sea can be reproduced
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  let nextClientId = 1;

  // Clock system (first): real-dt * speed -> world.dtSim (0 when paused). Sim system:
  // advance in fixed substeps (stepWorld) — identical dynamics at every speed.
  const clock = { update(w, dt) { w.dtSim = w.paused ? 0 : dt * w.speed; } };
  const sim = { update(w, dt, tick) { stepWorld(w, w.dtSim, tick); w.totals = worldTotals(w); } };

  const loop = new ServerLoop({ state: world, tickMs, broadcast });
  loop.addSystem(clock);
  loop.addSystem(sim);

  function shipsMessage(tick) {
    // AOI seam: to cull per client later, build entities from a client's viewport
    // here (snapshotShips is id-keyed, so a subset is a valid message). Pass 1
    // serializes ONE global snapshot for all clients.
    return serialize({
      type: M.STATE_SHIPS, tick, full: true, sentAt: Date.now(),
      simTime: world.simTime, speed: world.speed, paused: world.paused,
      wind: windSnapshot(world),
      entities: snapshotShips(world),
    });
  }
  function econMessage(tick) {
    return serialize({ type: M.STATE_ECON, tick, ...snapshotEconomy(world) });
  }

  function sendThrottled(ws, msg) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return; // slow client: skip stale state, no backlog
    ws.send(msg);
  }

  function broadcast(w, tick) {
    if (tick % SHIP_EVERY === 0) {
      const msg = shipsMessage(tick);
      for (const ws of wss.clients) sendThrottled(ws, msg);
    }
    if (tick % ECON_EVERY === 0) {
      const msg = econMessage(tick);
      for (const ws of wss.clients) sendThrottled(ws, msg);
    }
  }

  function sendNow(ws, obj) { if (ws.readyState === 1) ws.send(serialize(obj)); }

  wss.on('connection', (ws) => {
    ws.clientId = nextClientId++;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Full initial sync (also covers reconnect — no client re-request needed).
    sendNow(ws, {
      type: M.WELCOME, protocolVersion: PROTOCOL_VERSION, clientId: ws.clientId, tickMs,
      mapW: world.mapW, mapH: world.mapH,
      raw: world.economy.raw, goods: world.economy.goods,
      dayLength: world.rules.SIM_DAY_SECONDS,
      layout: snapshotLayout(world), shipInterval: tickMs * SHIP_EVERY,
    });
    sendNow(ws, { type: M.STATE_ECON, tick: loop.tick, ...snapshotEconomy(world) });
    sendNow(ws, {
      type: M.STATE_SHIPS, tick: loop.tick, full: true, sentAt: Date.now(),
      simTime: world.simTime, speed: world.speed, paused: world.paused,
      wind: windSnapshot(world),
      entities: snapshotShips(world),
    });
    ws.on('message', (data) => {
      let msg; try { msg = deserialize(data); } catch { return; }
      handleClientMessage(world, msg);
    });
  });

  // Heartbeat: drop half-open sockets so they don't accumulate (browsers auto-pong).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);

  loop.start();

  return {
    world, wss, loop,
    stop() {
      loop.stop();
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

/** The only authoritative mutation a viewer can request in pass 1: the clock. */
function handleClientMessage(world, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === M.SET_SPEED) {
    if (!world.controls.allowTimeScale) return; // observer/admin capability
    if (typeof msg.paused === 'boolean') world.paused = msg.paused;
    if (SPEEDS.includes(msg.speed)) world.speed = msg.speed;
  }
  // M.SET_VIEW reserved for AOI — validated & ignored in pass 1.
}
