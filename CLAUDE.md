# BOATZ

A deep economic simulation of a pirate-age archipelago: hundreds of islands produce, price,
and trade goods; named captains sail voyages; crews mutiny; magistrates govern; piracy and
the naval response to it emerge from the economy. **There is no player and no gameplay** (see
`README.md` "Status"). The simulation is server-authoritative and lives in `game/sim/`; the
browser only renders snapshots.

It is built on **Pat_Engine**, a no-build, vanilla-JS, browser-native 2D engine (data-driven
art / VFX / sequences / sound + editors) that ships in this repo under `engine/` + `editors/`.
No bundler, no framework; the browser loads ES modules by absolute path and JSON via import
attributes. The Critter Garden art/music data under `data/` is retained as editor fixtures.

**📖 Read `AGENTS.md` before writing engine-facing code; it is the full guide for building on
the engine** (layering, leak-prevention rules, the sequence-first orchestration pattern, signal
callbacks, every subsystem API, and authoring shapes). `docs/sim-manual.html` is the LIVING
field manual for the simulation: every actor's decision path plus a register of known bugs;
update it in the same change whenever an actor's decisions change. `ENGINE.md` is the terse
API cheat-sheet; `README.md` is the public project readme (portfolio-facing, screenshots at
`docs/screenshots/boatz-*.jpg`, **no em dashes**); `docs/EDITORS.md` is the user-facing editor
guide.

## Non-negotiable rules — the simulation

A. **`game/sim/` is PURE and DETERMINISTIC.** No `Date.now`, no `Math.random`, no engine
   import, no network, no filesystem. Randomness comes only from the seeded streams in
   `rng.js`. A world must serialize, reload, and step identically (`tests/simSerialize.test.js`).
B. **No omniscience.** Cross-island reads go through the actor's own ship-carried beliefs
   (`beliefs.js` / `intel.js`), never a live scan of another port's truth. Actors are
   allowed to be wrong.
C. **Balance is data.** Tuning constants live in `data/economy.json` (~554 of them), not in
   `.js`. New magic numbers in sim code are a smell.
D. **Layers, not content.** New behaviour is a system reacting to existing state, never a
   scripted event that fires on cue.
E. **The chronicle is write-only from the sim's side.** `server/chronicle.js` observes
   `world.events`; a DB read back into the sim would break determinism.

## Non-negotiable rules — the engine (full detail in AGENTS.md)

1. **The engine must never know what game it runs.** No game noun (entity/state/sound/art
   id, gameplay constant) may appear under `engine/` or `editors/`. Test each line: *would
   it still make sense, unchanged, in a totally different game?* If no, it belongs in
   `game/` or `data/`.
2. **Layering & dependency direction:** `game/ → engine/` ✅, `game/ → data/` ✅,
   `engine/data/*.js → data/*.json` ✅ (the only engine→data binding; treats data as
   opaque). `engine/ → game/` ❌, hardcoded ids in `engine/` ❌, `editors/` not driven by
   `data/editor-manifest.json` ❌.
3. **Extend interpreters with data, not gameplay branches.** Need something new? Add a
   *generic* primitive any game could use, never a game-specific `case`.
4. **Fire a sequence, don't one-off.** A reaction (sound + VFX + state change, often over
   time) is authored once in `data/fx-sequences.json` and triggered with
   `sequences.play(id, { x, y, entity })`. Don't scatter `sound.play` + `addGenericEffect`
   + `setTimeout` state changes across scene code.
5. **Signals drive state via the `onSignal(name, data, opts)` callback** (`game/main.js`).
   The engine forwards signal strings verbatim; the game interprets them and mutates
   `opts.entity`. The entity's `state` flows into `drawUnifiedArt(..., state, ...)`.
6. **Scenes own their state; services are injected via `shared`.** Clean up in `exit()`
   (`sequences.stopAll()` / `loopMgr.stopAll()` / `effects.stopAll()`). Mutate in
   `update`, draw in `render`.
7. **Runtime data is immutable unless cloned** (`buildArtRegistry` / `engine/data/*`
   loaders deep-clone). No `eval`/`new Function`.

## Workflow

- Run: `npm start` → http://localhost:6970/ (editor: `/editor`). Config via `ISLANDS`/`PORT`/
  `HOST`/`CHRONICLE_DB`/`EDITOR_PASSWORD` env (binds localhost by default). `?debug` on the
  game URL publishes `window.__boatz = { game, sim, scene, shared }`.
- Headless sim: `node game/sim/run-headless.mjs [days] [simSeed] [rosterSeed]` for balance
  metrics; `node scripts/bench-sim.mjs` for per-substep cost as the sea grows.
- Test: `npm test` (Node `--test` via a loader remap, zero deps). Add tests with changes;
  keep it green.
- Verify in-browser after changes: `npm run smoke` boots the game, every editor tab, and
  `/shots` in headless Chrome and fails on **any console error**.
- Never leave a server running at the end of a task.
