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
// A stable, RNG-free "fires roughly one-in-N" gate keyed on the event id. Used to make recurrence /
// cross-ref callbacks OCCASIONAL garnish rather than a tag on every single deed — the deed's own
// `say` variance carries the log, and a "my seventh such prize" lands now and then instead of always.
function gate(id, salt, oneIn) { return hash(id + ':' + salt) % oneIn === 0; }
// The stable per-event key: the live tail carries `id`, deep DB rows carry `seq` (same monotonic value).
function eid(e) { return e.id != null ? e.id : e.seq; }

// Collapse maximal runs of CONSECUTIVE same-kind "status" deeds the sim emits over and over (a refit
// that keeps coming up short, voyage-count milestones, patrol commissions, aid given, shore batteries) —
// otherwise a keeper's log restates "no canvas to mend me" forty times over. Keeps the LAST of each run
// (the latest milestone / most recent instance), tagging it `_repeat` so the composer can note the
// recurrence ONCE instead of repeating it. Only kinds named in `cfg` are touched; deeds with their own
// variety (plunder/raids/hunts via recur+`say`) are left alone. Regime markers never merge. Pure,
// left-to-right → a collapsed run depends only on the entries within it, so earlier blocks stay stable.
function collapseRuns(list, cfg) {
  if (!cfg || !Array.isArray(list) || list.length < 2) return list;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const strat = (!(e.data && e.data.regime)) && cfg[e.kind];
    if (!strat) { out.push(e); continue; }
    let j = i;
    while (j + 1 < list.length && list[j + 1].kind === e.kind && !(list[j + 1].data && list[j + 1].data.regime)) j++;
    const n = j - i + 1;
    out.push(n > 1 ? { ...list[j], _repeat: n, _repeatStrat: strat } : list[j]);
    i = j;
  }
  return out;
}
// The recurrence garnish for a collapsed run ("… time and again") — occasional, and only for the
// wearying 'toil' kinds (a shortfall, a bombardment) where the repetition IS the point; a milestone
// ('last') just shows its latest value. Keyed on the event id so it's stable and lands now and then.
function repeatGarnish(e, voice, id) {
  if (!(e._repeat >= 3) || e._repeatStrat !== 'toil') return null;
  const pool = voice.repeated || [];
  if (!pool.length || !gate(id, 'again', 2)) return null;
  return { text: pool[hash(id + ':again') % pool.length], role: 'callback', kind: e.kind };
}
// Pick from a pool by stable id-hash, but avoid immediately repeating the LAST pick (a keeper's log
// shouldn't open five straight episodes with the same "A season on."). `slot` names the anti-repeat
// memory on `state`. Deterministic + prefix-stable: the avoided value comes only from earlier entries.
function pickVaried(pool, id, salt, state, slot) {
  if (!Array.isArray(pool) || !pool.length) return '';
  let idx = hash(id + ':' + salt) % pool.length;
  if (pool.length > 1 && pool[idx] === state[slot]) idx = (idx + 1) % pool.length;
  state[slot] = pool[idx];
  return pool[idx];
}

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
// Tokens for a `say` deed-variant: the keeper's pronoun (so a style's "I" or "we" flows through) plus
// the sim's structured facts, numbers pre-formatted and names given safe fallbacks. Kept permissive so a
// template that reaches for a fact the event lacks degrades to a neutral word rather than a hole.
function sayTokens(data, we, wecap, us, our) {
  const d = data || {};
  return {
    ...d, we, wecap, us, our,
    foe: d.foeName || 'her', foeName: d.foeName || 'her', foeHome: d.foeHome || 'a far coast',
    goods: d.goods != null ? fmt(d.goods) : 'a load', gold: d.gold != null ? fmt(d.gold) : 'good',
    food: d.food != null ? fmt(d.food) : 'her stores', paid: d.paid != null ? fmt(d.paid) : '',
  };
}
function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function nmeOf(map, id) { const i = map && map.get && map.get(id); return i ? i.name : ''; }
// Pool a style's OWN handover/coda line(s) with the shared _defaults pool for the same slot, so a fleet
// of logs reads fresh while the style's signature still lands about half the time. The style lines are
// weighted up to the size of the shared pool (persona ≈ 50%), duplicates dropped, and the pick is a
// STABLE id-hash (never reshuffles on a re-render → prefix-stable). Either input may be a string or array.
function asList(v) { return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []); }
function pickPooled(styleVal, defVal, key) {
  const s = asList(styleVal);
  const seen = new Set(s);
  const extra = asList(defVal).filter((x) => !seen.has(x));
  let pool;
  if (!s.length) pool = extra;
  else if (!extra.length) pool = s;
  else { pool = []; const w = extra.length; for (const line of s) for (let i = 0; i < w; i++) pool.push(line); pool.push(...extra); }
  return pool.length ? pool[hash(key) % pool.length] : '';
}
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

