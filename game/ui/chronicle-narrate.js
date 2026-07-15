// The chronicler — turns an entity's terse, ordered event log into a flowing TALE. PURE: no
// Math.random, no Date, no imports (so it unit-tests browserless and never flickers). The sim stays
// the sole source of dated FACTS; this composes them for the eye.
//
// TWO modes, chosen by the shape of the `voices` argument:
//   • LEGACY (a single parsed voice object) — one restrained third-person "ship's-chronicle" narration:
//     time connectives between episodes, recurrence callbacks ("her third prize"), an opening frame +
//     closing coda from the LIVE snapshot. This is what the tests drive.
//   • LOGBOOK (a { base, byId, ids } style REGISTRY) — the durable log read as a FIRST-PERSON book handed
//     from keeper to keeper. Each captain/magistrate is assigned an opaque `voiceSeed`; the client maps
//     it onto the loaded style catalogue (seed % ids.length) so each keeper writes in a DISTINCT hand.
//     A regime-change event (data.regime, emitted by the sim at mutiny/prize/pirate/recovered/overthrow)
//     splits the log into spans; each span opens with the new keeper's HANDOVER note and narrates its
//     deeds in the first person ("We took a fat merchant…"). Falls back to LEGACY when no styles loaded.
//
// It returns a RENDER MODEL (colored runs, not a raw string); the InfoPanel resolves run roles → palette
// colors and draws it. Vocabulary is data (data/chronicle-voice.json + data/voices/*.json).
//
// Stability contract: every wording choice keys off the IMMUTABLE event id via a stable hash, and the
// walk is a strict left-to-right fold (recurrence counts, episode boundaries, and regime spans depend
// only on preceding entries + the marker's own immutable data). So appending a fresh live event only
// appends the newest clause — earlier blocks never shift.

// ── stable, RNG-free selection (FNV-1a over the id, mirroring game/sim/ship.js idHash) ──
function hash(str) {
  let x = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x >>> 0;
}
function pick(arr, id, salt) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[hash(id + ':' + salt) % arr.length];
}
// The stable per-event key: the live tail carries `id`, deep DB rows carry `seq` (same monotonic value).
function eid(e) { return e.id != null ? e.id : e.seq; }

