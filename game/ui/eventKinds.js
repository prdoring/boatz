// Shared event-kind metadata for the history UI (Story tab + NewsPanel). One source of truth for
// which broad CATEGORY each sim event kind belongs to, so category filter chips read the same way in
// both places. The per-kind display COLOURS live with each panel (they predate this); this module is
// only about grouping.

// kind → category. Anything unmapped falls under 'other' (shown only under the "All" filter).
export const EVENT_CATEGORY = {
  // War — piracy, hunts, havens, the violence of the sea
  pirate: 'war', plunder: 'war', raid: 'war', raidfail: 'war', fended: 'war',
  bounty: 'war', privateer: 'war', hunted: 'war', hunterlost: 'war', standdown: 'war',
  haven: 'war', assault: 'war', redeemed: 'war', battery: 'war', brokeoff: 'war', sunk: 'war',
  prize: 'war', recovered: 'war',
  // Trade — economy, prosperity, diplomacy, the movement of goods & people
  ally: 'trade', rival: 'trade', betray: 'trade', embargo: 'trade', aid: 'trade', rescue: 'trade',
  boom: 'trade', launch: 'trade', migrate: 'trade', reroute: 'trade', shun: 'trade',
  lost: 'trade', contract: 'trade', contractdone: 'trade', refit: 'trade', refitshort: 'trade',
  maiden: 'trade', voyages: 'trade', goldenage: 'trade', popmilestone: 'trade', longpeace: 'trade',
  // Rule — governance, loyalty, crews, uprisings
  mutiny: 'rule', defect: 'rule', quell: 'rule', unrest: 'rule',
  rebellion: 'rule', overthrow: 'rule', quellReb: 'rule', ambition: 'rule', overreach: 'rule',
  promotion: 'rule', neworder: 'rule',
  // Doom — nature and disaster
  blight: 'doom', plague: 'doom', recover: 'doom', wreck: 'doom', starve: 'doom',
  famine: 'doom', storm: 'doom', stormloss: 'doom', season: 'doom', adrift: 'doom', bearings: 'doom',
};

/** The filter chips, in order. 'all' passes everything; the rest match EVENT_CATEGORY. */
export const STORY_CATEGORIES = [
  { key: 'all',   label: 'All' },
  { key: 'war',   label: 'War' },
  { key: 'trade', label: 'Trade' },
  { key: 'rule',  label: 'Rule' },
  { key: 'doom',  label: 'Doom' },
];

// Per-kind display colour (shared by the news crawl + history browser; mirrors InfoPanel's table).
export const EVENT_COLOR = {
  blight: '#ec8a3a', plague: '#c072e0', wreck: '#8fb6c6', recover: '#8ee6a0',
  mutiny: '#ff5b4a', defect: '#e0863a', quell: '#8ee6a0', unrest: '#e0b24a', starve: '#c0503a',
  launch: '#6fd0e0', migrate: '#f2b8d0', famine: '#d98a3a', boom: '#ffd166', ally: '#8ee6a0', rival: '#e0863a',
  rebellion: '#ff5b30', overthrow: '#ff7b4a', quellReb: '#8ee6a0',
  pirate: '#ff5b4a', plunder: '#e0503a', fended: '#8ee6a0', raid: '#ff7b4a', raidfail: '#8ee6a0',
  bounty: '#ffd166', privateer: '#6fa8d8', hunted: '#8ee6a0', hunterlost: '#e0863a', standdown: '#8fb6c6',
  aid: '#7fe0b0', rescue: '#7fe0b0', betray: '#ff5b30', embargo: '#e0863a',
  contract: '#e8c15a', contractdone: '#8ee6a0',
  storm: '#9fb2cc', stormloss: '#8fb6c6', season: '#c8b3ff', adrift: '#8fb6c6', bearings: '#8ee6a0',
  ambition: '#e8c15a', overreach: '#e0863a',
  haven: '#b0242e', redeemed: '#8ee6a0', assault: '#e0a24a', battery: '#ffb04a',
  lost: '#8fb6c6', shun: '#e0863a', reroute: '#6fd0e0',
  brokeoff: '#8fb6c6', sunk: '#b0242e', refit: '#8ee6a0', refitshort: '#e0863a',
  prize: '#c58a3a', recovered: '#8ee6a0',
  maiden: '#6fd0e0', voyages: '#6fd0e0', goldenage: '#ffd166', popmilestone: '#7fd0e0', longpeace: '#8ee6a0',
  promotion: '#9db8ff', neworder: '#c8b3ff',
};

