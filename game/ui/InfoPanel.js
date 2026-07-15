// Right-docked inspector. Reads the ALREADY-RESOLVED selection (the scene resolves it
// by id each frame via shared.sim.getSelected) plus a context bag (goods order,
// islandsById, shipsById) to map ids → names. Never touches the network. Reads snapshot
// fields by the names the server projection emits (snapshot.js).
//
// A sectioned card: an island shows its prosperity state, population/civilization bars,
// treasury, what it makes, a colour-chipped market, its diplomatic RELATIONS (allies /
// rivals from reputation), and who's docked. A ship shows its status, errand, full
// multi-hop route with the current leg lit, a hold gauge, cargo, gold and ETA.

import { Panel, roundRect } from './UIStack.js';
import { ScrollBox } from './scroll.js';
import { STORY_CATEGORIES, filterByCategory, eventColor } from './eventKinds.js';
import { PALETTE } from '../config.js';
import { drawIcon } from './icons.js';
import { sectionHeading, inkRule } from './theme.js';
import { narrate } from './chronicle-narrate.js';
import VOICE from '/data/chronicle-voice.json' with { type: 'json' };

const W = 320;
const PAD = 16;

const GOAL = {
  food: { label: 'Importing food', color: '#ff9d5c' },
  migrate: { label: 'Carrying migrants', color: '#8fc6ff' },
  buyShip: { label: 'Buying a ship', color: '#c8a06a' },
  trade: { label: 'Trading', color: '#8ee6a0' },
  scout: { label: 'Scouting prices', color: '#c8b3ff' },
  aid: { label: 'Aid convoy for an ally', color: '#7fe0b0' },
};
const STATE = { idle: 'In port', sailing: 'Sailing', docked: 'Docked' };
const STATE_COLOR = { idle: '#9fb6bd', sailing: '#5fd0e0', docked: '#8fc6ff' };

// The ship's specific live ACTION (snapshot.js `act`/`actId`), turned into a plain-language line with the
// island/ship it concerns resolved by name — so a pirate reads "Blockading Ironpeak", a privateer
// "Assaulting Skullport", a merchant "Fleeing to Havenrock", rather than a bare "Sailing"/"Pirate".
const ACT = {
  blockade:  (n) => n ? `Blockading ${n}` : 'Blockading a port',
  hunt:      (n) => n ? `Hunting ${n}` : 'Hunting for prey',
  raid:      (n) => n ? `Raiding ${n}` : 'Raiding a port',
  resupply:  (n) => n ? `Making for ${n} to resupply` : 'Running low — resupplying',
  defend:    (n) => n ? `Defending ${n}` : 'Defending the haven',
  assault:   (n) => n ? `Assaulting ${n}` : 'Assaulting a haven',
  patrol:    (n) => n ? `Patrolling off ${n}` : 'On patrol',
  standdown: (n) => n ? `Standing down at ${n}` : 'Standing down',
  flee:      (n) => n ? `Fleeing to ${n}` : 'Fleeing a pirate',
  shelter:   (n) => n ? `Sheltering at ${n}` : 'Sheltering in port',
  wait:      ()  => 'Holding for a fair wind',
  rove:      ()  => 'Roving the sea lanes',
  sailTo:    (n) => n ? `Sailing to ${n}` : 'Under way',
  tradeAt:   (n) => n ? `Trading at ${n}` : 'Trading',
  home:      (n) => n ? `Bound home for ${n}` : 'Bound home',
  adrift:    ()  => 'Adrift — lost, no bearings',
  aid:       (n) => n ? `Rendering aid to ${n}` : 'Rendering aid to a stricken ship',
  idle:      ()  => 'Lying at anchor',
};

const RES_COLOR = {
  Grain: '#e2c85a', Wood: '#5fb84f', Meat: '#cf9b6a', Fiber: '#a8c85a', Iron: '#9aa6b2', PreciousMetal: '#dfe4ec',
  Food: '#e0a83f', Ale: '#b07a3a', Clothing: '#d06a9a', Weapons: '#7f8790', LuxuryGoods: '#ffe36a', Ships: '#c8a06a',
};

export class InfoPanel extends Panel {
  constructor({ getSelection, getContext }) {
    super();
    this.getSelection = getSelection;
    this.getContext = getContext;
    this.visible = false;
    this._tab = 'stats';       // 'stats' | 'log' | 'story'
    this._scroll = new ScrollBox(); // the Story tab's chronicle scroller
    this._filter = 'all';      // active Story category filter (see eventKinds.js)
    this._subject = null;      // last-drawn story subject (kind:id) → resets scroll/filter on change
    this._chipRects = [];      // filter-chip hit rects (rebuilt each draw; pinned, so screen-space)
    this._narrKey = null;      // memo key for the composed tale (content + live frame/coda state)
    this._narrModel = null;    // the last narrate() render model, reused until _narrKey changes
  }

  layout(view) {
    this.setRect(view.width - W - 16, 16, W, view.height - 32);
  }

  /** The tab-button rects at the top of the panel. A SHIP gets a third tab — Log — for the intel
   *  it is physically carrying (information travels only by sea, so a boat's logbook is a payload). */
  _tabRects() {
    const sel = this.getSelection();
    const ids = sel && sel.kind === 'ship' ? ['stats', 'log', 'story'] : ['stats', 'story'];
    const LABEL = { stats: 'Stats', log: 'Log', story: 'Story' };
    const cx = this.x + PAD, cw = this.w - PAD * 2, y = this.y + 12, h = 22, gap = 6;
    const bw = (cw - gap * (ids.length - 1)) / ids.length;
    return ids.map((id, i) => ({ id, label: LABEL[id], x: cx + (bw + gap) * i, y, w: bw, h }));
  }

