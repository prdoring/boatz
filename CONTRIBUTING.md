# Contributing

PRs are welcome. This is a solo-maintained hobby project, so small and focused beats big and
sweeping: a bug fix, a balance correction, a new simulation layer, better docs.

Be aware of what this is before you invest time in a PR: BOATZ is a **simulation**, not a game.
There is no player, and adding gameplay is not currently the goal. See
[Status](README.md#status).

## Setup

See [Run it](README.md#run-it). Short version: Node 22.5+, then `npm install` and `npm start`.

## Before you open a PR

1. `npm test` passes (Node's built-in test runner, no extra tooling).
2. `npm run smoke` passes: it boots the game, every editor tab, and the shot harness in
   a headless Chrome and fails on any console error.
3. New behavior comes with a test alongside the existing ones in `tests/`.

CI runs both on every PR.

## The rules that get PRs rejected

**1. The simulation stays pure and deterministic.** No `Date.now`, no `Math.random`, no
network, no filesystem, no engine import anywhere under `game/sim/`. All randomness comes
from the seeded streams in `game/sim/rng.js`. A world must serialize, reload, and step
identically: `tests/simSerialize.test.js` is the gate.

**2. The engine must never know what game it runs.** No game noun (an entity, state, sound,
or art id, or a gameplay constant) may appear under `engine/` or `editors/`. If a data
format can't express what you need, add a generic primitive any game could use, never a
game-specific branch. [AGENTS.md](AGENTS.md) is the full guide; §2 is the checklist a
reviewer will apply to your diff.

**3. No omniscience.** Any cross-island read an actor makes goes through that actor's own
ship-carried beliefs (`game/sim/beliefs.js` / `intel.js`), never a live scan of another
port's truth. A magistrate reasons from stale reports and is allowed to be wrong.

Three more conventions worth knowing:

- **Balance is data.** Tuning constants belong in `data/economy.json`, not in code. If you
  are adding a magic number to a `.js` file under `game/sim/`, it probably belongs there.
- **No build step, no new dependencies.** The whole dependency list is `ws`. A PR that adds
  a bundler, framework, or npm package needs an exceptional reason.
- **New behaviour is a system, not a script.** Add something that reacts to existing state
  and let the consequences fall out, rather than authoring an event that fires on cue.

## Docs that must keep up

`docs/sim-manual.html` is a living document: it maps every actor's decision path and keeps a
register of known bugs. If your PR changes how an actor decides anything, update the
relevant chapter (and the register, if you fixed or found something) in the same PR.

## Content PRs

Art, VFX, sounds, music, and sequences are all JSON under `data/`, editable at `/editor`.
Author them in the editors and commit the resulting JSON. Note that ship hulls, island
relief, workshops and captain portraits are drawn **procedurally** from code in `game/`
rather than from static art assets, so those are code changes, not content ones.
