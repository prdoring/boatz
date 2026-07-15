// Quiet-life chronicle BEATS (Layer A) — the low-tier milestones that fill a stable entity's Story tab,
// plus the terminal-event ship tagging that lets a lost ship's tale record how it ended. Deterministic,
// milestone-flag gated, no RNG. Mirrors tests/simCaptains.test.js (makeWorld + absolute specifiers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import { events, maybeSink } from '/game/sim/events.js';
import { rankUp, makeCaptain } from '/game/sim/captains.js';
import { computeFleetByHome } from '/game/sim/fleet.js';
import { foeData } from '/game/sim/piracy.js';

// A test world whose event log never rolls (the live ring buffer caps at 60; a full sea can emit far
// more than that in one sweep, so lift the cap to count beats reliably).
function mkWorld(seed) { const w = makeWorld(seed); w.rules.EVENT_LOG_MAX = 1e9; return w; }
const dayOf = (w) => Math.floor(w.simTime / w.rules.SIM_DAY_SECONDS);
/** Force the once-per-day sweep to run for the current simTime (bypass its same-day guard). */
function runSweep(w) { w._eventDay = dayOf(w) - 1; events(w); }
const advanceDays = (w, n) => { w.simTime += n * w.rules.SIM_DAY_SECONDS; };
const kindOn = (w, kind, id) => w.events.filter((e) => e.kind === kind && e.islandId === id);

test('rankUp reports a rise once, then stays quiet at the same rank', () => {
  const cap = makeCaptain(makeWorld());
  assert.equal(rankUp(cap), null, 'first call records the baseline — no news');
  assert.equal(rankUp(cap), null, 'no change → null');
  cap.xp = { sea: 5000, gun: 5000, cmd: 5000 };  // vault up the ladder
  const r = rankUp(cap);
  assert.ok(r && r !== 'Novice', 'a rise returns the new rank label');
  assert.equal(rankUp(cap), null, 'same (top) rank again → null');
});

test('population milestone fires once per tier on an upward crossing (tier:log, island-tagged)', () => {
  const w = mkWorld();
  const isl = w.islands[0];
  isl.population = w.rules.POP_MILESTONES[0] + 10;
  runSweep(w);
  assert.equal(kindOn(w, 'popmilestone', isl.id).length, 1, 'crossing the first tier logs once');
  advanceDays(w, 1); runSweep(w);
  assert.equal(kindOn(w, 'popmilestone', isl.id).length, 1, 'no duplicate while it stays above the tier');
  assert.equal(kindOn(w, 'popmilestone', isl.id)[0].tier, 'log');
});

test('a golden age fires only after prosperity is held for the required span', () => {
  const w = mkWorld();
  const isl = w.islands[0];
  isl.civ = 0.95; // above GOLDEN_CIV
  runSweep(w);    // day 0 → records _goldenSince, no beat yet
  assert.equal(kindOn(w, 'goldenage', isl.id).length, 0, 'not on the first day of prosperity');
  advanceDays(w, w.rules.GOLDEN_DAYS);
  isl.civ = 0.95;
  runSweep(w);
  assert.equal(kindOn(w, 'goldenage', isl.id).length, 1, 'fires once the hold window elapses');
  assert.equal(kindOn(w, 'goldenage', isl.id)[0].tier, 'news');
});

test('a long peace fires for an untroubled port, and fresh trouble re-arms it', () => {
  const w = mkWorld();
  const isl = w.islands[0];
  const calm = () => { isl.blight = null; isl.plague = null; isl._famine = false; isl.rebellion = null; isl.haven = false; isl.danger = 0; isl.lawlessness = 0; };
  calm(); runSweep(w); // records _peaceSince
  advanceDays(w, w.rules.PEACE_DAYS); calm(); runSweep(w);
  assert.ok(kindOn(w, 'longpeace', isl.id).length >= 1, 'a long calm is chronicled');
  // Trouble resets the clock and the flag → after the same span of peace it can fire again.
  isl.danger = 1; advanceDays(w, 1); runSweep(w);       // feared waters → troubled → reset the clock + flag
  const before = kindOn(w, 'longpeace', isl.id).length;
  advanceDays(w, w.rules.PEACE_DAYS + 2); calm(); runSweep(w);
  assert.ok(kindOn(w, 'longpeace', isl.id).length > before, 'a second peace is chronicled after trouble');
});

test('a wreck tags the victim ship (so its tale can record how it ended)', () => {
  const w = mkWorld();
  const ship = w.ships[0];
  w.ships[1].homeId = ship.homeId;     // ensure the home has >1 ship (the last-ship guard would veto)
  computeFleetByHome(w);
  w.rules.SINK_PER_1000 = 100000;      // force the founder roll to pass
  assert.equal(maybeSink(w, ship, 1000), true);
  const wreck = w.events.find((e) => e.kind === 'wreck');
  assert.ok(wreck && wreck.shipId === ship.id, 'the wreck is tagged to the ship that sank');
});

test('foeData captures the OTHER ship for a cross-actor callback (Layer C payload)', () => {
  const w = makeWorld();
  const s = w.ships[0];
  const d = foeData(w, s);
  assert.equal(d.foeId, s.id);
  assert.equal(d.foeName, s.name);
  const home = w.islandsById.get(s.homeId);
  assert.equal(d.foeHome, home ? home.name : null);
  assert.equal(foeData(w, null), undefined, 'no foe → no payload');
});

test('the daily sweep is deterministic across identical seeded worlds', () => {
  const a = mkWorld(2024), b = mkWorld(2024);
  for (const w of [a, b]) { advanceDays(w, 1); runSweep(w); }
  assert.deepEqual(a.events.map((e) => e.kind), b.events.map((e) => e.kind));
});
