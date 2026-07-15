// BOATZ client/engine wiring — the ONLY game numbers here are presentation + input.
// The economy definition and all sim tuning live in data/economy.json + data/islands.json
// (loaded by the server), so balance is data, not code.

// Must match data/islands.json "ocean".
export const OCEAN = { width: 9600, height: 6800 };

// Stylized nautical-chart palette: a painterly depth-ramped sea, sandy relief-shaded
// isles, and an ink-on-teal HUD echoing the hand-inked captain portraits. Existing key
// names are preserved (widely imported) so the restyle is additive, not breaking.
export const PALETTE = {
  // ── Water: painterly depth ramp (open sea → island shallows) ──
  seaAbyss: '#0a4a5e',    // screen-edge / deepest vignette
  seaDeep: '#0e6379',     // open-sea base
  seaMid: '#1789a6',      // sunlit mid-water band
  seaShallow: '#5fd0e0',  // near-island shallows
  seaGlint: '#bfeeff',    // sun-glitter speck
  deepWater: '#0e6379',   // canvas clear (open sea) — re-pointed to seaDeep
  shallow: '#5fd0e0',     // alias — near-island shallows tint
  foam: '#eafaff',
  foamShadow: 'rgba(8, 60, 74, 0.28)',
  // ── Ink linework (echoes the captain portraits) ──
  ink: '#06333d',
  inkSoft: 'rgba(6, 51, 61, 0.32)',
  // ── Land: painted fills + relief ──
  beachWet: '#e6c78c',    // damp waterline sand
  beachDry: '#f4e0b0',    // upper beach (was flat #f2ddaa)
  grassRim: '#a9d97a',    // sunlit rim light
  grassShade: '#4f7d43',  // interior / far-slope shadow
  // ── HUD text over bright water (unchanged — world labels/rings depend on these) ──
  hud: '#08313b',
  hudDim: '#2e6b78',
  // ── Panels / chart frames / parchment ──
  panelBg: 'rgba(6, 38, 46, 0.90)',
  panelEdge: 'rgba(180, 240, 255, 0.28)',
  panelInk: 'rgba(5, 20, 25, 0.55)',       // inner hairline of the chart frame
  panelInset: 'rgba(255, 255, 255, 0.06)', // badge/chip/banner fills (was inlined)
  panelTrack: 'rgba(255, 255, 255, 0.10)', // gauge track (was inlined)
  panelText: '#eaf7fb',
  panelDim: '#8fc6d4',
  parchment: '#f2ead2',
  parchmentDim: '#e2d5b0',
  scrollThumb: 'rgba(180, 220, 235, 0.34)',// ScrollBox thumb (was inlined)
  // ── Accents / semantic ──
  accent: '#ffd166',      // gold accent (unchanged)
  accentDim: '#c8a24a',
  good: '#8ee6a0',
  bad: '#ff7b6b',
  warn: '#e0b24a',
  selection: '#fff2b0',   // world selection rings (unchanged)
  // ── Faction inks ──
  pirate: '#e04a5a',
  pirateDeep: '#7a1420',
  privateer: '#6fa8d8',
};

// Bump when PALETTE changes so SpriteCache keys (island relief, icon tiles) invalidate.
export const PALETTE_VERSION = 2;

// Sea surface (SeaRenderer): screen-space depth gradient + a wind-driven crest field.
// Wave work is skipped below WAVE_MIN_ZOOM (ships are LOD dots out there), so the overview
// stays free. All px are logical/screen — cost is independent of ocean size + island count.
export const SEA = {
  WAVE_MIN_ZOOM: 0.3,   // matches WAKE_MIN_ZOOM; below → gradient + glitter only
  WAVE_CELL: 92,        // px grid spacing of crest strokes (screen space)
  WAVE_LEN: 30,         // crest stroke length px
  WAVE_DRIFT: 16,       // px/s drift along the wind at full strength
  WAVE_ALPHA: 0.30,     // base crest alpha
  atmosphere: true,     // subtle season tint + storm overcast
};

// Parallax "sea sparkle" layers (drifting foam/light specks over the turquoise base),
// passed straight to the engine BackgroundRenderer. Bright, gentle.
// Sun-glitter over the deeper water — fewer, brighter, lower-opacity glints (glitter, not
// snow). Drawn by the engine BackgroundRenderer, now on top of SeaRenderer's gradient + waves.
export const OCEAN_LAYERS = [
  { parallax: 0.25, tileSize: 512, count: 22, sizeMin: 1.0, sizeMax: 2.2, color: '150, 225, 240', opacityMin: 0.05, opacityMax: 0.12, driftSpeed: 0.5, pulseSpeed: 0.0006 },
  { parallax: 0.55, tileSize: 512, count: 16, sizeMin: 1.4, sizeMax: 3.0, color: '200, 240, 255', opacityMin: 0.06, opacityMax: 0.16, driftSpeed: 0.9, pulseSpeed: 0.0011 },
  { parallax: 0.85, tileSize: 512, count: 10, sizeMin: 1.8, sizeMax: 4.0, color: '235, 250, 255', opacityMin: 0.08, opacityMax: 0.22, driftSpeed: 1.4, pulseSpeed: 0.0015 },
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
export const WAKE_MIN_ZOOM = 0.3;   // below this zoom, ships draw as LOD dots — wakes are invisible clutter, so skip them
