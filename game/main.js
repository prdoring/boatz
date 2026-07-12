// BOATZ — browser bootstrap. Wires engine render/audio services to the sim client
// and the map scene. The browser NEVER simulates: shared.sim (SimClient) streams the
// authoritative world over WebSocket; the scene renders interpolated snapshots.
import { Game } from '/engine/core/Game.js';
import { Camera } from '/engine/core/Camera.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import { BackgroundRenderer } from '/engine/render/BackgroundRenderer.js';
import { EffectsManager } from '/engine/fx/EffectsManager.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { setEffectResolver } from '/engine/render/ArtInterpreter.js';

// Art `effectRef` shapes (e.g. a ship's bow spray) resolve to VFX effects by id.
setEffectResolver((id) => VFX_DEFS[id]);

import islandArt from '/data/island-art.json' with { type: 'json' };
import shipArt from '/data/ship-art.json' with { type: 'json' };
import portraitArt from '/data/portrait-art.json' with { type: 'json' };

import { WorldRenderer } from './WorldRenderer.js';
import { PortraitRenderer } from './PortraitRenderer.js';
import { SimClient } from './SimClient.js';
import { SimScene } from './scenes/SimScene.js';
import { PALETTE, OCEAN_LAYERS, CAMERA } from './config.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const camera = new Camera(canvas, { minZoom: CAMERA.minZoom, maxZoom: CAMERA.maxZoom });
const sound = new SoundManager();                 // for the volume overlay + future ambience
const background = new BackgroundRenderer(camera, canvas, OCEAN_LAYERS); // turquoise sea sparkle
const effects = new EffectsManager();
const effectsRenderer = new EffectsRenderer(ctx, camera);
const art = buildArtRegistry({ islands: islandArt, ships: shipArt });
const worldRenderer = new WorldRenderer(ctx, camera, art, VFX_DEFS, effectsRenderer);
const portraits = new PortraitRenderer(portraitArt); // captain head-and-shoulders portraits

const game = new Game({ canvas, sound, background, clearColor: PALETTE.deepWater });
const sim = new SimClient();

const shared = {
  canvas, ctx, camera, sound, effects, effectsRenderer,
  worldRenderer, portraits, art, VFX_DEFS, game, sim,
};

const simScene = new SimScene(shared);
shared.scenes = { sim: simScene };

game.start(simScene);
