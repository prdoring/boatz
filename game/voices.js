// Voice catalogue loader — assembles the first-person "logbook" writing STYLES the chronicler
// (game/ui/chronicle-narrate.js) narrates each keeper's regime in. A style file need only carry the
// flavour it wants; it is layered over shared defaults so it always renders cleanly:
//
//   data/chronicle-voice.json   (structural + third-person legacy base: gapBuckets, episode, ordinals,
//                                 frame templates, recur classes, connectives, …)
//     └─ data/voices/_defaults.json   (first-person scaffolding: pronoun.first, handover templates, …)
//          └─ data/voices/<id>.json   (one authored style: its diction, connectives, coda, kind reframes)
//
// Loading is fail-soft and one-time (at boot): the manifest + each style are dynamically imported (JSON
// import attributes, same as the static imports elsewhere); any missing/broken file is skipped, and if
// the whole thing fails the caller still gets a usable base-only registry (the chronicler then falls
// back to its legacy third-person narration). The result is passed to narrate() as `voices`.

import BASE from '/data/chronicle-voice.json' with { type: 'json' };

// Recursive merge: objects merge key-by-key; arrays and leaf values are REPLACED by the override (so a
// style swaps a phrase list wholesale rather than appending to the base's). Never mutates the inputs.
function merge(base, over) {
  if (Array.isArray(over) || over === null || typeof over !== 'object') return over;
  if (Array.isArray(base) || base === null || typeof base !== 'object') return { ...over };
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

const importJson = (path) => import(path, { with: { type: 'json' } }).then((m) => m.default);

/**
 * Load the style registry. Returns `{ base, byId, ids }`:
 *   base  — the structural/legacy voice (also the per-keeper fallback)
 *   byId  — id → fully-merged first-person voice
 *   ids   — the ordered id list the client indexes with `voiceSeed % ids.length`
 * With no styles (missing manifest / all failed) `ids` is empty and the chronicler narrates in LEGACY mode.
 */
export async function loadVoices() {
  const reg = { base: BASE, byId: {}, ids: [] };
  let defaults = {};
  try { defaults = await importJson('/data/voices/_defaults.json'); } catch { /* first-person defaults absent → styles inherit only the base */ }
  const scaffold = merge(BASE, defaults);

  let manifest = null;
  try { manifest = await importJson('/data/voices/index.json'); } catch { /* no manifest → base-only registry */ }
  const styleIds = (manifest && Array.isArray(manifest.styles)) ? manifest.styles : [];

  const loaded = await Promise.all(styleIds.map(async (id) => {
    try { return [id, merge(scaffold, await importJson(`/data/voices/${id}.json`))]; }
    catch { return null; } // a broken style file is skipped, never fatal
  }));
  for (const entry of loaded) {
    if (!entry) continue;
    reg.byId[entry[0]] = entry[1];
    reg.ids.push(entry[0]);
  }
  return reg;
}