// ── small text helpers ──
// subst: token replacement + collapse of the doubled spaces an EMPTY token leaves. It deliberately
// does NOT trim, so a sub-clause's intended leading space (" under {mag}") survives concatenation.
function subst(template, tokens) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (tokens[k] != null ? String(tokens[k]) : ''))
    .replace(/ {2,}/g, ' ');
}
// fill: subst for a FINAL string (epigraph/coda/handover), trimmed. Optional clauses are omitted whole
// (not emptied), so no orphaned punctuation is produced.
function fill(template, tokens) { return subst(template, tokens).trim(); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function nmeOf(map, id) { const i = map && map.get && map.get(id); return i ? i.name : ''; }
/** An ordinal WORD from the voice list, else an Nth suffix ("11th"). */
function ordinalWord(n, voice) {
  const list = voice.ordinals || [];
  if (list[n]) return list[n];
  const v = n % 100, s = ['th', 'st', 'nd', 'rd'];
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
/** Turn a lead-in connective into its own sentence break ("A season later, " → "A season later. ").
 *  A style may end a connective in trailing punctuation or a conjunction ("A year on, and ", "So it went — ")
 *  to flow into the "…and we" path; when we instead break a fresh sentence we strip that dangle so we never
 *  get "…and. Clause" or "…—. Clause". If the connective is already a full sentence, we just space it. */
const TRAIL = /[\s,;:—–…-]+$/;
function toSentenceBreak(conn) {
  let s = String(conn).replace(TRAIL, '');                        // drop trailing whitespace / non-terminal punctuation
  s = s.replace(/[\s,;:—–…-]+(?:and|but|then|so|yet|nor|or)$/i, ''); // + a dangling conjunction
  s = s.replace(TRAIL, '');
  return /[.!?]$/.test(s) ? s + ' ' : s + '. ';
}
// Drop a clause's OWN trailing sentence punctuation. The sim text is a full sentence ("…home to
// Ruststead."), but the composer joins clauses itself — so we strip the period and let the composer
// decide whether the next clause continues it (comma) or breaks a fresh sentence.
function stripTerminal(s) { return String(s).replace(/[\s.]+$/, ''); }
// Close the current sentence: ensure the last non-empty run ends in terminal punctuation. The prose
// renderer space-separates EVERY token, so a period must ride the preceding word's run (a lone ". "
// run would float as " . " between words). Idempotent; leaves ! and ? as they stand.
function ensureTerminal(runs) {
  for (let i = runs.length - 1; i >= 0; i--) {
    const t = runs[i].text;
    if (t && t.trim()) {
      const trimmed = t.replace(/\s+$/, '');
      if (!/[.!?…]$/.test(trimmed)) runs[i] = { ...runs[i], text: trimmed + '.' };
      return;
    }
  }
}

// ── which day-gap bucket a jump falls in ──
function bucketFor(gap, voice) {
  const bs = voice.gapBuckets || [];
  for (const b of bs) if (b.maxDays == null || gap <= b.maxDays) return b;
  return bs[bs.length - 1] || { key: 'long' };
}

// ── an episode's dateline label ("Autumn, Day 68" when season config is known, else "Day 68") ──
function dateline(e, ctx) {
  if (ctx && Array.isArray(ctx.seasons) && ctx.seasons.length && ctx.seasonDays) {
    const idx = Math.floor(Math.max(0, e.day - 1) / ctx.seasonDays) % ctx.seasons.length;
    const nm = ctx.seasons[idx];
    if (nm) return `${nm}, Day ${e.day}`;
  }
  return `Day ${e.day}`;
}

// ── opening frame (identity, from LIVE snapshot — entry-independent) ──
function shipEpigraph(data, voice, ctx) {
  const f = (voice.frame && voice.frame.ship) || {};
  const cn = data.captain || null;
  const captain = cn && cn.name ? subst(f.captain, { captainName: cn.name, rank: cn.rank || '' }) : '';
  const st = f.status || {};
  const status = data.pirate ? st.pirate : data.privateer ? st.privateer : st.default;
  return fill(f.template, { home: nmeOf(ctx.islandsById, data.homeId), type: data.type || 'vessel', captain, status: status || '' });
}
function islandEpigraph(data, voice) {
  const f = (voice.frame && voice.frame.island) || {};
  const mag = data.magistrate ? subst(f.magistrate, { magName: data.magistrate.name, magRank: data.magistrate.rank || '' }) : '';
  const primary = data.primary ? subst(f.primary, { primary: data.primary }) : '';
  return fill(f.template, { type: data.type || 'trading', magistrate: mag, primary });
}

// ── closing coda (present-day status, from LIVE snapshot) ──
function buildCoda(kind, data, voice, ctx) {
  const c = (voice.coda && voice.coda[kind]) || null;
  if (!c) return null;
  let text;
  if (kind === 'ship') {
    const tmpl = data.pirate ? c.pirate : c.default;
    const bounty = data.bounty > 0 && c.bounty ? subst(c.bounty, { bounty: fmt(data.bounty) }) : '';
    text = fill(tmpl, { name: data.name || 'She', home: nmeOf(ctx.islandsById, data.homeId), bounty });
  } else {
    const tmpl = data.haven ? c.haven : c.default;
    text = fill(tmpl, { name: data.name, population: fmt(data.population), magName: data.magistrate ? data.magistrate.name : 'no lawful ruler' });
  }
  // The coda is one sentence and often opens on the (lowercase-by-design) vessel name — capitalize it.
  return text ? { text: cap(text) } : null;
}

// ── one clause's recurrence / cross-actor callback (accent run), or nothing ──
function appendCallback(runs, e, id, kindCfg, state, voice, isShip) {
  // Layer B: maintain the recurring deed CLASS count ALWAYS (so ordinals stay consistent even on a
  // clause where a cross-actor callback wins the single visible slot below).
  let recurText = '';
  const recur = kindCfg.recur;
  if (recur) {
    const cls = recur.class || e.kind;
    const n = (state.counts.get(cls) || 0) + 1;
    state.counts.set(cls, n);
    if (n >= 2 && Array.isArray(recur.phrases)) {
      recurText = pick(recur.phrases, id, 'recur')
        .replace(/\{ord\}/g, ordinalWord(n, voice))
        .replace(/\{n\}/g, String(n));
    }
  }
  // Layer C: a named recurring FOE (ships only, needs the structured `data` payload) takes the slot.
  if (isShip && voice.crossref && voice.crossref.ship && e.data && (e.data.foeHome || e.data.foeName)) {
    const key = e.data.foeHome || e.data.foeName;
    const seen = (state.foes.get(key) || 0) + 1;
    state.foes.set(key, seen);
    if (seen >= 2) {
      const ph = pick(voice.crossref.ship, id, 'xref')
        .replace(/\{foeName\}/g, e.data.foeName || 'a vessel')
        .replace(/\{foeHome\}/g, e.data.foeHome || 'a distant port')
        .replace(/\{ord\}/g, ordinalWord(seen, voice));
      if (ph) { runs.push({ text: ph, role: 'callback', kind: e.kind }); return; } // one callback per clause
    }
  }
  if (recurText) runs.push({ text: recurText, role: 'callback', kind: e.kind });
}

/**
 * Compose an entity's tale.
 * @param entries ascending, already category-filtered `[{id,day,kind,text,seq,data?}]`
 * @param subject `{ kind:'ship'|'island', id, data: liveSnapshot, truncated? }`
 * @param voices  either a single parsed voice (LEGACY) or a style REGISTRY `{ base, byId, ids }` (LOGBOOK)
 * @param ctx     `{ islandsById, shipsById?, seasons?, seasonDays?, shipLabel? }`
 * @returns `{ frame:{title,epigraph}, blocks:[…], coda:{text}|null, meta:{count,sinceDay,truncated} }`
 */
export function narrate(entries, subject, voices, ctx = {}) {
  const isRegistry = !!(voices && voices.byId && Array.isArray(voices.ids) && voices.ids.length);
  if (isRegistry) return narrateLogbook(entries, subject, voices, ctx);
  // A registry with an empty catalogue still carries a usable base voice; unwrap it.
  const voice = (voices && voices.byId && voices.base) ? voices.base : (voices || {});
  return narrateLegacy(entries, subject, voice, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY — one restrained third-person narration (the original composer, unchanged in behaviour).
// ─────────────────────────────────────────────────────────────────────────────
function narrateLegacy(entries, subject, voice, ctx) {
  const list = Array.isArray(entries) ? entries : [];
  const kind = subject.kind;
  const isShip = kind === 'ship';
  const data = subject.data || {};
  const pron = (voice.pronoun && voice.pronoun[kind]) || { subject: 'it', elide: false };

  const title = isShip
    ? (data.name || (ctx.shipLabel ? ctx.shipLabel(subject.id) : 'A ship'))
    : (data.name || 'A port');
  const frame = { title, epigraph: (isShip ? shipEpigraph(data, voice, ctx) : islandEpigraph(data, voice)) || null };
  const coda = buildCoda(kind, data, voice, ctx);
  const meta = { count: list.length, sinceDay: list.length ? list[0].day : null, truncated: !!subject.truncated };

  if (!list.length) {
    const q = (voice.quiet && voice.quiet[kind]) || '';
    const blocks = q ? [{ type: 'prose', runs: [{ text: q, role: 'quiet' }], kinds: [] }] : [];
    return { frame, blocks, coda, meta };
  }

  const subjName = data.name;
  const state = { counts: new Map(), foes: new Map() };
  const blocks = [];
  let episode = null, prev = null, sentenceCount = 0;

  for (const e of list) {
    const id = eid(e);
    const gap = prev ? e.day - prev.day : 0;
    const bucket = prev ? bucketFor(gap, voice) : null;
    const startEpisode = !prev || gap > (voice.episode ? voice.episode.gapDays : 12)
      || sentenceCount >= (voice.episode ? voice.episode.maxSentences : 4);

    if (startEpisode) {
      if (episode) { ensureTerminal(episode.runs); blocks.push(episode); } // close the prior paragraph
      blocks.push({ type: 'dateline', text: dateline(e, ctx), bucket: bucket ? bucket.key : 'start' });
      episode = { type: 'prose', runs: [], kinds: [] };
      sentenceCount = 0;
    }
    const runs = episode.runs;

    const clauseText = e.text || '';
    const kindCfg = (voice.kinds && voice.kinds[e.kind]) || {};
    const isPivot = !!(kindCfg.pivot && Array.isArray(kindCfg.phrases) && kindCfg.phrases.length);
    const firstOverall = !prev;
    const startsWithName = subjName && clauseText.indexOf(subjName + ' ') === 0;
    let continues = !firstOverall && pron.elide && startsWithName && !isPivot;

    if (!firstOverall) {
      if (sentenceCount === 0) {
        const conn = pick(voice.connectives[bucket.key], id, 'conn') || '';
        if (continues && conn) runs.push({ text: conn, role: 'connective' });
        else { continues = false; if (conn) runs.push({ text: toSentenceBreak(conn), role: 'connective' }); }
      } else if (continues) {
        const j = pick(voice.join, id, 'join') || '';
        if (j) runs.push({ text: j, role: 'join' }); else continues = false;
      }
      if (!continues) ensureTerminal(runs);
    }

    let body, role;
    if (isPivot) { body = pick(kindCfg.phrases, id, 'pivot'); role = 'pivot'; }
    else {
      body = continues ? pron.subject + ' ' + clauseText.slice(subjName.length + 1) : clauseText;
      role = 'clause';
    }
    body = stripTerminal(body);
    if (!continues) body = cap(body);
    runs.push({ text: body, role, kind: e.kind });
    if (!isPivot) appendCallback(runs, e, id, kindCfg, state, voice, isShip);

    episode.kinds.push(e.kind);
    sentenceCount++;
    prev = e;
  }
  if (episode) { ensureTerminal(episode.runs); blocks.push(episode); }

  return { frame, blocks, coda, meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGBOOK — first-person, regime-segmented. Each span narrated in its keeper's assigned style.
// ─────────────────────────────────────────────────────────────────────────────

/** The keeper's note on taking up the book, in THEIR style, keyed by how they came to it (`cause`). */
function handoverText(style, kind, narr, isFounder, data, ctx) {
  const h = (style.handover && style.handover[kind]) || {};
  const key = isFounder ? 'founder' : (h[narr.cause] ? narr.cause : 'successor');
  const tmpl = h[key] || h.successor || h.founder || '';
  if (!tmpl) return '';
  const rank = narr.rank || '';
  return cap(fill(tmpl, {
    name: narr.name || (kind === 'ship' ? 'a new master' : 'a new ruler'),
    rank, rankc: rank ? ', ' + rank : '',
    type: data.type || (kind === 'ship' ? 'vessel' : 'port'),
    ship: data.name || 'the ship',
    home: nmeOf(ctx.islandsById, data.homeId) || 'her home port',
    place: data.name || 'the port',
    population: fmt(data.population),
  }));
}

function narrateLogbook(entries, subject, reg, ctx) {
  const list = Array.isArray(entries) ? entries : [];
  const kind = subject.kind;
  const isShip = kind === 'ship';
  const data = subject.data || {};
  const base = reg.base || {};
  const n = reg.ids.length;
  const styleAt = (seed) => reg.byId[reg.ids[((((seed >>> 0) || 0) % n) + n) % n]] || base;

  // The CURRENT keeper narrates the tail regime, the opening frame, and the closing coda.
  const person = isShip ? (data.captain || null) : (data.magistrate || null);
  const liveSeed = person && person.voiceSeed != null ? person.voiceSeed : 0;
  const liveStyle = styleAt(liveSeed);

  const title = isShip
    ? (data.name || (ctx.shipLabel ? ctx.shipLabel(subject.id) : 'A ship'))
    : (data.name || 'A port');
  const frame = { title, epigraph: (isShip ? shipEpigraph(data, liveStyle, ctx) : islandEpigraph(data, liveStyle)) || null };
  const coda = buildCoda(kind, data, liveStyle, ctx);
  const meta = { count: list.length, sinceDay: list.length ? list[0].day : null, truncated: !!subject.truncated };

  const blocks = [];
  const subjName = data.name;
  const state = { counts: new Map(), foes: new Map() };
  let episode = null, prev = null, sentenceCount = 0, suppressDateline = false;
  let cur = null, curStyle = base;

  const closeEpisode = () => { if (episode) { ensureTerminal(episode.runs); blocks.push(episode); episode = null; } };
  const setNarrator = (narr) => { cur = narr; curStyle = styleAt(narr.seed); };
  const pushHandover = (e, narr, isFounder) => {
    closeEpisode();
    if (e) blocks.push({ type: 'dateline', text: dateline(e, ctx), bucket: prev ? bucketFor(e.day - prev.day, curStyle).key : 'start' });
    const text = handoverText(styleAt(narr.seed), kind, narr, isFounder, data, ctx);
    if (text) blocks.push({ type: 'handover', runs: [{ text, role: 'handover', kind: narr.cause }], seed: narr.seed });
    sentenceCount = 0; suppressDateline = true; // the next factual clause opens a fresh, already-dated paragraph
  };

  // Founder = the FROM of the first regime change (else the live keeper, if command never changed hands).
  const firstMarker = list.find((e) => e.data && e.data.regime);
  const firstIsMarker = !!(list.length && list[0].data && list[0].data.regime);
  const lite = (p, fallbackSeed) => ({ name: p ? p.name : null, seed: p && p.voiceSeed != null ? p.voiceSeed : fallbackSeed, rank: p ? p.rank : '' });

  if (!list.length) {
    setNarrator({ ...lite(person, liveSeed), cause: 'founder' });
    pushHandover(null, cur, true);
    const q = (curStyle.quiet && curStyle.quiet[kind]) || '';
    if (q) blocks.push({ type: 'prose', runs: [{ text: q, role: 'quiet' }], kinds: [] });
    return { frame, blocks, coda, meta };
  }

  if (!firstIsMarker) {
    const from = firstMarker ? firstMarker.data.regime.from : null;
    setNarrator({ ...lite(from || person, liveSeed), cause: 'founder' });
    pushHandover(list[0], cur, true); // introduce the founder, dated to the first entry; leaves prev=null
  } else {
    setNarrator({ ...lite(list[0].data.regime.from, liveSeed), cause: 'founder' }); // provisional; the loop switches on entry 0
  }

  for (const e of list) {
    if (e.data && e.data.regime) {
      const m = e.data.regime;
      const to = m.to || {};
      setNarrator({ name: to.name, seed: to.voiceSeed != null ? to.voiceSeed : liveSeed, rank: to.rank, cause: m.cause });
      pushHandover(e, cur, false);
      prev = e; // subsequent gaps are measured from the handover moment
      continue;
    }

    const id = eid(e);
    const gap = prev ? e.day - prev.day : 0;
    const bucket = prev ? bucketFor(gap, curStyle) : null;
    const startEpisode = !episode || gap > (curStyle.episode ? curStyle.episode.gapDays : 12)
      || sentenceCount >= (curStyle.episode ? curStyle.episode.maxSentences : 4);

    if (startEpisode) {
      closeEpisode();
      if (!suppressDateline) blocks.push({ type: 'dateline', text: dateline(e, ctx), bucket: bucket ? bucket.key : 'start' });
      suppressDateline = false;
      episode = { type: 'prose', runs: [], kinds: [] };
      sentenceCount = 0;
    }
    const runs = episode.runs;

    const clauseText = e.text || '';
    const kindCfg = (curStyle.kinds && curStyle.kinds[e.kind]) || {};
    const isPivot = !!(kindCfg.pivot && Array.isArray(kindCfg.phrases) && kindCfg.phrases.length);
    const hasSay = !!(kindCfg.say && Array.isArray(kindCfg.say) && kindCfg.say.length);
    const pr = (curStyle.pronoun && curStyle.pronoun[kind]) || {};
    const firstCap = pr.first || 'We';
    const firstLow = pr.subject || firstCap.toLowerCase();
    const startsWithName = subjName && clauseText.indexOf(subjName + ' ') === 0;
    // Fold a name-leading clause into the first person; a clause that doesn't open on our own name
    // (e.g. "Rebellion erupts on …") stays as the sim wrote it — a fact recorded in the log.
    let continues = sentenceCount > 0 && startsWithName && !isPivot && !hasSay;

    if (sentenceCount === 0) {
      const conn = prev ? (pick(curStyle.connectives[bucket.key], id, 'conn') || '') : '';
      if (conn && startsWithName && !isPivot && !hasSay) { runs.push({ text: conn, role: 'connective' }); continues = true; }
      else { continues = false; if (conn) runs.push({ text: toSentenceBreak(conn), role: 'connective' }); }
    } else if (continues) {
      const j = pick(curStyle.join, id, 'join') || '';
      if (j) runs.push({ text: j, role: 'join' }); else continues = false;
    }
    if (!continues && sentenceCount > 0) ensureTerminal(runs);

    let body, role;
    if (isPivot) { body = pick(kindCfg.phrases, id, 'pivot'); role = 'pivot'; }
    else if (hasSay) { body = pick(kindCfg.say, id, 'say'); role = 'clause'; }
    else if (startsWithName) { body = (continues ? firstLow : firstCap) + ' ' + clauseText.slice(subjName.length + 1); role = 'clause'; }
    else { body = clauseText; role = 'clause'; }
    body = stripTerminal(body);
    if (!continues) body = cap(body);
    runs.push({ text: body, role, kind: e.kind });
    if (!isPivot) appendCallback(runs, e, id, kindCfg, state, curStyle, isShip);

    episode.kinds.push(e.kind);
    sentenceCount++;
    prev = e;
  }
  closeEpisode();

  return { frame, blocks, coda, meta };
}