  onDown(px, py) {
    if (!this.contains(px, py)) return false;
    const sel = this.getSelection();
    if (sel && sel.data) {
      for (const t of this._tabRects()) {
        if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) { this._tab = t.id; return true; }
      }
      if (this._tab === 'story') {
        for (const ch of this._chipRects) {
          if (px >= ch.x && px <= ch.x + ch.w && py >= ch.y && py <= ch.y + ch.h) { this._filter = ch.key; return true; }
        }
      }
    }
    return true; // consume any click inside the panel (blocks world pick-through)
  }

  /** The panel is opaque to the wheel (the map never zooms behind it); only the Story tab scrolls. */
  onWheel(px, py, dy) {
    if (!this.contains(px, py)) return false;
    const sel = this.getSelection();
    if (sel && sel.data && this._tab === 'story') this._scroll.wheel(dy);
    return true;
  }

  drawContent(ctx) {
    const sel = this.getSelection();
    if (!sel || !sel.data) return;
    this._drawTabs(ctx);
    const cx = this.x + PAD, cw = this.w - PAD * 2;
    const c = { y: this.y + 40, cx, cw, max: this.y + this.h - 10 };
    if (this._tab === 'log' && sel.kind !== 'ship') this._tab = 'stats'; // Log is a ship-only tab
    if (this._tab === 'story') this._story(ctx, sel, c);
    else if (this._tab === 'log' && sel.kind === 'ship') this._shipLog(ctx, sel.id, sel.data, c);
    else if (sel.kind === 'island') this._island(ctx, sel.data, c);
    else this._ship(ctx, sel.id, sel.data, c);
  }

  _drawTabs(ctx) {
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of this._tabRects()) {
      const active = this._tab === t.id;
      roundRect(ctx, t.x, t.y, t.w, t.h, 6);
      ctx.fillStyle = active ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = active ? PALETTE.accent : PALETTE.panelEdge; ctx.stroke();
      ctx.fillStyle = active ? PALETTE.panelText : PALETTE.panelDim;
      ctx.fillText(t.label, t.x + t.w / 2, t.y + t.h / 2 + 0.5);
    }
    ctx.restore();
  }

  /** The Story tab: the entity's deep, permanent chronicle read as a NARRATIVE — oldest at the top,
   *  newest at the bottom, opened pinned to the latest (scroll up for history). A pinned header (title
   *  + derived vital-stats tallies + category filter chips) sits above a clipped, scrolling body. Deep
   *  history comes from the DB (getChronicle → /api/history), merged with the live event tail. */
  _story(ctx, sel, c) {
    const ctxt = this.getContext();
    const chron = ctxt.getChronicle
      ? ctxt.getChronicle(sel.kind, sel.id)
      : { entries: (ctxt.getHistory ? ctxt.getHistory(sel.kind, sel.id).slice().reverse() : []), loading: false, truncated: false };

    const subject = sel.kind + ':' + sel.id;
    if (subject !== this._subject) { this._subject = subject; this._filter = 'all'; } // new entity → reset filter
    this._scroll.reset(subject + ':' + this._filter, { stickBottom: true });

    // Compose the tale (memoized): the chronicler turns the ordered, filtered facts into a render model
    // (frame + dateline/prose blocks + coda). Recompute only when the content or the live frame/coda
    // state changes, so it never runs per-frame.
    const entries = filterByCategory(chron.entries, this._filter);
    const model = this._narrative(sel, entries, chron.truncated, ctxt);

    // ── Pinned header (drawn outside the scroll clip) ──
    this._titleRow(ctx, model.frame.title, { label: 'Chronicle', color: '#c8b3ff' }, c);
    if (model.frame.epigraph) this._subtitle(ctx, model.frame.epigraph, c);
    this._vitalStats(ctx, sel, chron.entries, c);
    this._filterChips(ctx, c);

    // ── Scrolling body: the narrated blocks (measure-then-clip, exactly as the flat list did) ──
    const top = c.y + 6, bottom = this.y + this.h - 10;
    if (bottom - top < 36) return; // no room to draw
    const sb = this._scroll, x = this.x + PAD, w = c.cw;
    sb.begin(ctx, this.x, top, this.w, bottom - top);
    let y = top + 4;
    const vt = sb.visibleTop, vb = sb.visibleBottom;
    if (chron.truncated) { // the DB holds more than the first page — hint at the buried past
      if (y + 16 >= vt && y <= vb) this._storyNote(ctx, '⋯ earlier history not shown', x, y, w);
      y += 20;
    }
    if (!model.blocks.length && chron.loading) {
      if (y + 16 >= vt && y <= vb) this._storyNote(ctx, 'Gathering the chronicle…', x, y, w);
      y += 20;
    }
    for (const b of model.blocks) {
      if (b.type === 'dateline') {
        if (y + 22 >= vt && y <= vb) sectionHeading(ctx, x, x + w, y + 12, b.text);
        y += 24;
      } else if (b.type === 'handover') {
        // A new keeper takes up the book — set off by a hairline and drawn in their own (emphasized) hand.
        y += 3;
        if (y >= vt && y <= vb) inkRule(ctx, x, x + w, y, PALETTE.panelEdge);
        y += 9;
        const lines = this._proseLines(ctx, b.runs, w - 4);
        const h = lines.length * 16 + 8;
        if (y + h >= vt && y <= vb) this._drawProse(ctx, lines, x + 2, y + 13);
        y += h;
      } else {
        const lines = this._proseLines(ctx, b.runs, w - 4);
        const h = lines.length * 16 + 10;
        if (y + h >= vt && y <= vb) this._drawProse(ctx, lines, x + 2, y + 13);
        y += h;
      }
    }
    if (model.coda) { // a closing "to this day…" line, set off by a thin rule
      y += 6;
      if (y >= vt && y <= vb) inkRule(ctx, x, x + w, y, PALETTE.panelEdge);
      y += 8;
      const lines = this._proseLines(ctx, [{ text: model.coda.text, role: 'coda' }], w - 4);
      if (y + lines.length * 16 >= vt && y <= vb) this._drawProse(ctx, lines, x + 2, y + 13);
      y += lines.length * 16 + 4;
    }
    sb.end(ctx, y + 4);
  }

  /** Compose (and memoize) the entity's tale. Recomputes only when the filtered content or the live
   *  frame/coda-relevant snapshot fields change — one narrate() run per meaningful change, never per-frame. */
  _narrative(sel, entries, truncated, ctxt) {
    const d = sel.data || {};
    const cn = d.captain || {}, mg = d.magistrate || {};
    const first = entries[0], last = entries[entries.length - 1];
    const seqOf = (e) => (e ? (e.seq != null ? e.seq : e.id) : '-');
    const voices = ctxt.voices || VOICE; // the per-keeper style registry (or the legacy single voice)
    const nStyles = voices && voices.ids ? voices.ids.length : 0;
    const liveSig = [d.name, d.type, d.homeId, d.pirate ? 1 : 0, d.privateer ? 1 : 0, Math.round(d.bounty || 0),
      cn.name, cn.rank, cn.voiceSeed, mg.name, mg.rank, mg.voiceSeed, d.haven ? 1 : 0, Math.round(d.population || 0), d.primary, nStyles].join('|');
    const key = sel.kind + ':' + sel.id + '|' + this._filter + '|' + entries.length + '|' + seqOf(first) + '|' + seqOf(last) + '|' + (truncated ? 1 : 0) + '|' + liveSig;
    if (key !== this._narrKey) {
      this._narrKey = key;
      const ncx = {
        islandsById: ctxt.islandsById, shipsById: ctxt.shipsById,
        seasons: ctxt.seasons, seasonDays: ctxt.seasonDays,
        shipLabel: (id) => shipLabel(id, ctxt.shipsById, ctxt.islandsById),
      };
      this._narrModel = narrate(entries, { kind: sel.kind, id: sel.id, data: d, truncated }, voices, ncx);
    }
    return this._narrModel;
  }

  /** Word-wrap a list of colored runs into lines of tokens `[{text,color,glue?}]` at the 12px body font.
   *  A token that opens with clause punctuation (a comma/period/… from a callback run like ", her third
   *  prize") is `glue`d to the preceding word so it hugs it — no floating " , " between words. */
  _proseLines(ctx, runs, maxW) {
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    const sp = ctx.measureText(' ').width;
    const lines = [];
    let line = [], lineW = 0;
    for (const run of runs) {
      const color = this._roleColor(run.role, run.kind);
      for (const word of String(run.text).split(' ')) {
        if (word === '') continue;
        const glue = line.length > 0 && /^[,.;:!?)]/.test(word); // hugs the previous token, no leading space
        const ww = ctx.measureText(word).width;
        if (line.length && !glue && lineW + sp + ww > maxW) { lines.push(line); line = []; lineW = 0; }
        line.push({ text: word, color, glue: glue && line.length > 0 });
        lineW += (line.length > 1 && !glue ? sp : 0) + ww;
      }
    }
    if (line.length) lines.push(line);
    ctx.restore();
    return lines.length ? lines : [[]];
  }

  /** Draw wrapped prose token-lines from `_proseLines`, each token in its own colour. */
  _drawProse(ctx, lines, x, y) {
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const sp = ctx.measureText(' ').width;
    let ly = y;
    for (const line of lines) {
      let lx = x;
      for (let i = 0; i < line.length; i++) {
        const tok = line[i];
        if (i > 0 && tok.glue) lx -= sp; // punctuation hugs the word before it
        ctx.fillStyle = tok.color;
        ctx.fillText(tok.text, lx, ly);
        lx += ctx.measureText(tok.text).width + sp;
      }
      ly += 16;
    }
    ctx.restore();
  }

  /** A narrated run's colour from its role (dim connective, kind-coloured clause, accent callback…). */
  _roleColor(role, kind) {
    switch (role) {
      case 'connective': case 'join': return PALETTE.panelDim;
      case 'callback': return PALETTE.accent;
      case 'handover': return '#d9b96b'; // a keeper taking up the book — warm gilt, set apart from the deeds
      case 'quiet': case 'coda': return PALETTE.hudDim;
      case 'pivot': case 'clause': default: return eventColor(kind, PALETTE.panelText);
    }
  }

  /** Derived vital-statistics header: since-day + total, then a few notable tallies for the entity
   *  type, computed from the chronicle. A compact chip wrap (its own pinned rows). */
  _vitalStats(ctx, sel, entries, c) {
    const parts = [];
    if (entries.length) parts.push({ t: `since Day ${entries[0].day}`, col: PALETTE.panelDim }); // ascending → oldest first
    parts.push({ t: `${entries.length} event${entries.length === 1 ? '' : 's'}`, col: PALETTE.panelDim });
    const tally = {};
    for (const e of entries) tally[e.kind] = (tally[e.kind] || 0) + 1;
    const NOTABLE = sel.kind === 'island'
      ? [['haven', 'skull', '#e04a5a'], ['rebellion', 'flame', '#ff5b30'], ['plague', 'skull', '#c072e0'], ['blight', 'wheat', '#ec8a3a'], ['boom', 'spark', '#ffd166']]
      : [['plunder', 'skull', '#e0503a'], ['pirate', 'skull', '#ff5b4a'], ['hunted', 'sabres', '#8ee6a0'], ['fended', 'shield', '#8fc6d4'], ['mutiny', 'flame', '#ff5b4a']];
    for (const [k, icon, col] of NOTABLE) if (tally[k]) parts.push({ t: `${tally[k]}`, icon, col });
    this._statChips(ctx, parts, c);
  }

  _statChips(ctx, parts, c) {
    c.y += 15;
    ctx.save();
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    let x = c.cx;
    for (const p of parts) {
      const iconW = p.icon ? 13 : 0;
      const w = ctx.measureText(p.t).width + 14 + iconW;
      if (x + w > c.cx + c.cw) { x = c.cx; c.y += 20; }
      roundRect(ctx, x, c.y - 8, w, 17, 8); ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
      let tx = x + 7;
      if (p.icon) { drawIcon(ctx, p.icon, x + 9, c.y, 11, p.col); tx = x + 18; }
      ctx.fillStyle = p.col; ctx.textAlign = 'left';
      ctx.fillText(p.t, tx, c.y + 0.5);
      x += w + 5;
    }
    ctx.restore();
    c.y += 8;
  }

  /** The category filter chip row (pinned). Records hit rects for onDown. */
  _filterChips(ctx, c) {
    c.y += 18;
    this._chipRects = [];
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    let x = c.cx;
    for (const cat of STORY_CATEGORIES) {
      const w = ctx.measureText(cat.label).width + 16;
      if (x + w > c.cx + c.cw) { x = c.cx; c.y += 22; }
      const active = this._filter === cat.key;
      roundRect(ctx, x, c.y - 9, w, 18, 8);
      ctx.fillStyle = active ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.04)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = active ? PALETTE.accent : PALETTE.panelEdge; ctx.stroke();
      ctx.fillStyle = active ? PALETTE.panelText : PALETTE.panelDim; ctx.textAlign = 'center';
      ctx.fillText(cat.label, x + w / 2, c.y + 0.5);
      this._chipRects.push({ key: cat.key, x, y: c.y - 9, w, h: 18 });
      x += w + 5;
    }
    ctx.restore();
    c.y += 12;
  }

  _storyNote(ctx, text, x, y, w) {
    ctx.save();
    ctx.font = 'italic 11px system-ui, sans-serif';
    ctx.fillStyle = PALETTE.hudDim; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x + w / 2, y + 11);
    ctx.restore();
  }

  // ─── Island ──────────────────────────────────────────────────────
  _island(ctx, isl, c) {
    const ctxt = this.getContext();
    const st = islandState(isl);
    this._titleRow(ctx, isl.name, st, c);
    this._subtitle(ctx, `${cap(isl.type)} · ${isl.primary || '?'}${isl.secondary ? ' / ' + isl.secondary : ''}`, c);

    // Active afflictions.
    if (isl.haven) this._banner(ctx, `PIRATE HAVEN — grip ${Math.round((isl.haven.strength || 0) * 100)}%`, '#b0242e', c, 'skull');
    if (isl.blight) this._banner(ctx, `Blight — ${isl.blight} crippled`, '#ec8a3a', c, 'wheat');
    if (isl.plague) this._banner(ctx, 'Plague — population dying', '#c072e0', c, 'skull');
    if (isl.danger > 0.25) this._banner(ctx, `Pirate danger — ${dangerWord(isl.danger)} waters`, '#c0392b', c, 'pennant');
    if (isl.contract) this._banner(ctx, `WANTED: ${isl.contract.good} · ${fmt(isl.contract.reward)} g reward`, '#e8c15a', c, 'scroll');

    // Magistrate + the populace's loyalty (a haven has no lawful magistrate).
    if (isl.magistrate) this._magistrate(ctx, isl, ctxt, c);

    // Population + civilization gauges.
    const popFrac = isl.k ? Math.min(1, isl.population / isl.k) : 0;
    this._gauge(ctx, 'Population', `${fmt(isl.population)}${isl.k ? ' / ' + isl.k : ''}`, popFrac, '#7fd0e0', c);
    this._gauge(ctx, 'Civilization', (isl.civ ?? 0).toFixed(2), Math.max(0, Math.min(1, isl.civ || 0)), '#8ee6a0', c);
    this._kv(ctx, 'Treasury', fmt(isl.gold) + ' g', c, PALETTE.accent);
    // Reach of this port's price knowledge — how many other markets it has any read on, and
    // how many of those are current (it learns firsthand as its ships dock; see beliefs.js).
    if (isl.intel) this._kv(ctx, 'Price intel', `${isl.intel.known} known · ${isl.intel.fresh} fresh`, c, '#c8b3ff');
    // Reach of its NON-price intel (danger/haven/famine sightings ships have carried home) and how
    // many of its ships it is still awaiting from over the horizon (the outstanding-voyage ledger).
    if (isl.facts) this._kv(ctx, 'World intel', `${isl.facts.known} known · ${isl.facts.fresh} fresh`, c, '#c8b3ff');
    if (isl.awaiting > 0) this._kv(ctx, 'At sea', `${isl.awaiting} ship${isl.awaiting > 1 ? 's' : ''} awaited`, c, '#7fd0e0');

    // What it makes.
    if (isl.produces && isl.produces.length) {
      this._section(ctx, 'PRODUCES', c);
      this._chipRow(ctx, isl.produces, c);
    }

    // Relations (reputation).
    if ((isl.allies && isl.allies.length) || (isl.rivals && isl.rivals.length)) {
      this._section(ctx, 'RELATIONS', c);
      for (const a of (isl.allies || [])) this._relation(ctx, 'chevronUp', name(ctxt.islandsById, a.id), a.v, PALETTE.good, c);
      for (const r of (isl.rivals || [])) this._relation(ctx, 'chevronDown', name(ctxt.islandsById, r.id), r.v, PALETTE.bad, c);
    }

    // Market.
    this._section(ctx, 'MARKET', c);
    this._marketHeader(ctx, c);
    const order = [...(ctxt.raw || []), ...(ctxt.goods || [])];
    for (const good of order) {
      if (!isl.stock || isl.stock[good] === undefined) continue;
      if (c.y > c.max - 14) break; // out of room
      this._marketRow(ctx, good, isl, c);
    }

    // Docked.
    const docked = isl.dockedShipIds || [];
    if (docked.length && c.y < c.max - 20) {
      this._section(ctx, `IN PORT (${docked.length})`, c);
      for (const id of docked.slice(0, 4)) {
        if (c.y > c.max - 12) break;
        this._line(ctx, '· ' + shipLabel(id, ctxt.shipsById, ctxt.islandsById), PALETTE.panelDim, c);
      }
    }
  }

  // ─── Ship ────────────────────────────────────────────────────────
  _ship(ctx, id, s, c) {
    const ctxt = this.getContext();
    const st = { label: STATE[s.state] || cap(s.state), color: STATE_COLOR[s.state] || PALETTE.panelDim };
    const subtitle = s.pirate ? `${cap(s.type)} · rogue out of ${name(ctxt.islandsById, s.homeId)}`
      : s.privateer ? `Privateer · out of ${name(ctxt.islandsById, s.homeId)}`
      : `${cap(s.type)} · home ${name(ctxt.islandsById, s.homeId)}`;
    this._titleRow(ctx, s.name || shipLabel(id, ctxt.shipsById, ctxt.islandsById), st, c);
    this._subtitle(ctx, subtitle, c);

    // Faction banner — the loudest line, above everything else.
    if (s.pirate) {
      c.y += 8; this._banner(ctx, 'BLACK FLAG — PIRATE', '#e04a5a', c, 'skull');
      if (s.bounty > 0) { c.y += 6; this._banner(ctx, `Bounty: ${fmt(s.bounty)} g on this head`, '#ffd166', c, 'coin'); }
    } else if (s.privateer) {
      c.y += 8; this._banner(ctx, 'PRIVATEER — pirate-hunter', '#6fa8d8', c, 'sabres');
    }

    // Errand banner (merchants only) — the PURPOSE of the voyage.
    const goal = GOAL[s.reason] || (s.reason ? { label: cap(s.reason), color: PALETTE.panelText } : null);
    if (goal && !s.pirate && !s.privateer) { c.y += 8; this._banner(ctx, goal.label, goal.color, c); }

    // The specific live ACTION — what this hull is doing this moment, and to whom/where.
    this._activity(ctx, s, ctxt, c);

    // Captain — identity, experience, personality, and how the wind sits for them.
    if (s.captain) this._captain(ctx, s, ctxt, c);

    // Crew — morale, provisions, grog, and whether they're about to rise up.
    if (s.morale != null) this._crew(ctx, s, c);

    // Condition — hull integrity + rigging (shown when there's wear worth showing).
    if ((s.hull != null && s.hull < 0.985) || (s.rig != null && s.rig < 0.985)) this._condition(ctx, s, c);

    // Route with the current leg highlighted.
    if (Array.isArray(s.route) && s.route.length) {
      this._section(ctx, 'VOYAGE', c);
      this._route(ctx, s, ctxt, c);
      if (s.state === 'sailing') this._kv(ctx, 'ETA', `${Math.max(0, s.eta | 0)}s`, c);
    }

    // Hold: a labelled fill gauge, then what's aboard. Coin is its own clearly-marked row
    // (and it has weight — the gauge below counts it), so the "N / cap" fill can't be misread
    // as the amount of gold.
    this._section(ctx, 'HOLD', c);
    const used = Math.round(s.used || 0), capN = Math.round(s.cap || 0);
    this._gauge(ctx, 'Cargo hold', `${used} / ${capN}`, capN ? used / capN : 0, '#c8a06a', c);
    this._cargoRow(ctx, 'Coin', fmt(s.gold || 0) + ' g', PALETTE.accent, c);
    const cargo = s.cargo || {}, keys = Object.keys(cargo);
    for (const k of keys) {
      const isPeople = k === 'People';
      this._cargoRow(ctx, isPeople ? 'Settlers' : k, String(cargo[k]), isPeople ? '#f2b8d0' : (RES_COLOR[k] || PALETTE.panelText), c);
    }
    if (!keys.length) this._line(ctx, 'No goods aboard', PALETTE.panelDim, c);
  }

  /** Hull integrity + rigging condition (repair.js) — the ship's physical state, high=green→red=low. */
  _condition(ctx, s, c) {
    const bar = (label, v) => {
      const col = v > 0.6 ? '#8ee6a0' : v > 0.3 ? '#e0b24a' : '#ff5b4a';
      this._gauge(ctx, label, `${Math.round(v * 100)}%`, v, col, c);
    };
    this._section(ctx, 'CONDITION', c);
    bar('Hull', s.hull != null ? s.hull : 1);
    bar('Rig', s.rig != null ? s.rig : 1);
  }

  /** The ship's specific current action, drawn as a prominent banner (coloured by faction). Falls back to
   *  nothing when the sim hasn't tagged an activity (e.g. a mid-transition tick). */
  _activity(ctx, s, ctxt, c) {
    if (!s.act) return;
    const fn = ACT[s.act];
    const text = fn ? fn(actName(s.actId, ctxt)) : cap(s.act);
    const color = s.pirate ? '#e0863a' : s.privateer ? '#8fc6ff' : '#8ee6a0';
    c.y += 8;
    this._banner(ctx, text, color, c, 'caret');
  }

  // ─── Ship logbook — the intel this ship is physically carrying ───────
  _shipLog(ctx, id, s, c) {
    const ctxt = this.getContext();
    this._titleRow(ctx, s.name || shipLabel(id, ctxt.shipsById, ctxt.islandsById), { label: 'Logbook', color: '#6fd0e0' }, c);
    this._subtitle(ctx, 'What this crew has seen — carried home by sea', c);
    const log = Array.isArray(s.log) ? s.log : [];
    this._section(ctx, `SIGHTINGS (${log.length})`, c);
    if (!log.length) {
      this._line(ctx, 'No word yet — a fresh crew with an empty log.', PALETTE.panelDim, c);
      return;
    }
    for (const e of log) {
      if (c.y > c.max - 18) break;
      const nm = name(ctxt.islandsById, e.id);
      const age = e.age <= 0 ? 'today' : `${e.age}d ago`;
      let flag = 'quiet', col = '#8ee6a0';
      if (e.haven) { flag = 'fallen'; col = '#e04a5a'; }
      else if (e.danger > 0.25) { flag = `danger ${Math.round(e.danger * 100)}%`; col = '#e0863a'; }
      else if (e.foodDays < 2) { flag = 'famine'; col = '#d98a3a'; }
      this._logRow(ctx, nm, age, flag, col, c);
    }
  }

  _logRow(ctx, nm, age, flag, color, c) {
    c.y += 19;
    ctx.save();
    ctx.font = '13px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, nm, c.cw - 120), c.cx, c.y);
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.hudDim; ctx.font = '11px system-ui, sans-serif';
    const aw = ctx.measureText(age).width;
    ctx.fillText(age, c.cx + c.cw, c.y);
    ctx.fillStyle = color; ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(flag, c.cx + c.cw - aw - 8, c.y);
    ctx.restore();
  }

  _captain(ctx, s, ctxt, c) {
    const cn = s.captain;
    this._section(ctx, 'CAPTAIN', c);
    // Portrait framed on the left; name + rank/personality beside it.
    const size = 66, top = c.y + 4, px = c.cx;
    if (ctxt.portraits && cn.portrait != null) {
      ctx.save();
      roundRect(ctx, px, top, size, size, 10);
      ctx.fillStyle = '#e9dcbb'; ctx.fill();
      ctx.clip();
      ctxt.portraits.draw(ctx, px + size / 2, top + size * 0.46, size * 0.34, cn.portrait, 0);
      ctx.restore();
      roundRect(ctx, px, top, size, size, 10);
      ctx.strokeStyle = PALETTE.panelEdge; ctx.lineWidth = 1; ctx.stroke();
    }
    const tx = px + size + 12;
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = '600 15px system-ui, sans-serif'; ctx.fillStyle = PALETTE.panelText;
    ctx.fillText(clip(ctx, cn.name, c.cw - size - 12), tx, top + 22);
    ctx.font = '12.5px system-ui, sans-serif'; ctx.fillStyle = '#c8b3ff';
    ctx.fillText(`${cn.rank} · ${cn.personality || 'Steady'}`, tx, top + 42);
    ctx.restore();
    c.y = top + size + 2;
    const sk = cn.skills || { sea: cn.skill || 0, gun: cn.skill || 0, cmd: cn.skill || 0 };
    this._gauge(ctx, 'Seamanship', `${Math.round(sk.sea * 100)}%`, sk.sea, '#8ee6a0', c);
    this._gauge(ctx, 'Gunnery', `${Math.round(sk.gun * 100)}%`, sk.gun, '#ff8f6a', c);
    this._gauge(ctx, 'Command', `${Math.round(sk.cmd * 100)}%  ·  ${cn.xp} xp`, sk.cmd, '#9db8ff', c);
    const tr = cn.traits;
    if (tr) {
      this._gauge(ctx, 'Boldness', '', tr.boldness, '#ff9d5c', c);
      this._gauge(ctx, 'Wanderlust', '', tr.wanderlust, '#8fc6ff', c);
      this._gauge(ctx, 'Greed', '', tr.greed, '#ffd166', c);
    }
    const rel = windRel(s.heading, ctxt.wind, s.state);
    if (rel) this._kv(ctx, 'Wind', rel.label, c, rel.color);
  }

  _magistrate(ctx, isl, ctxt, c) {
    const m = isl.magistrate;
    this._section(ctx, 'MAGISTRATE', c);
    const size = 66, top = c.y + 4, px = c.cx;
    if (ctxt.portraits && m.portrait != null) {
      ctx.save();
      roundRect(ctx, px, top, size, size, 10);
      ctx.fillStyle = '#e9dcbb'; ctx.fill();
      ctx.clip();
      ctxt.portraits.draw(ctx, px + size / 2, top + size * 0.46, size * 0.34, m.portrait, 0);
      ctx.restore();
      roundRect(ctx, px, top, size, size, 10);
      ctx.strokeStyle = PALETTE.panelEdge; ctx.lineWidth = 1; ctx.stroke();
    }
    const tx = px + size + 12;
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = '600 15px system-ui, sans-serif'; ctx.fillStyle = PALETTE.panelText;
    ctx.fillText(clip(ctx, m.name, c.cw - size - 12), tx, top + 22);
    ctx.font = '12.5px system-ui, sans-serif'; ctx.fillStyle = '#c8b3ff';
    ctx.fillText(`${m.rank} · ${m.personality || 'Even-handed'}`, tx, top + 42);
    if (m.ambition && m.ambition.label) {
      drawIcon(ctx, 'pennant', tx + 6, top + 56, 11, '#e8c15a');
      ctx.fillStyle = '#e8c15a';
      ctx.fillText(clip(ctx, `${m.ambition.label} · ${Math.round((m.ambition.progress || 0) * 100)}%`, c.cw - size - 24), tx + 15, top + 60);
    }
    ctx.restore();
    c.y = top + size + 2;
    const loy = isl.loyalty != null ? isl.loyalty : 1;
    if (isl.rebellion) this._banner(ctx, 'In open rebellion — the port is aflame', '#ff5b30', c, 'flame');
    this._gauge(ctx, 'Loyalty', `${Math.round(loy * 100)}%`, loy, loyaltyColor(loy), c);
    const st = loyaltyStatus(isl);
    this._kv(ctx, 'Populace', st.label, c, st.color);
    const law = isl.lawlessness || 0;
    if (law > 0.05) this._gauge(ctx, 'Lawlessness', lawlessWord(law), law, lawlessColor(law), c);
    const grv = isl.grievance || 0;
    if (grv > 0.05) this._gauge(ctx, 'Grievance', grievanceWord(grv), grv, lawlessColor(grv), c); // resentment from revolts crushed by force
    const tr = m.traits;
    if (tr) {
      this._gauge(ctx, 'Firmness', '', tr.firmness, '#e0863a', c);
      this._gauge(ctx, 'Generosity', '', tr.generosity, '#8ee6a0', c);
      this._gauge(ctx, 'Integrity', '', tr.integrity, '#8fc6ff', c);
    }
  }

  _crew(ctx, s, c) {
    this._section(ctx, 'CREW', c);
    const m = s.morale != null ? s.morale : 1;
    const st = crewStatus(s);
    if (s.revolt) this._banner(ctx, 'Crew in revolt — dead in the water', '#ff5b4a', c, 'sabres');
    this._gauge(ctx, 'Morale', `${Math.round(m * 100)}%`, m, moraleColor(m), c);
    const days = s.foodDays != null ? s.foodDays : 0;
    this._kv(ctx, 'Provisions', `${days.toFixed(1)} days of food`, c, days < 1 ? PALETTE.bad : PALETTE.panelText);
    const ale = Math.round((s.cargo && s.cargo.Ale) || 0);
    if (ale > 0) this._kv(ctx, 'Grog', `${ale} Ale (lifts morale)`, c, '#b07a3a');
    this._kv(ctx, 'Mood', st.label, c, st.color);
  }

  // ─── building blocks ─────────────────────────────────────────────
  _titleRow(ctx, title, badge, c) {
    ctx.save();
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.fillStyle = PALETTE.panelText;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    c.y += 18;
    const bw = badge ? this._badge(ctx, badge.label, badge.color, c.cx + c.cw, c.y) : 0;
    ctx.fillStyle = PALETTE.panelText;
    ctx.font = '600 19px system-ui, sans-serif';
    // Vessel names are stored lowercase ("the Salt Wraith") so they read naturally mid-sentence; as a
    // heading the leading article wants a capital.
    ctx.fillText(clip(ctx, cap(title), c.cw - bw - 8), c.cx, c.y);
    ctx.restore();
    c.y += 6;
  }

  /** Draw a right-aligned pill badge ending at (xRight, yBaseline). Returns its width. */
  _badge(ctx, text, color, xRight, yBaseline) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const w = tw + 16, h = 17, x = xRight - w, y = yBaseline - 13;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.restore();
    return w;
  }

  _subtitle(ctx, text, c) {
    ctx.save();
    ctx.font = '12.5px system-ui, sans-serif';
    ctx.fillStyle = PALETTE.panelDim;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    c.y += 15;
    ctx.fillText(clip(ctx, text, c.cw), c.cx, c.y);
    ctx.restore();
    c.y += 6;
  }

  _section(ctx, label, c) {
    c.y += 16;
    // Gilt, letter-spaced small-caps heading with a tapered ink rule filling the line.
    sectionHeading(ctx, c.cx, c.cx + c.cw, c.y - 4, label);
    c.y += 8;
  }

  _gauge(ctx, label, valText, frac, color, c) {
    c.y += 16;
    ctx.save();
    ctx.font = '12.5px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left';
    ctx.fillText(label, c.cx, c.y);
    if (valText) { ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'right'; ctx.fillText(valText, c.cx + c.cw, c.y); }
    c.y += 6;
    const bw = c.cw, bh = 6;
    roundRect(ctx, c.cx, c.y, bw, bh, 3); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
    roundRect(ctx, c.cx, c.y, Math.max(2, bw * Math.max(0, Math.min(1, frac))), bh, 3); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
    c.y += 8;
  }

  _kv(ctx, k, v, c, valColor) {
    c.y += 18;
    ctx.save();
    ctx.font = '13px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PALETTE.panelDim; ctx.textAlign = 'left';
    ctx.fillText(k, c.cx, c.y);
    ctx.fillStyle = valColor || PALETTE.panelText; ctx.textAlign = 'right';
    ctx.font = '13px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillText(v, c.cx + c.cw, c.y);
    ctx.restore();
  }

  _banner(ctx, text, color, c, icon) {
    c.y += 20;
    ctx.save();
    roundRect(ctx, c.cx, c.y - 15, c.cw, 22, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
    let tx = c.cx + 10;
    if (icon) { drawIcon(ctx, icon, c.cx + 12, c.y - 4, 13, color); tx = c.cx + 24; }
    ctx.fillStyle = color; ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, tx, c.y - 4);
    ctx.restore();
    c.y += 8;
  }

  _chipRow(ctx, goods, c) {
    c.y += 16;
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    let x = c.cx;
    for (const g of goods) {
      const tw = ctx.measureText(g).width, w = tw + 20;
      if (x + w > c.cx + c.cw) { x = c.cx; c.y += 22; }
      roundRect(ctx, x, c.y - 8, w, 17, 8); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      ctx.fillStyle = RES_COLOR[g] || '#ccc'; ctx.beginPath(); ctx.arc(x + 8, c.y, 3.5, 0, 7); ctx.fill();
      ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'left';
      ctx.fillText(g, x + 15, c.y + 0.5);
      x += w + 6;
    }
    ctx.restore();
    c.y += 4;
  }

  _relation(ctx, icon, nm, v, color, c) {
    c.y += 16;
    ctx.save();
    ctx.font = '12.5px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    drawIcon(ctx, icon, c.cx + 5, c.y - 4, 11, color);
    ctx.fillStyle = PALETTE.panelText; ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, nm, c.cw - 60), c.cx + 16, c.y);
    ctx.fillStyle = color; ctx.textAlign = 'right';
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText((v > 0 ? '+' : '') + v.toFixed(2), c.cx + c.cw, c.y);
    ctx.restore();
  }

  _marketHeader(ctx, c) {
    c.y += 14;
    ctx.save();
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = PALETTE.panelDim; ctx.textBaseline = 'alphabetic';
    const rSell = c.cx + c.cw, rBuy = rSell - 58, rStock = rBuy - 54;
    ctx.textAlign = 'right';
    ctx.fillText('stock', rStock, c.y); ctx.fillText('buy', rBuy, c.y); ctx.fillText('sell', rSell, c.y);
    ctx.restore();
    c._cols = { rSell, rBuy, rStock };
    c.y += 3;
  }

  _marketRow(ctx, good, isl, c) {
    c.y += 16;
    const { rSell, rBuy, rStock } = c._cols;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = RES_COLOR[good] || '#ccc'; ctx.beginPath(); ctx.arc(c.cx + 4, c.y - 4, 3, 0, 7); ctx.fill();
    ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = PALETTE.panelText;
    ctx.fillText(good, c.cx + 12, c.y);
    ctx.font = '11.5px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.panelText; ctx.fillText(String(isl.stock[good]), rStock, c.y);
    ctx.fillStyle = PALETTE.good; ctx.fillText(num2(isl.buy && isl.buy[good]), rBuy, c.y);
    ctx.fillStyle = PALETTE.bad; ctx.fillText(num2(isl.sell && isl.sell[good]), rSell, c.y);
    ctx.restore();
  }

  _route(ctx, s, ctxt, c) {
    c.y += 16;
    const stops = ['home', ...s.route, 'home'].map((r) => r === 'home' ? name(ctxt.islandsById, s.homeId) : name(ctxt.islandsById, r));
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    let x = c.cx;
    for (let i = 0; i < stops.length; i++) {
      const isDest = s.destId && (s.route[i - 1] === s.destId); // the stop we're sailing to
      const label = stops[i];
      if (i > 0) { ctx.fillStyle = PALETTE.panelDim; ctx.fillText(' → ', x, c.y); x += ctx.measureText(' → ').width; }
      const tw = ctx.measureText(label).width;
      if (x + tw > c.cx + c.cw) { c.y += 16; x = c.cx + 10; }
      ctx.fillStyle = isDest ? PALETTE.accent : PALETTE.panelText;
      ctx.font = isDest ? '600 12px system-ui, sans-serif' : '12px system-ui, sans-serif';
      ctx.fillText(label, x, c.y); x += ctx.measureText(label).width;
    }
    ctx.restore();
    c.y += 4;
  }

  _cargoRow(ctx, k, v, color, c) {
    c.y += 17;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(c.cx + 4, c.y - 4, 3, 0, 7); ctx.fill();
    ctx.font = '12.5px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = PALETTE.panelText;
    ctx.fillText(k, c.cx + 12, c.y);
    ctx.textAlign = 'right'; ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText(v, c.cx + c.cw, c.y);
    ctx.restore();
  }

  _line(ctx, text, color, c) {
    c.y += 15;
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(clip(ctx, text, c.cw), c.cx, c.y);
    ctx.restore();
  }
}

