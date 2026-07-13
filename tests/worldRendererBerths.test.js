// Docked-ship berths (WorldRenderer._computeBerths): a port's moored fleet must fan into a ring of
// berths around the island — not stack unclickably on its centre. The subtle trap this guards: the
// CLIENT stream carries DISPLAY states (snapshot.js displayState), so a ship trading at a stop reads
// 'docked', NOT the sim's 'trading' — the berth test must match the wire vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldRenderer } from '/game/WorldRenderer.js';

function renderer() {
  const camera = { getZoom: () => 1, worldToScreen: (x, y) => ({ sx: x, sy: y }) };
  return new WorldRenderer({}, camera, { ships: {} }, {}, {}); // _computeBerths uses only _berths + islandRadius
}
const distTo = (b, x, y) => Math.hypot(b.x - x, b.y - y);

test('idle AND docked ships berth off their island; sailing ships never do', () => {
  const wr = renderer();
  const islands = new Map([
    ['home', { id: 'home', x: 1000, y: 1000, k: 130 }],
    ['stop', { id: 'stop', x: 5000, y: 5000, k: 130 }],
  ]);
  const ships = {
    a: { x: 1000, y: 1000, state: 'idle', homeId: 'home' },   // idle at home
    b: { x: 1000, y: 1000, state: 'idle', homeId: 'home' },
    c: { x: 5000, y: 5000, state: 'docked', homeId: 'home' }, // trading at a FOREIGN stop (wire vocab)
    d: { x: 3000, y: 3000, state: 'sailing', homeId: 'home' },// under way
    p: { x: 1000, y: 1000, state: 'idle', homeId: 'home', pirate: true }, // faction hull — not moored
  };
  wr._computeBerths(ships, islands);

  for (const id of ['a', 'b', 'c']) assert.ok(wr._berths.get(id), `${id} should be berthed`);
  assert.ok(!wr._berths.get('d'), 'a sailing ship is not berthed');
  assert.ok(!wr._berths.get('p'), 'a pirate is not berthed');

  // Berths sit OFF the island centre (so they don't stack / are clickable), and the foreign-stop ship
  // berths at the STOP it's docked at (found by position), not its distant home.
  assert.ok(distTo(wr._berths.get('a'), 1000, 1000) > 10, 'idle berth is off centre');
  assert.ok(distTo(wr._berths.get('c'), 5000, 5000) > 10 && distTo(wr._berths.get('c'), 5000, 5000) < 400,
    'a ship trading away from home berths at the stop it is actually at');
  // Two ships at the same port get DISTINCT berths (no overlap).
  assert.ok(distTo(wr._berths.get('a'), wr._berths.get('b').x, wr._berths.get('b').y) > 10, 'berths do not coincide');
});

test('shipDisplayPos returns the berth for a docked ship, the live position otherwise', () => {
  const wr = renderer();
  const islands = new Map([['home', { id: 'home', x: 200, y: 200, k: 130 }]]);
  const ships = { a: { x: 200, y: 200, state: 'idle', homeId: 'home' }, s: { x: 900, y: 900, state: 'sailing', homeId: 'home' } };
  wr._computeBerths(ships, islands);
  const pa = wr.shipDisplayPos('a', ships.a);
  assert.ok(Math.hypot(pa.x - 200, pa.y - 200) > 10, 'docked ship reports its berth, not the wharf centre');
  const ps = wr.shipDisplayPos('s', ships.s);
  assert.deepEqual(ps, { x: 900, y: 900 }, 'a sailing ship reports its live position');
});
