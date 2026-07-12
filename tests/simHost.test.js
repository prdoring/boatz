import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { attachSimServer } from '../server/simHost.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Footgun #1 guard: server/simHost.js + its whole relative graph (engine/net,
// game/sim, game/protocol, data JSON) must load under BARE node — no test loader —
// exactly like `npm start`. A stray /engine/ specifier would fail here.
test('simHost + sim graph load under bare node (npm start path)', () => {
  const code = "import('./server/simHost.js')"
    + ".then(m => process.exit(typeof m.attachSimServer === 'function' ? 0 : 2))"
    + ".catch(e => { console.error(e); process.exit(1); });";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `bare-node load failed:\n${r.stderr}`);
});

test('server streams WELCOME + snapshots and accepts gated SET_SPEED', async () => {
  const server = http.createServer();
  const sim = attachSimServer(server, { tickMs: 20, rosterSeed: 1 }); // pin the sea for a deterministic test
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  const seen = new Set();
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      seen.add(m.type);
      if (m.type === 'WELCOME') {
        assert.equal(m.protocolVersion, 1);
        assert.ok(m.clientId >= 1);
        assert.ok(Array.isArray(m.layout) && m.layout.length === 60);
      }
      if (seen.has('WELCOME') && seen.has('STATE_SHIPS') && seen.has('STATE_ECON')) resolve();
    });
  });

  ws.send(JSON.stringify({ type: 'SET_SPEED', speed: 3, paused: false }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sim.world.speed, 3, 'SET_SPEED should change speed');

  // Gated: when time-scale control is disabled, SET_SPEED is ignored.
  sim.world.controls.allowTimeScale = false;
  ws.send(JSON.stringify({ type: 'SET_SPEED', speed: 10 }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sim.world.speed, 3, 'SET_SPEED must be ignored when gated');

  ws.close();
  sim.stop();
  await new Promise((r) => server.close(r));
});