// ─── helpers ────────────────────────────────────────────────────────
function islandState(isl) {
  const ratio = isl.k ? (isl.population || 0) / isl.k : 0;
  const civ = isl.civ || 0;
  if (ratio < 0.35 || civ < 0.12) return { label: 'Struggling', color: PALETTE.bad };
  if (civ >= 0.55) return { label: 'Prosperous', color: PALETTE.good };
  if (ratio >= 0.8) return { label: 'Established', color: '#7fd0e0' };
  return { label: 'Growing', color: PALETTE.accent };
}
/** Populace mood label + colour from island loyalty (or open rebellion). */
function loyaltyStatus(isl) {
  if (isl.rebellion) return { label: 'In rebellion!', color: '#ff5b30' };
  const l = isl.loyalty != null ? isl.loyalty : 1;
  if (l >= 0.6) return { label: 'Loyal', color: PALETTE.good };
  if (l >= 0.45) return { label: 'Content', color: '#8fc6d4' };
  if (l >= 0.3) return { label: 'Restless', color: '#e0b24a' };
  return { label: 'Seething', color: PALETTE.bad };
}
function loyaltyColor(l) {
  return l >= 0.6 ? PALETTE.good : l >= 0.4 ? '#8fc6d4' : l >= 0.28 ? '#e0b24a' : PALETTE.bad;
}

