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

// Per-kind display colour. DARKENED for legibility on cream parchment (hues preserved; the old
// pastel values were tuned for a dark panel). Single source: InfoPanel + news crawl + Almanac.
export const EVENT_COLOR = {
  blight: '#b5601e', plague: '#8a3ca5', wreck: '#566b78', recover: '#2f7d45',
  mutiny: '#b23a2e', defect: '#b5601e', quell: '#2f7d45', unrest: '#9a6b1f', starve: '#a2382a',
  launch: '#1f7f8c', migrate: '#a83f6e', famine: '#a8601a', boom: '#9a7d16', ally: '#2f7d45', rival: '#b5601e',
  rebellion: '#b0342a', overthrow: '#b8442a', quellReb: '#2f7d45',
  pirate: '#b23a2e', plunder: '#a83828', fended: '#2f7d45', raid: '#b8442a', raidfail: '#2f7d45',
  bounty: '#9a7d16', privateer: '#3a6ea5', hunted: '#2f7d45', hunterlost: '#b5601e', standdown: '#566b78',
  aid: '#2d8060', rescue: '#2d8060', betray: '#b0342a', embargo: '#b5601e',
  contract: '#97781a', contractdone: '#2f7d45',
  storm: '#4a5a78', stormloss: '#566b78', season: '#5f47a0', adrift: '#566b78', bearings: '#2f7d45',
  ambition: '#97781a', overreach: '#b5601e',
  haven: '#9a2028', redeemed: '#2f7d45', assault: '#b06a1a', battery: '#b5731a',
  lost: '#566b78', shun: '#b5601e', reroute: '#1f7f8c',
  brokeoff: '#566b78', sunk: '#9a2028', refit: '#2f7d45', refitshort: '#b5601e',
  prize: '#96601e', recovered: '#2f7d45',
  maiden: '#1f7f8c', voyages: '#1f7f8c', goldenage: '#9a7d16', popmilestone: '#1f7f8c', longpeace: '#2f7d45',
  promotion: '#3a5f9a', neworder: '#5f47a0',
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
