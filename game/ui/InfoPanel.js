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
import { PALETTE } from '../config.js';

const W = 320;
const PAD = 16;

const GOAL = {
  food: { label: 'Importing food', color: '#ff9d5c' },
  migrate: { label: 'Carrying migrants', color: '#8fc6ff' },
  buyShip: { label: 'Buying a ship', color: '#c8a06a' },
  trade: { label: 'Trading', color: '#8ee6a0' },
  scout: { label: 'Scouting prices', color: '#c8b3ff' },
};
const STATE = { idle: 'In port', sailing: 'Sailing', docked: 'Docked' };
const STATE_COLOR = { idle: '#9fb6bd', sailing: '#5fd0e0', docked: '#8fc6ff' };

const RES_COLOR = {
  Grain: '#e2c85a', Wood: '#5fb84f', Meat: '#cf9b6a', Fiber: '#a8c85a', Iron: '#9aa6b2', PreciousMetal: '#dfe4ec',
  Food: '#e0a83f', Ale: '#b07a3a', Clothing: '#d06a9a', Weapons: '#7f8790', LuxuryGoods: '#ffe36a', Ships: '#c8a06a',
};

// Chronicle line colour by event kind (mirrors the news-ticker palette).
const EVENT_TEXT_COLOR = {
  blight: '#ec8a3a', plague: '#c072e0', wreck: '#8fb6c6', recover: '#8ee6a0',
  mutiny: '#ff5b4a', defect: '#e0863a', quell: '#8ee6a0', unrest: '#e0b24a', starve: '#c0503a',
  launch: '#6fd0e0', migrate: '#f2b8d0', famine: '#d98a3a', boom: '#ffd166', ally: '#8ee6a0', rival: '#e0863a',
  rebellion: '#ff5b30', overthrow: '#ff7b4a', quellReb: '#8ee6a0',
  pirate: '#ff5b4a', plunder: '#e0503a', fended: '#8ee6a0', raid: '#ff7b4a', raidfail: '#8ee6a0',
  bounty: '#ffd166', privateer: '#6fa8d8', hunted: '#8ee6a0', hunterlost: '#e0863a', standdown: '#8fb6c6',
};

export class InfoPanel extends Panel {
  constructor({ getSelection, getContext }) {
    super();
    this.getSelection = getSelection;
    this.getContext = getContext;
    this.visible = false;
    this._tab = 'stats'; // 'stats' | 'story'
  }

  layout(view) {
    this.setRect(view.width - W - 16, 16, W, view.height - 32);
  }

  /** The two tab-button rects (Stats / Story) at the top of the panel. */
  _tabRects() {
    const cx = this.x + PAD, cw = this.w - PAD * 2, y = this.y + 12, h = 22, gap = 6;
    const bw = (cw - gap) / 2;
    return [{ id: 'stats', label: 'Stats', x: cx, y, w: bw, h }, { id: 'story', label: 'Story', x: cx + bw + gap, y, w: bw, h }];
  }