export function categoryOf(kind) { return EVENT_CATEGORY[kind] || 'other'; }

/** Is this a HEADLINE event (shown in the collapsed news crawl), vs a low-tier 'log' BEAT that enriches
 *  an entity's Story tab but stays out of the crawl? Legacy events (no `tier`) are headlines. The tier
 *  rides the live event record only; the durable chronicle and per-entity Story show every tier. */
export function isHeadline(e) { return !e || e.tier == null || e.tier === 'news'; }

/** The display colour for an event kind (the single source; callers pass a fallback). */
export function eventColor(kind, fallback = '#8fc6d4') { return EVENT_COLOR[kind] || fallback; }

/** Filter a chronicle to one category ('all' → unchanged). */
export function filterByCategory(entries, cat) {
  if (!cat || cat === 'all') return entries;
  return entries.filter((e) => categoryOf(e.kind) === cat);
}

// ─── Icon vocabulary (names resolved by game/ui/icons.js) ───────────────────
// One shared kind→icon mapping so the news crawl, the expanded browser, and the Story
// vital-stats all draw the same glyph for a given event. Specific kinds override; the rest
// fall back to a per-category default. Names must exist in the icons.js registry.
const CATEGORY_ICON = { war: 'sabres', trade: 'coin', rule: 'flame', doom: 'storm', other: 'scroll' };
const KIND_ICON = {
  pirate: 'skull', plunder: 'skull', raid: 'skull', hunterlost: 'skull', haven: 'skull', plague: 'skull',
  fended: 'shield', standdown: 'shield', quell: 'shield', quellReb: 'shield', recover: 'shield',
  raidfail: 'sabres', hunted: 'sabres', bounty: 'sabres', privateer: 'sabres', assault: 'sabres', redeemed: 'sabres', battery: 'sabres',
  sunk: 'skull', brokeoff: 'chevronDown', prize: 'skull', recovered: 'shield',
  ally: 'chevronUp', rival: 'chevronDown', betray: 'chevronDown',
  boom: 'spark', goldenage: 'spark', ambition: 'coin', aid: 'coin', rescue: 'shield',
  maiden: 'anchor', voyages: 'anchor', popmilestone: 'chevronUp', longpeace: 'shield',
  promotion: 'chevronUp', neworder: 'pennant',
  launch: 'anchor', migrate: 'anchor', lost: 'anchor', wreck: 'anchor', reroute: 'caret', refit: 'anchor', refitshort: 'warning',
  contract: 'scroll', contractdone: 'scroll',
  mutiny: 'flame', defect: 'flame', rebellion: 'flame', overthrow: 'flame',
  unrest: 'warning', overreach: 'warning', embargo: 'warning', shun: 'warning',
  blight: 'wheat', starve: 'wheat', famine: 'wheat',
  storm: 'storm', stormloss: 'storm', season: 'sun', adrift: 'anchor', bearings: 'map',
};
export function eventIcon(kind) { return KIND_ICON[kind] || CATEGORY_ICON[categoryOf(kind)]; }

const SEASON_ICON_NAME = { Spring: 'sprout', Summer: 'sun', Autumn: 'leaf', Winter: 'snowflake' };
export function seasonIcon(name) { return SEASON_ICON_NAME[name] || 'sun'; }
