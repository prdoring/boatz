// BOATZ client/engine wiring — the ONLY game numbers here are presentation + input.
// The economy definition and all sim tuning live in data/economy.json + data/islands.json
// (loaded by the server), so balance is data, not code.

// Must match data/islands.json "ocean".
export const OCEAN = { width: 9600, height: 6800 };

// Bright stylized daytime palette: turquoise sea, sandy isles, ink HUD.
export const PALETTE = {
  deepWater: '#1aa3c4',   // canvas clear (open sea)
  shallow: '#5fd0e0',     // near-island shallows tint
  foam: '#eafaff',
  hud: '#08313b',         // dark ink text over bright water
  hudDim: '#2e6b78',
  panelBg: 'rgba(7, 46, 56, 0.88)',
  panelEdge: 'rgba(180, 240, 255, 0.25)',
  panelText: '#eaf7fb',
  panelDim: '#8fc6d4',
  accent: '#ffd166',      // gold accent
  good: '#8ee6a0',
  bad: '#ff7b6b',
  selection: '#fff2b0',
};

// Parallax "sea sparkle" layers (drifting foam/light specks over the turquoise base),
// passed straight to the engine BackgroundRenderer. Bright, gentle.
export const OCEAN_LAYERS = [
  { parallax: 0.25, tileSize: 512, count: 30, sizeMin: 1.0, sizeMax: 2.5, color: '120, 210, 230', opacityMin: 0.06, opacityMax: 0.16, driftSpeed: 0.5, pulseSpeed: 0.0006 },
  { parallax: 0.55, tileSize: 512, count: 22, sizeMin: 1.5, sizeMax: 3.5, color: '210, 245, 255', opacityMin: 0.08, opacityMax: 0.20, driftSpeed: 0.9, pulseSpeed: 0.0010 },
  { parallax: 0.85, tileSize: 512, count: 14, sizeMin: 2.0, sizeMax: 4.5, color: '255, 255, 255', opacityMin: 0.10, opacityMax: 0.26, driftSpeed: 1.4, pulseSpeed: 0.0014 },
];

export const CAMERA = { minZoom: 0.06, maxZoom: 2.5 }; // low enough to fit the whole 9600x6800 ocean
export const ZOOM_STEP = 1.12;      // per wheel notch
export const PAN_SPEED = 800;       // px/sec at zoom 1
export const ISLAND_HIT = 70;       // world-radius for clicking an island
export const SHIP_HIT = 22;         // world-radius for clicking a ship
export const RENDER_DELAY = 150;    // ms interpolation buffer (~1.5x the 100ms ship stream)
export const ISLAND_RADIUS = 58;    // draw radius for islands
export const SHIP_RADIUS = 15;      // draw radius for ships
export const WAKE_EVERY = 3;        // emit a wake trail point every N frames per ship