// ── first-person voicing of a factual clause (LOGBOOK mode) ─────────────────────────────────────
// The sim writes events in the THIRD person (they double as the news ticker). In a keeper's own
// logbook we fold the subject's own name → we/us/our and the current keeper's name → I/me/my, with
// light verb agreement + a couple of idioms. CONSERVATIVE: only the subject's exact name and the
// current keeper's exact name are rewritten, so foes and other actors stay third-person, and anything
// unrecognised is left exactly as the sim wrote it (a fact recorded in the log). Purely cosmetic.
function rx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 3rd-person-singular present → base form, for the small CLOSED set the sim's event strings emit.
const BASE_VERB = {
  flies: 'fly', flourishes: 'flourish', enters: 'enter', posts: 'post', presses: 'press', carries: 'carry',
  turns: 'turn', sails: 'sail', roves: 'rove', runs: 'run', knows: 'know', breaks: 'break', grips: 'grip',
  passes: 'pass', seizes: 'seize', bears: 'bear', drives: 'drive', raids: 'raid', bombards: 'bombard',
  makes: 'make', sends: 'send', holds: 'hold', strikes: 'strike', hoists: 'hoist', beats: 'beat',
};
const LEX_VERB = Object.keys(BASE_VERB).join('|');
// After a 1st-person subject is introduced, agree the verb that immediately follows it.
function fixAgreement(t) {
  t = t.replace(/\bI (?:is|are|were)\b/g, m => m === 'I were' ? 'I was' : 'I am').replace(/\bI has\b/g, 'I have');
  t = t.replace(/\b(We|we) is\b/g, '$1 are').replace(/\b(We|we) was\b/g, '$1 were').replace(/\b(We|we) has\b/g, '$1 have');
  return t.replace(new RegExp('\\b(I|We|we) (' + LEX_VERB + ')\\b', 'g'), (_, p, v) => p + ' ' + (BASE_VERB[v] || v));
}
// Event kinds that concern the subject ALONE → a bare "her/his/its/she" unambiguously refers to us.
// Split by subject kind: a SHIP event (maiden/wreck…) is ALSO tagged with its home island, so it
// surfaces in the ISLAND's log too — there the ship's "her" must NOT be folded to the island.
const SHIP_SELF = new Set(['maiden', 'voyages', 'bearings', 'wreck', 'stormloss', 'adrift', 'starve', 'launch', 'shun', 'reroute', 'careen']);
const ISLAND_SELF = new Set(['boom', 'goldenage', 'popmilestone', 'longpeace', 'neworder', 'ambition', 'overreach',
  'haven', 'redeemed', 'contract', 'contractdone', 'famine', 'recover', 'blight', 'plague',
  // Magistrate POLICY beats — a port's own decisions, so its her/its folds to our/we in its log.
  'workshop', 'derelict', 'taxup', 'taxcut', 'tariff', 'publicworks', 'corruption', 'graftseized']);