  onDown(px, py) {
    if (!this.contains(px, py)) return false;
    const sel = this.getSelection();
    if (sel && sel.data) {
      for (const t of this._tabRects()) {
        if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) { this._tab = t.id; break; }
      }
    }
    return true; // consume any click inside the panel (blocks world pick-through)
  }

  drawContent(ctx) {
    const sel = this.getSelection();
    if (!sel || !sel.data) return;
    this._drawTabs(ctx);
    const cx = this.x + PAD, cw = this.w - PAD * 2;
    const c = { y: this.y + 40, cx, cw, max: this.y + this.h - 10 };
    if (this._tab === 'story') this._story(ctx, sel, c);
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

  /** The Story tab: the clicked entity's chronicle — action · why · result, newest first. */
  _story(ctx, sel, c) {
    const title = sel.kind === 'ship' ? (sel.data.name || shipLabel(sel.id, this.getContext().shipsById, this.getContext().islandsById)) : sel.data.name;
    this._titleRow(ctx, title, { label: 'Chronicle', color: '#c8b3ff' }, c);
    const gh = this.getContext().getHistory;
    const entries = gh ? gh(sel.kind, sel.id) : [];
    if (!entries.length) {
      c.y += 10;
      this._line(ctx, 'No tale yet — its story is still being written.', PALETTE.panelDim, c);
      this._line(ctx, '(history is recorded from when you started watching)', PALETTE.hudDim, c);
      return;
    }
    c.y += 6;
    for (const e of entries) {
      if (c.y > c.max - 14) break;
      c.y += 14;
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = PALETTE.hudDim; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Day ${e.day}`, c.cx, c.y);
      ctx.restore();
      c.y = this._wrap(ctx, e.text, c.cx + 4, c.y + 15, c.cw - 4, 15, EVENT_TEXT_COLOR[e.kind] || PALETTE.panelText, c.max);
      c.y += 4;
    }
  }

  /** Word-wrap `text` from (x,y) within maxW; returns the y after the last line. */
  _wrap(ctx, text, x, y, maxW, lh, color, maxY) {
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const words = String(text).split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        if (y > maxY) { ctx.restore(); return y; }
        ctx.fillText(line, x, y); y += lh; line = w;
      } else line = test;
    }
    if (line && y <= maxY) { ctx.fillText(line, x, y); }
    ctx.restore();
    return y;
  }

  // ─── Island ──────────────────────────────────────────────────────
  _island(ctx, isl, c) {
    const ctxt = this.getContext();
    const st = islandState(isl);
    this._titleRow(ctx, isl.name, st, c);
    this._subtitle(ctx, `${cap(isl.type)} · ${isl.primary || '?'}${isl.secondary ? ' / ' + isl.secondary : ''}`, c);

    // Active afflictions.
    if (isl.blight) this._banner(ctx, `Blight — ${isl.blight} crippled`, '#ec8a3a', c);
    if (isl.plague) this._banner(ctx, 'Plague — population dying', '#c072e0', c);
    if (isl.danger > 0.25) this._banner(ctx, `⚑ Pirate danger — ${dangerWord(isl.danger)} waters`, '#c0392b', c);

    // Magistrate + the populace's loyalty.
    if (isl.magistrate) this._magistrate(ctx, isl, ctxt, c);

    // Population + civilization gauges.
    const popFrac = isl.k ? Math.min(1, isl.population / isl.k) : 0;
    this._gauge(ctx, 'Population', `${fmt(isl.population)}${isl.k ? ' / ' + isl.k : ''}`, popFrac, '#7fd0e0', c);
    this._gauge(ctx, 'Civilization', (isl.civ ?? 0).toFixed(2), Math.max(0, Math.min(1, isl.civ || 0)), '#8ee6a0', c);
    this._kv(ctx, 'Treasury', fmt(isl.gold) + ' g', c, PALETTE.accent);
    // Reach of this port's price knowledge — how many other markets it has any read on, and
    // how many of those are current (it learns firsthand as its ships dock; see beliefs.js).
    if (isl.intel) this._kv(ctx, 'Price intel', `${isl.intel.known} known · ${isl.intel.fresh} fresh`, c, '#c8b3ff');

    // What it makes.
    if (isl.produces && isl.produces.length) {
      this._section(ctx, 'PRODUCES', c);
      this._chipRow(ctx, isl.produces, c);
    }

    // Relations (reputation).
    if ((isl.allies && isl.allies.length) || (isl.rivals && isl.rivals.length)) {
      this._section(ctx, 'RELATIONS', c);
      for (const a of (isl.allies || [])) this._relation(ctx, '▲', name(ctxt.islandsById, a.id), a.v, PALETTE.good, c);
      for (const r of (isl.rivals || [])) this._relation(ctx, '▼', name(ctxt.islandsById, r.id), r.v, PALETTE.bad, c);
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
      c.y += 8; this._banner(ctx, '☠ BLACK FLAG — PIRATE', '#e04a5a', c);
      if (s.bounty > 0) { c.y += 6; this._banner(ctx, `Bounty: ${fmt(s.bounty)} g on this head`, '#ffd166', c); }
    } else if (s.privateer) {
      c.y += 8; this._banner(ctx, '⚔ PRIVATEER — pirate-hunter', '#6fa8d8', c);
    }

    // Errand banner (merchants only).
    const goal = GOAL[s.reason] || (s.reason ? { label: cap(s.reason), color: PALETTE.panelText } : null);
    if (goal && !s.pirate && !s.privateer) { c.y += 8; this._banner(ctx, goal.label, goal.color, c); }

    // Captain — identity, experience, personality, and how the wind sits for them.
    if (s.captain) this._captain(ctx, s, ctxt, c);

    // Crew — morale, provisions, grog, and whether they're about to rise up.
    if (s.morale != null) this._crew(ctx, s, c);

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
    this._gauge(ctx, 'Seamanship', `${Math.round((cn.skill || 0) * 100)}%  ·  ${cn.xp} xp`, cn.skill || 0, '#8ee6a0', c);
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
    ctx.restore();
    c.y = top + size + 2;
    const loy = isl.loyalty != null ? isl.loyalty : 1;
    if (isl.rebellion) this._banner(ctx, '🔥 In open rebellion — the port is aflame', '#ff5b30', c);
    this._gauge(ctx, 'Loyalty', `${Math.round(loy * 100)}%`, loy, loyaltyColor(loy), c);
    const st = loyaltyStatus(isl);
    this._kv(ctx, 'Populace', st.label, c, st.color);
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
    if (s.revolt) this._banner(ctx, '⚔ Crew in revolt — dead in the water', '#ff5b4a', c);
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
    ctx.fillText(clip(ctx, title, c.cw - bw - 8), c.cx, c.y);
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
    ctx.save();
    ctx.font = '600 10.5px system-ui, sans-serif';
    ctx.fillStyle = PALETTE.hudDim;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, c.cx, c.y);
    ctx.strokeStyle = PALETTE.panelEdge; ctx.lineWidth = 1;
    const tw = ctx.measureText(label).width;
    ctx.beginPath(); ctx.moveTo(c.cx + tw + 8, c.y - 3); ctx.lineTo(c.cx + c.cw, c.y - 3); ctx.stroke();
    ctx.restore();
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

  _banner(ctx, text, color, c) {
    c.y += 20;
    ctx.save();
    roundRect(ctx, c.cx, c.y - 15, c.cw, 22, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, c.cx + 10, c.y - 4);
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

  _relation(ctx, arrow, nm, v, color, c) {
    c.y += 16;
    ctx.save();
    ctx.font = '12.5px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color; ctx.textAlign = 'left';
    ctx.fillText(arrow, c.cx, c.y);
    ctx.fillStyle = PALETTE.panelText;
    ctx.fillText(clip(ctx, nm, c.cw - 60), c.cx + 14, c.y);
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