/** How feared a port's waters are, from its danger scalar. */
function dangerWord(d) {
  if (d >= 0.7) return 'perilous';
  if (d >= 0.45) return 'dangerous';
  return 'uneasy';
}

/** Civil-order label + colour from an island's lawlessness scalar. */
function lawlessWord(l) {
  if (l >= 0.7) return 'lawless';
  if (l >= 0.45) return 'unruly';
  if (l >= 0.25) return 'restless';
  return 'orderly';
}
function lawlessColor(l) {
  return l >= 0.7 ? '#c0392b' : l >= 0.45 ? '#e0863a' : l >= 0.25 ? '#e0b24a' : '#8ee6a0';
}

/** Resentment label from an island's grievance scalar (rebellions crushed by force). */
function grievanceWord(g) {
  if (g >= 0.7) return 'seething';
  if (g >= 0.45) return 'embittered';
  if (g >= 0.25) return 'resentful';
  return 'simmering';
}

/** Crew mood label + colour from morale (or open revolt). */
function crewStatus(s) {
  if (s.revolt) return { label: 'In revolt!', color: '#ff5b4a' };
  const m = s.morale != null ? s.morale : 1;
  if (m >= 0.6) return { label: 'Content', color: PALETTE.good };
  if (m >= 0.45) return { label: 'Steady', color: '#8fc6d4' };
  if (m >= 0.3) return { label: 'Uneasy', color: '#e0b24a' };
  return { label: 'Mutinous', color: PALETTE.bad };
}
function moraleColor(m) {
  return m >= 0.6 ? PALETTE.good : m >= 0.4 ? '#8fc6d4' : m >= 0.28 ? '#e0b24a' : PALETTE.bad;
}