function firstPersonize(text, o) {
  const { name, person, title, lead, cap, obj, poss, singular, isShip, kind } = o;
  let t = String(text);
  // 1) leading subject name → the keeper's pronoun (verb agreement handled by fixAgreement below).
  if (lead && name && t.indexOf(name + ' ') === 0) t = lead + ' ' + t.slice(name.length + 1);
  // 2) the keeper themselves → I / me / my (drop the "Capt." title first so both forms fold alike).
  if (person) {
    const C = rx(person);
    if (title) t = t.replace(new RegExp(rx(title) + C, 'g'), person);
    if (name) t = t.replace(new RegExp(C + ' of ' + rx(name), 'g'), 'I'); // "Capt. X of the Ship was raised…" → "I was raised…"
    t = t.replace(new RegExp(C + "['’]s", 'g'), 'my');
    t = t.replace(new RegExp('\\b(under|by|to|with|from|of|on|beside|against|for) ' + C + '\\b', 'g'), '$1 me');
    t = t.replace(new RegExp('\\b' + C + '\\b', 'g'), 'I');
  }
  // 3) the subject's own name (mid-clause) → object / possessive, plus a couple of idioms.
  if (name) {
    const N = rx(name);
    // "The privateer <us>" reads as a title of ourselves: at a clause head it's the subject, else the object.
    t = t.replace(new RegExp('^[Tt]he privateer ' + N + '\\b'), cap).replace(new RegExp('\\b[Tt]he privateer ' + N + '\\b', 'g'), obj);
    t = t.replace(new RegExp('the head of ' + N, 'g'), 'my head'); // a bounty is on the captain's head
    t = t.replace(new RegExp(N + "['’]s", 'g'), poss);
    if (!isShip) t = t.replace(new RegExp('\\b(?:on|at|in) ' + N + '\\b', 'g'), 'here');
    t = t.replace(new RegExp(N + '\\b', 'g'), obj);
    // Self-referential her/his/its/she — only for events that concern THIS subject alone (a ship event
    // riding in an island's log, or vice-versa, keeps its own third-person pronouns).
    if ((isShip ? SHIP_SELF : ISLAND_SELF).has(kind)) {
      t = t.replace(/\b(?:her|his|its)\b/g, poss).replace(/\bshe\b/g, singular ? 'I' : 'we').replace(/\bherself\b/g, singular ? 'myself' : 'ourselves');
      // In the keeper's OWN log, "under Capt. <me>" is redundant ("we starved at sea under me" →
      // "we starved at sea") — the whole book is under this hand. Drop it in self-events only.
      t = t.replace(/\s+(?:under|by) me\b/g, '');
      // "the Storm Wraith of {us}" (a ship of our port) reads as a possessive: "of ours".
      t = t.replace(/\bof us\b/g, 'of ours');
    }
  }
  // A self-event that names both the ship (folded to us/me) and its keeper ("under Capt. <me>")
  // collapses to "me under me" / "us under me" — keep the ship, drop the redundant tail. Then mop up
  // any doubled article a fold or a legacy sim row left behind ("the stricken the" → "the stricken").
  t = t.replace(/\b(me|us) (?:under|by) me\b/g, '$1').replace(/\b(the|a|an) \1\b/gi, '$1');
  return fixAgreement(t);
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

// ── closing coda (present-day status, from LIVE snapshot) — pooled with _defaults for variety ──
function buildCoda(kind, data, voice, ctx, defaults, seed) {
  const c = (voice.coda && voice.coda[kind]) || {};
  const dc = (defaults && defaults.coda && defaults.coda[kind]) || {};
  const key = kind === 'ship' ? (data.pirate ? 'pirate' : 'default') : (data.haven ? 'haven' : 'default');
  const tmpl = pickPooled(c[key], dc[key], String(seed) + ':coda:' + key + ':' + (data.name || ''))
    || pickPooled(c.default, dc.default, String(seed) + ':coda:default:' + (data.name || ''));
  if (!tmpl) return null;
  let text;
  if (kind === 'ship') {
    const bfrag = c.bounty || dc.bounty || '';
    const bounty = data.bounty > 0 && bfrag ? subst(bfrag, { bounty: fmt(data.bounty) }) : '';
    text = fill(tmpl, { name: data.name || 'She', ship: data.name || 'She', home: nmeOf(ctx.islandsById, data.homeId), bounty });
  } else {
    // {name} and {place} are aliases here — styles authored their island coda with either token.
    text = fill(tmpl, { name: data.name, place: data.name, population: fmt(data.population), magName: data.magistrate ? data.magistrate.name : 'no lawful ruler' });
  }
  // The coda is one sentence and often opens on the (lowercase-by-design) vessel name — capitalize it.
  return text ? { text: cap(text) } : null;
}

// ── one clause's recurrence / cross-actor callback (accent run), or nothing ──
// `gated` (LOGBOOK mode only) makes callbacks OCCASIONAL — deed variance there comes from the `say`
// pools, so a "my seventh such prize" tag lands ~1-in-3 rather than on every deed. LEGACY mode passes it
// false: there the callback IS the only variance a repeated deed gets, so it always fires (and the
// long-standing legacy tests still hold).
function appendCallback(runs, e, id, kindCfg, state, voice, isShip, gated) {
  // Layer B: maintain the recurring deed CLASS count ALWAYS (so ordinals stay consistent even on a
  // clause where a cross-actor callback wins the single visible slot below).
  let recurText = '';
  const recur = kindCfg.recur;
  if (recur) {
    const cls = recur.class || e.kind;
    const n = (state.counts.get(cls) || 0) + 1;
    state.counts.set(cls, n); // count ALWAYS (ordinals stay consistent); only the visible phrase is gated
    if (n >= 2 && (!gated || gate(id, 'rgate', 3)) && Array.isArray(recur.phrases)) {
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
    if (seen >= 2 && (!gated || gate(id, 'xgate', 3))) {
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
  const raw = Array.isArray(entries) ? entries : [];
  const list = collapseRuns(raw, voice.collapse); // fold repetitive status-deed spam (no-op without a `collapse` map)
  const kind = subject.kind;
  const isShip = kind === 'ship';
  const data = subject.data || {};
  const pron = (voice.pronoun && voice.pronoun[kind]) || { subject: 'it', elide: false };

  const title = isShip
    ? (data.name || (ctx.shipLabel ? ctx.shipLabel(subject.id) : 'A ship'))
    : (data.name || 'A port');
  const frame = { title, epigraph: (isShip ? shipEpigraph(data, voice, ctx) : islandEpigraph(data, voice)) || null };
  const coda = buildCoda(kind, data, voice, ctx);
  const meta = { count: raw.length, sinceDay: raw.length ? raw[0].day : null, truncated: !!subject.truncated };

  if (!list.length) {
    const q = pickPooled(voice.quiet && voice.quiet[kind], null, 'legacy:quiet:' + kind + ':' + (data.name || ''));
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
    const garnish = repeatGarnish(e, voice, id); // note a collapsed run's recurrence, once
    if (garnish) runs.push(garnish);
    if (!isPivot) appendCallback(runs, e, id, kindCfg, state, voice, isShip, false); // LEGACY: always fire

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

/** The keeper's note on taking up the book, in THEIR style, keyed by how they came to it (`cause`). Each
 *  slot pools the style's signature line(s) with the shared `_defaults` variants, so every hand-off reads
 *  fresh across a fleet of logs (picked stably by keeper: seed + name + cause). */
function handoverText(style, kind, narr, isFounder, data, ctx, defaults) {
  const h = (style.handover && style.handover[kind]) || {};
  const dh = (defaults && defaults.handover && defaults.handover[kind]) || {};
  let key = isFounder ? 'founder' : narr.cause;
  if (!isFounder && h[key] === undefined && dh[key] === undefined) key = 'successor'; // unknown cause → generic note
  const stem = String(narr.seed) + ':' + (narr.name || '') + ':';
  const tmpl = pickPooled(h[key], dh[key], stem + key)
    || pickPooled(h.successor, dh.successor, stem + 'succ')
    || pickPooled(h.founder, dh.founder, stem + 'fnd');
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
  const raw = Array.isArray(entries) ? entries : [];
  const kind = subject.kind;
  const isShip = kind === 'ship';
  const data = subject.data || {};
  const base = reg.base || {};
  // Fold away the sim's repetitive status-deed spam before narrating (the walk sees clean beats).
  const list = collapseRuns(raw, base.collapse);
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
  const coda = buildCoda(kind, data, liveStyle, ctx, reg.defaults, liveSeed);
  const meta = { count: raw.length, sinceDay: raw.length ? raw[0].day : null, truncated: !!subject.truncated };

  const blocks = [];
  const subjName = data.name;
  const state = { counts: new Map(), foes: new Map(), sayIdx: new Map() };
  let episode = null, prev = null, sentenceCount = 0, joinCount = 0, suppressDateline = false;
  let cur = null, curStyle = base;

  const closeEpisode = () => { if (episode) { ensureTerminal(episode.runs); blocks.push(episode); episode = null; } };
  const setNarrator = (narr) => { cur = narr; curStyle = styleAt(narr.seed); };
  const pushHandover = (e, narr, isFounder) => {
    closeEpisode();
    if (e) blocks.push({ type: 'dateline', text: dateline(e, ctx), bucket: prev ? bucketFor(e.day - prev.day, curStyle).key : 'start', seed: narr.seed });
    const text = handoverText(styleAt(narr.seed), kind, narr, isFounder, data, ctx, reg.defaults);
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
    const q = pickPooled(curStyle.quiet && curStyle.quiet[kind], reg.defaults && reg.defaults.quiet && reg.defaults.quiet[kind], String(liveSeed) + ':quiet:' + kind);
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
      if (!suppressDateline) blocks.push({ type: 'dateline', text: dateline(e, ctx), bucket: bucket ? bucket.key : 'start', seed: cur ? cur.seed : liveSeed });
      suppressDateline = false;
      episode = { type: 'prose', runs: [], kinds: [], seed: cur ? cur.seed : liveSeed };
      sentenceCount = 0; joinCount = 0;
    }
    const runs = episode.runs;

    const clauseText = e.text || '';
    const kindCfg = (curStyle.kinds && curStyle.kinds[e.kind]) || {};
    const isPivot = !!(kindCfg.pivot && Array.isArray(kindCfg.phrases) && kindCfg.phrases.length);
    // A `say` deed-variant only fires when the event carries the STRUCTURED data it needs — a named foe,
    // and (for plunder) the loot numbers. Text-only events (older DB rows written before the sim carried
    // this data) fall through to firstPersonize on the sim's own sentence, which still reads first-person
    // and still has the real figures baked in. So no variant ever renders "a load … goodg" from a hole.
    const d0 = e.data;
    const hasSay = !!(kindCfg.say && Array.isArray(kindCfg.say) && kindCfg.say.length
      && d0 && d0.foeName && (e.kind !== 'plunder' || d0.gold != null));
    // Only a SHIP may speak in the singular "I"; an ISLAND is always a collective ("we/us/our"), so the
    // port never folds to "me"/"my" (the magistrate's "I" comes from the person-name fold, not here).
    const pr = (isShip && curStyle.pronoun && curStyle.pronoun[kind]) || {};
    const firstCap = isShip ? (pr.first || 'We') : 'We';
    const firstLow = isShip ? (pr.subject || firstCap.toLowerCase()) : 'we';
    const singular = /^i$/i.test(firstLow);
    const object = isShip ? (pr.object || (singular ? 'me' : firstLow === 'we' ? 'us' : firstLow)) : 'us';
    const possessive = isShip ? (pr.possessive || (singular ? 'my' : firstLow === 'we' ? 'our' : firstLow + "'s")) : 'our';
    const personName = cur ? cur.name : null; // the keeper narrating THIS regime (captain / magistrate)
    const startsWithName = subjName && clauseText.indexOf(subjName + ' ') === 0;
    // Cap how many clauses ride one sentence: after `maxJoin` soft joins we break a fresh sentence
    // rather than stringing "A and B and C and D" into a run-on that reuses the same "and" over.
    const maxJoin = (curStyle.episode && curStyle.episode.maxJoin != null) ? curStyle.episode.maxJoin : 1;
    // Fold a name-leading clause into the first person; a clause that doesn't open on our own name
    // (e.g. "Rebellion erupts on …") stays as the sim wrote it — a fact recorded in the log.
    let continues = sentenceCount > 0 && startsWithName && !isPivot && !hasSay && joinCount < maxJoin;
    let leadIn = false; // a connective riding as an adverbial lead-in INTO a non-continuing clause

    if (sentenceCount === 0) {
      const conn = prev ? pickVaried(curStyle.connectives[bucket.key], id, 'conn', state, 'lastConn') : '';
      if (conn && startsWithName && !isPivot && !hasSay) { runs.push({ text: conn, role: 'connective' }); continues = true; }
      // A non-name clause after a connective flows as an adverbial lead-in ("A season on, Oakshoal
      // commissioned us…") instead of stranding the connective as a "When the season had turned."
      // fragment. Pivots alone keep their own full-sentence break.
      else if (conn && !isPivot) { runs.push({ text: conn, role: 'connective' }); leadIn = true; }
      else if (conn) runs.push({ text: toSentenceBreak(conn), role: 'connective' });
    } else if (continues) {
      const j = pickVaried(curStyle.join, id, 'join', state, 'lastJoin');
      if (j) { runs.push({ text: j, role: 'join' }); joinCount++; } else continues = false;
    }
    if (!continues && !leadIn && sentenceCount > 0) { ensureTerminal(runs); joinCount = 0; }

    let body, role;
    if (isPivot) { body = pick(kindCfg.phrases, id, 'pivot'); role = 'pivot'; }
    else if (hasSay) {
      // Round-ROBIN the deed variants (not a plain id-hash): a per-kind counter walks the whole pool
      // before any phrasing repeats, so a prolific keeper never lands the same distinctive line twice in a
      // row. A per-entity+kind offset staggers WHERE each log starts in the pool (so two ships don't both
      // open on variant 0). Stable under append (earlier counters never move) and under category filtering
      // (every deed of one kind shares a category, so the shown sequence — hence each index — is unchanged).
      const pool = kindCfg.say;
      const si = state.sayIdx.get(e.kind) || 0; state.sayIdx.set(e.kind, si + 1);
      const off = hash(subjName + ':' + e.kind);
      body = fixAgreement(subst(pool[(off + si) % pool.length], sayTokens(e.data, firstLow, firstCap, object, possessive)));
      role = 'clause';
    }
    else {
      // Fold the sim's third-person fact into this keeper's first person. A name-leading clause takes the
      // keeper's pronoun (lower after a soft join, capital at a sentence head); the rest is rewritten too.
      const lead = startsWithName ? (continues ? firstLow : firstCap) : null;
      body = firstPersonize(clauseText, { name: subjName, person: personName, title: isShip ? 'Capt. ' : '',
        lead, cap: firstCap, obj: object, poss: possessive, singular, isShip, kind: e.kind });
      role = 'clause';
    }
    body = stripTerminal(body);
    if (!continues && !leadIn) body = cap(body); // a lead-in clause keeps its natural casing after the comma
    runs.push({ text: body, role, kind: e.kind });
    const garnish = repeatGarnish(e, curStyle, id); // note a collapsed run's recurrence, once
    if (garnish) runs.push(garnish);
    if (!isPivot) appendCallback(runs, e, id, kindCfg, state, curStyle, isShip, true); // LOGBOOK: occasional (say pools carry variance)

    episode.kinds.push(e.kind);
    sentenceCount++;
    prev = e;
  }
  closeEpisode();

  return { frame, blocks, coda, meta };
}
