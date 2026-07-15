// Shot render seam — the GAME half of the engine shot harness (engine/harness/runShots).
// The engine calls renderShot(ctx, shot, env) per declared shot; this builds a headless
// copy of the render services (no audio, no Game loop, no RAF, no socket), HYDRATES a real
// SimClient's store from the OPAQUE shot.state, and reuses SimScene's real update()+render()
// so shots render through the exact seam gameplay uses and can't drift. The SimClient is
// never connected — new SimClient() opens no socket; we push snapshots into it directly.

import { Camera } from '/engine/core/Camera.js';
import { EffectsManager } from '/engine/fx/EffectsManager.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { BackgroundRenderer } from '/engine/render/BackgroundRenderer.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { setEffectResolver } from '/engine/render/ArtInterpreter.js';

setEffectResolver((id) => VFX_DEFS[id]);

import islandArt from '/data/island-art.json' with { type: 'json' };
import shipArt from '/data/ship-art.json' with { type: 'json' };

import { WorldRenderer } from './WorldRenderer.js';
import { SeaRenderer } from './SeaRenderer.js';
import { SimClient } from './SimClient.js';
import { SimScene } from './scenes/SimScene.js';
import { CAMERA, PALETTE, OCEAN_LAYERS } from './config.js';

const DEFAULT_RAW = ['Grain', 'Wood', 'Meat', 'Fiber', 'Iron', 'PreciousMetal'];
const DEFAULT_GOODS = ['Food', 'Ale', 'Clothing', 'Weapons', 'LuxuryGoods', 'Ships'];

// Headless `shared`, mirroring the render-relevant half of game/main.js. `view` is a
// plain LOGICAL {width,height} object (the ctx is already DPR-scaled by the runner).
function buildShared(ctx, env) {
  const view = { width: env.width, height: env.height };
  const camera = new Camera(view, { minZoom: CAMERA.minZoom, maxZoom: CAMERA.maxZoom });
  const effects = new EffectsManager();
  const effectsRenderer = new EffectsRenderer(ctx, camera);
  const art = buildArtRegistry({ islands: islandArt, ships: shipArt });
  const worldRenderer = new WorldRenderer(ctx, camera, art, VFX_DEFS, effectsRenderer);
  // Glitter needs a canvas with width/height + getContext; the harness only has `view` + ctx,
  // so hand BackgroundRenderer a shim pointing at the real shot ctx (logical px is fine here).
  const bgCanvas = { width: env.width, height: env.height, getContext: () => ctx };
  const background = new BackgroundRenderer(camera, bgCanvas, OCEAN_LAYERS);
  const sea = new SeaRenderer(camera, ctx, background);
  return { canvas: view, ctx, camera, effects, effectsRenderer, art, worldRenderer, sea, VFX_DEFS };
}

/** Engine seam: draw one shot to `ctx`. `env = { now, width, height, dpr }` (logical px). */
export function renderShot(ctx, shot, env) {
  if (shot.scene !== 'sim') throw new Error(`shots: unknown scene "${shot.scene}" for shot "${shot.id}"`);
  // The live Game fills the turquoise sea via clearColor; the shot harness doesn't run
  // Game, so paint the ocean here too or shots would render on bare canvas.
  ctx.fillStyle = PALETTE.deepWater;
  ctx.fillRect(0, 0, env.width, env.height);
  const shared = buildShared(ctx, env);
  // Explicit url so NetworkClient's constructor never touches `location` (absent in
  // Node). The socket is never opened here — we push snapshots into the client directly.
  const sim = new SimClient({ url: 'ws://127.0.0.1:0' });
  const state = shot.state || {};
  hydrateSim(sim, state, env);
  shared.sim = sim;

  const scene = new SimScene(shared);

  // Camera: explicit per-shot, else fit the archipelago.
  const cam = state.camera || {};
  shared.camera.x = cam.x ?? sim.mapW / 2;
  shared.camera.y = cam.y ?? sim.mapH / 2;
  shared.camera.setZoom(cam.zoom ?? 0.4);

  if (state.select) sim.select(state.select.kind, state.select.id);

  // Run the real update()+render() (NOT enter(), which would connect the socket).
  scene.update(env.now);
  scene.render(env.now);
}

// Populate a SimClient's store from opaque shot.state without touching the network:
// islands merge-by-id, one ship snapshot pushed into the interpolation buffer.
function hydrateSim(sim, state, env) {
  sim.status = 'live';
  sim.goods = state.goods || DEFAULT_GOODS;
  sim.raw = state.raw || DEFAULT_RAW;
  if (state.mapW) sim.mapW = state.mapW;
  if (state.mapH) sim.mapH = state.mapH;
  for (const isl of (state.islands || [])) sim._mergeIsland(isl);
  sim.economy = state.economy || { totalGold: 0, shipCount: Object.keys(state.ships || {}).length };
  sim.events = state.events || [];
  sim.clock = {
    simTime: state.simTime || 0, speed: state.speed || 1,
    paused: !!state.paused, dayLength: state.dayLength || 60,
  };
  sim.buffer.push(
    { entities: state.ships || {}, simTime: sim.clock.simTime, speed: sim.clock.speed, paused: sim.clock.paused },
    env.now,
  );
}