/** Wind relative to a sailing ship's heading → { label, color }, or null when not underway. */
function windRel(heading, wind, state) {
  if (state !== 'sailing' || !wind || wind.str < 0.05 || heading == null) return null;
  const align = Math.cos(heading - wind.dir);
  if (align > 0.35) return { label: `Tailwind (${wind.str < 0.6 ? 'moderate' : 'strong'})`, color: PALETTE.good };
  if (align < -0.35) return { label: 'Headwind', color: '#ff9d5c' };
  return { label: 'Crosswind', color: '#8fc6d4' };
}
function fmt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
function num2(n) { return n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function name(map, id) { const i = map && map.get(id); return i ? i.name : '—'; }
/** Resolve an activity target id → display name. Island ids live in islandsById (lowercase-alpha, never
 *  the s-<num> shape of a ship id), so try that first, then fall back to a ship label. */
function actName(actId, ctxt) {
  if (actId == null) return null;
  const isl = ctxt.islandsById && ctxt.islandsById.get(actId);
  if (isl) return isl.name;
  return shipLabel(actId, ctxt.shipsById, ctxt.islandsById);
}
function shipLabel(id, ships, islandsById) {
  const s = ships && ships[id];
  const home = s ? (islandsById && islandsById.get(s.homeId)) : null;
  const numId = String(id).replace(/^s/, '');
  return home ? `${home.name} #${numId}` : `Ship ${id}`;
}
function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
