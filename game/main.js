// BOATZ — browser bootstrap. Wires engine render/audio services to the sim client
// and the map scene. The browser NEVER simulates: shared.sim (SimClient) streams the
// authoritative world over WebSocket; the scene renders interpolated snapshots.
import { Game } from '/engine/core/Game.js';
import { Camera } from '/engine/core/Camera.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import { BackgroundRenderer } from '/engine/render/BackgroundRenderer.js';
import { EffectsManager } from '/engine/fx/EffectsManager.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { FXSequenceRunner } from '/engine/fx/FXSequenceRunner.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { setEffectResolver } from '/engine/render/ArtInterpreter.js';

// Art `effectRef` shapes (e.g. a ship's bow spray) resolve to VFX effects by id.
setEffectResolver((id) => VFX_DEFS[id]);

import islandArt from '/data/island-art.json' with { type: 'json' };
import shipArt from '/data/ship-art.json' with { type: 'json' };
import portraitArt from '/data/portrait-art.json' with { type: 'json' };

import { WorldRenderer } from './WorldRenderer.js';
import { SeaRenderer } from './SeaRenderer.js';
import { PortraitRenderer } from './PortraitRenderer.js';
import { SimClient } from './SimClient.js';
import { SimScene } from './scenes/SimScene.js';
import { loadVoices } from './voices.js';
import { PALETTE, OCEAN_LAYERS, CAMERA } from './config.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const camera = new Camera(canvas, { minZoom: CAMERA.minZoom, maxZoom: CAMERA.maxZoom });
const sound = new SoundManager();                 // for the volume overlay + future ambience
const background = new BackgroundRenderer(camera, canvas, OCEAN_LAYERS); // turquoise sea sparkle
const effects = new EffectsManager();
const effectsRenderer = new EffectsRenderer(ctx, camera);
// islandArt is registered for the art editor/preview only — the live map draws islands
// PROCEDURALLY (WorldRenderer.drawIsleTerrain), so it reacts to sim state a static asset can't.
const art = buildArtRegistry({ islands: islandArt, ships: shipArt });
const worldRenderer = new WorldRenderer(ctx, camera, art, VFX_DEFS, effectsRenderer);
const sea = new SeaRenderer(camera, ctx, background); // painterly water; owns the glitter now
const portraits = new PortraitRenderer(portraitArt); // captain head-and-shoulders portraits

// The sea (SeaRenderer) paints an opaque gradient inside the scene, so the engine background
// slot must NOT also draw the sparkle (it would be overpainted, and the glitter would vanish).
const game = new Game({ canvas, sound, clearColor: PALETTE.deepWater });
// Sound isn't finished, so hide the engine's auto-created volume overlay (top-right). `sound` STAYS
// wired (the FX pipeline + audio-resume both use it); Game._frame/_wireInput guard on this.volume,
// so nulling it simply drops the slider + its hit-testing. No engine edit.
game.volume = null;
const sim = new SimClient();

// Coordinated nautical FX (combat bursts, foundering ships, trade sparkles): the engine
// FXSequenceRunner fires data-authored `vfx` + `signal` steps. `onSignal` is snapshot-SAFE —
// it only writes to the scene's client presentation overlay (never mutates a snapshot / the sim).
const sequences = new FXSequenceRunner(sound, effects, (name, data, opts) => simScene.onFxSignal(name, data, opts));

// The per-keeper logbook writing styles for the Story tab (fail-soft; base-only if the folder is
// absent → the chronicler narrates in its legacy third-person voice). Awaited before the scene builds
// so the panel always has the catalogue in hand.
const voices = await loadVoices();

const shared = {
  canvas, ctx, camera, sound, effects, effectsRenderer,
  worldRenderer, sea, portraits, art, VFX_DEFS, sequences, game, sim, voices,
};

const simScene = new SimScene(shared);
shared.scenes = { sim: simScene };

// Rasterise the self-hosted HUD fonts before the first canvas draw — canvas text silently falls back
// to a system font if the face isn't ready (@font-face lives in index.html). Fail-soft: if a face
// can't load we still boot rather than hang.
await Promise.all([
  '400 16px "IM Fell English"', 'italic 16px "IM Fell English"', '400 16px "IM Fell English SC"',
  '400 16px "Caveat"', '400 16px "Kalam"', '400 16px "Shadows Into Light"',
  '400 16px "Patrick Hand"', '400 16px "Reenie Beanie"', '400 16px "Cedarville Cursive"',
].map((f) => document.fonts.load(f).catch(() => {})));
await document.fonts.ready;

game.start(simScene);

// Opt-in debug hook (append ?debug to the URL): exposes the live client for console inspection and
// automated UI checks. Off by default, so nothing leaks into a normal session.
if (new URLSearchParams(location.search).has('debug')) window.__boatz = { game, sim, scene: simScene, shared };
