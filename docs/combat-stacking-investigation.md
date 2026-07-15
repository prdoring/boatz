# Combat stacking investigation — ships pile onto one another in a fight

**Status:** root-caused, no code changed yet (other sessions were live during the investigation).
**Reporter:** investigation session, for a follow-up session to implement.
**Symptom (user):** "When ships are fighting they seem to get stuck on top of each other in the same
location." Follow-ups asked about multi-ship fights and fights within an island's gun range.

This report is analysis + a fix map only. It does **not** change code. Line numbers are as of the
working tree at the time of writing — re-grep before editing.

---

## TL;DR

- A ship-to-ship fight turns **off** collision separation for the fighting pair
  (`separation.js:45`, the `_prey` mutual-chase exemption). The only thing left holding two combatants
  apart is the attacker's `standoffPoint` repositioning.
- That repositioning is **stable for a duel of two warships** (both hold a standoff → they settle at
  `COMBAT_STANDOFF ≈ 80u`), but it **collapses** whenever the fight is **asymmetric** — one hull runs a
  standoff while the other sails an independent course (a merchant running a blockade / fleeing; a
  pirate fleeing a privateer). The moving hull overruns the standoff-holder and the pair ends up at
  ~0 separation.
- Two feedback loops make the collapse reliable and permanent:
  1. **Rig-damage slowdown.** Combat (and shore/haven guns) shoot away the standoff-holder's rig →
     `rigMult` drops → it becomes **slower than the ship it is trying to keep off** → it can no longer
     retreat to hold the gap.
  2. **Degenerate standoff + separation exemption = a lock.** At ~0 separation `standoffPoint` returns
     the *foe's own position* (`piracy.js:48-51`), so the attacker's target becomes "where the enemy
     already is." With separation exempt, nothing pushes them back apart. They stay welded for the rest
     of the fight.
- **Multi-ship** makes it worse, not better: the exemption is *per attacker*, so a focused-fire target
  is exempt from separation against its **entire** swarm. Any attacker that out-speeds it piles on.
- **Near an island** makes it worse: shore batteries / haven guns (range 700–1000u) grind rig on
  everything hostile in the roads, accelerating loop (1); and `steerAroundIslands` deflects a
  combatant's gap-opening move along the shore, so it can't back off — it gets pinned against the land.

The single most robust fix is a **hard anti-stack floor that ignores the `_prey` exemption below a
small collision radius** (≈ ship diameter, ~30–40u, well under the 80u standoff), plus fixing the
degenerate `standoffPoint`. That alone guarantees two hulls can never fully overlap. Everything else
below is about not reaching that floor in the first place, and about the island/multi-ship amplifiers.

---

## How combat movement works (the pieces)

Ordered SIM pipeline, per fixed `SIM_STEP = 0.05s` substep (`world.js` drives it; `systems.js` lists
the order): **`ship` → `piracy` → `antipiracy` → `shoreBatteries` → `separation`** (havens later).

- **`ship.js`** moves merchants. A merchant does **not** do any standoff. Under threat it either
  *flees* to a refuge port and **docks/shelters** (`panicRun`, `PIRATE_PANIC_MULT = 1.18`), or — if
  armed + bold — **runs the blockade**, i.e. keeps sailing its voyage straight toward its next stop,
  ignoring the pirate (`fleeTarget` returns null → `shelterOrFlee` returns false → normal `sail`).
- **`piracy.js`** drives pirates. Against prey within `PIRATE_COMBAT_RANGE = 150`: if reloaded → fire
  (does **not** move); if reloading → move to `standoffPoint(prey, self, COMBAT_STANDOFF=80)`; if
  outside 150 → **sail to the prey's EXACT coordinates** (`piracy.js:205`). Haven-defence branch is the
  same shape (`piracy.js:160-166`, closing to `besieger.x/.y`).
- **`antipiracy.js`** drives privateers, mirror shape: fire / standoff / close-to-exact
  (`:171-207`; standoff `:183`; close-to-exact `defender.x/.y :189`, `prey.x/.y :197`, `haven.x/.y :200`).
- **`shoreBatteries` (`shore.js`)** — armed lawful ports shell pirates, havens shell privateers, within
  `PORT_CANNON_RANGE = 700`. Damages guns + **hull + rig**. Does not move ships.
- **`separation.js`** — light collision-avoidance, runs last on final positions. **Exempts** any pair
  where one is the other's `_prey` (`:45`) and **excludes** `_sheltered`/docked hulls (`:30`).

### Relevant tuning (`data/economy.json`)
```
SHIP_SPEED 120     PIRATE_SPEED_MULT 1.08   PRIVATEER_SPEED_MULT 1.14   PIRATE_PANIC_MULT 1.18
PIRATE_COMBAT_RANGE 150     COMBAT_STANDOFF 80     COMBAT_ROUND_SEC 1.2
SHIP_SEPARATION_RANGE 44    SHIP_SEPARATION_PUSH 1.5   SHIP_AVOID_RANGE 120
PIRATE_EVADE_RANGE 620      FLEE_DISENGAGE 1.6
PORT_CANNON_RANGE 700       PORT_CANNON_FULL 12
HAVEN_DEFEND_RANGE 1000     HAVEN_SUPPRESS_RANGE 800   HAVEN_RESUPPLY_RANGE 900   PIRATE_BLOCKADE_RANGE 760
ISLAND_RADIUS 58 (drawn/land radius ≈ 23–107u depending on island k)   SHIP_ISLAND_CLEARANCE 8
```
Render: `SHIP_RADIUS = 15` (hull ~30u across). So 80u standoff is a clean visual gap; "stacked" is a
genuine ~0-separation collapse, **not** just close sprites.

---

## Root cause (duels are fine; asymmetric & dogpile fights collapse)

### Why a two-warship duel does NOT stack
Both sides run the standoff. At `SIM_STEP = 0.05` the step is ~5–6u/substep, so the mutual standoff
dance is stable: distance converges cleanly to 80u without overshoot (verified by hand-simulating the
sequential update). Pirate↔privateer and haven-siege *duels* mostly hold ~80u.

### Why asymmetric fights DO stack
Only the attacker runs a standoff; the other hull sails an **independent course**. Whenever that course
runs **toward/through** the attacker, the attacker must retreat to keep 80u. Two things defeat that:

1. **Rig-damage slowdown (the core domino).** Merchants fire chain-shot at the rig
   (`COMBAT_CHAIN_MERCHANT = 0.75` — "shoot away the pursuer's sails and flee"). The attacker's `rig`
   falls → `rigMult` drops → its effective speed falls **below** the merchant's (merchant panic 1.18 >
   pirate 1.08, and a shot rig cuts the pirate further). It literally cannot back off fast enough.
2. **Fire-tick freeze.** `ship.js` runs before `piracy.js`, so the target advances ~6u every substep,
   but the attacker only repositions on **reload** substeps — on a **fire** substep it doesn't move at
   all. Net inward drift on every fire tick.

Common triggering geometries (all real, all frequent):
- A merchant **running a blockade** sails toward the very port the pirate is blockading → straight at
  the pirate.
- A **fleeing** merchant's refuge port lies **behind** the pirate → it runs toward the pirate at 1.18×.
- A **timid pirate fleeing a privateer** (`piracy.js:135-143`, `awayPoint`) runs its own vector while
  the privateer holds a standoff → same collapse with roles swapped.

### Why it locks (never recovers)
- `standoffPoint` (`piracy.js:48-51`) does `d = hypot(...) || 1` with `dx=dy=0` at coincidence → returns
  the foe's exact position → attacker's target = "where the enemy is" → it stops separating.
- `separation.js:45` exempts the pair → no safety net.
- If the target **docks** (goes `trading`/`_sheltered`) while stacked, the pirate's **sticky `_prey`
  recheck** (`piracy.js:187`) keeps it as prey at point-blank (the `shelteredAtPort` drop only applies
  *beyond* gun-range), so the pirate keeps sitting on it.

**Tests currently hide this.** `simCombat.test.js` places both hulls at the *same* coordinates and
advances `simTime` by `COMBAT_ROUND_SEC` each iteration, so **every** call is a fire tick — the
standoff/separation code is never exercised. `simSeparation.test.js:57-68` actively **asserts** a
hunter+prey at 20u stay exactly 20u apart forever (it encodes the current buggy exemption). Both need
to change with the fix.

---

## Multi-ship findings (other ships joining the fight)

1. **The exemption is per-attacker → a dogpiled target is exempt from its whole swarm.** The check is
   `if (o.id === s._prey || s.id === o._prey) return;`. The clause `s.id === o._prey` means a target
   `P` is skipped by separation against **every** ship that currently has `P` as its `_prey`. So focus
   fire (N privateers on one pirate, or N pirates on one fat merchant) removes separation between the
   target and **all** attackers at once. Any attacker that out-speeds the target piles directly onto it.
   Multi-ship fights therefore stack **more** readily than duels, not less.
2. **Attackers on a shared target cluster.** Two pirates hunting the same merchant each hold their own
   80u standoff "on the side they're already on" — often the *same* side. They **do** separate from each
   other (they aren't each other's prey, so `SHIP_SEPARATION_RANGE = 44` applies), giving a rosette of
   attackers ~44–80u apart all crowding one target they're each individually collapsing onto.
3. **Target-switching thrash.** `nearestPrey`/`nearestShip` re-pick the closest foe as positions shift;
   privateers re-acquire prey every tick once outside `PRIVATEER_HUNT_RANGE` (`antipiracy.js:122`). When
   `_prey` flips between foes, the separation exemption flips on/off for those pairs → jitter. (Pirates
   are stickier via `piracy.js:187`, so this bites privateers more.)
4. **Dismasting → sitting duck.** Enough rig damage (`rig ≤ RIG_DISTRESS 0.12`) means a hull *cannot*
   run (`breaksOff` forces it to fight/strike) and its `rigMult` speed is ~0. A dismasted hull stops
   dead; everything stacks onto it and grinds it. Intended for combat resolution, but it maximises the
   visual pile.
5. **Aid convoys (adjacent, worth noting).** `renderAidRun` (`ship.js:557-570`) sails a helper to the
   victim's exact coords and only "arrives" within `RESCUE_DOCK_RANGE = 120`; helpers converging on one
   distressed ship can visually cluster too. Not "combat," but the same close-convergence pattern.

---

## Ship-vs-island findings (fighting in an island's gun range)

1. **Shore/haven guns amplify the slowdown domino.** `shoreBatteries` (range **700u**) and haven guns
   (via `assaultHaven`) grind **hull and rig** (`shore.js:51-55`; `havens.js:202-203`) on hostiles
   loitering in the roads. Rig loss → slower ship → the standoff-holder collapses onto its target even
   faster. **A fight anywhere within ~700u of an armed port/haven inherits extra rig damage from the
   shore on top of the enemy's fire.** This is the direct answer to "what if ships are in blasting range
   of an island": the island doesn't push ships together itself, but it strips their rigging, which is
   exactly the input to the stacking loop.
2. **`steerAroundIslands` prevents the gap from opening near land.** During combat the standoff/closing
   aim goes through `steerAroundIslands` (`navigation.js:26-65`). An island's `landRadius + clearance`
   (~30–115u) is comparable to `COMBAT_STANDOFF = 80`. When two hulls fight right beside an island, the
   attacker's "back off outward" vector can point toward/across the land and gets **deflected
   tangentially along the shore** instead of opening the range — pinning the attacker beside its target
   against the coast. (The destination-exempt rule at `navigation.js:42` doesn't help: a standoff point
   80u off a merchant is not *on* the island's land, so the island is still avoided.)
3. **Haven sieges are the worst-case superposition.** At a haven you get simultaneously: multiple
   besieging privateers (hold station at ~`HAVEN_SUPPRESS_RANGE = 800`), defending pirates charging out
   to board (`piracy.js:152-174`), haven guns shelling privateers, any nearby lawful port shelling
   pirates, and all the multi-ship exemption effects above — all within the island's gun range. This is
   where users will most often *see* a knot of ships welded together.
4. **Besieger positioning is mostly OK, with one caveat.** Besieging privateers sail to the haven's
   **exact center** (`antipiracy.js:200`) but stop at `HAVEN_SUPPRESS_RANGE = 800` (well outside land)
   via the `besieging` branch, and separate from each other. The caveat is the *defenders*: bold pirates
   close to a besieger's exact position then standoff, and if their rig is shot they overrun the
   (often stationary) besieger — a stack right on the siege line.
5. **Render/sim mismatch at a port (visual, not sim).** A sheltered/docked target is drawn at a
   **berth** fanned out by `WorldRenderer._computeBerths` (`WorldRenderer.js:461-465`), while its **sim**
   position stays at the harbour edge. A pirate stacked on the sim position appears to sit on/near the
   wharf while the merchant is drawn elsewhere — this can make the stacking look even more confusing than
   it is, and separation won't touch the docked hull anyway (`separation.js:30` excludes it).

---

## Fix map (all locations)

Ranked roughly by leverage. Re-grep line numbers before editing.

| # | File · anchor | What's there / what to change |
|---|---|---|
| 1 | **`game/sim/separation.js:45`** (exemption) + **`:30`** (`_sheltered` filter) | **Primary fix.** Keep exempting the give-way *veer* for a chasing/fighting pair, but always apply a **hard radial anti-stack shove below a small collision radius** (≈ ship diameter ~30–40u, ≪ 80u standoff) even for `_prey` pairs — close to board, never overlap. Must be **per-pair** so a dogpiled target is protected against *each* attacker regardless of count. Note `:30` excludes docked hulls, so this alone won't fix a raider stacked on a *docked* target — that needs #4. |
| 2 | **`game/sim/piracy.js:48-51`** (`standoffPoint`) | Fix the `d≈0` degenerate: when the hulls coincide, offset along a deterministic per-hull bearing (mirror separation.js's `GOLDEN` trick) so a stacked pair is pushed apart instead of handed the foe's own coordinates. Shared by pirates **and** privateers, so this one edit covers both. |
| 3 | **`game/sim/piracy.js`** — hunt branch `~197-205` (close-to-exact `:205`), defend-haven `~160-166` (close-to-exact `:166`) | Close only to gun-/standoff-range, not the foe's **exact** coords; consider keeping the standoff active in positioning even on the fire tick so the attacker isn't frozen on a still-moving target. |
| 4 | **`game/sim/piracy.js:187`** (sticky `_prey`) + `shelteredAtPort` gate (`:294-299`, used at `:187`/`:311`) | A raider should hold **off** a target that has docked (`trading`/`_sheltered`) instead of sitting point-blank; extend the shelter drop to gun-range, or drop `_prey` when the target shelters. This is the docked-target stack that #1 can't reach. |
| 5 | **`game/sim/antipiracy.js`** — standoff `:183`, close-to-exact `defender :189` / `prey :197` / `haven :200` | Mirror of #3 for privateers (covers privateer-vs-fleeing-pirate and siege defenders). |
| 6 | **`game/sim/navigation.js:26-65`** (`steerAroundIslands`) | Combat positioning gets deflected along the shore so a hull can't open the gap near land. Options: let the hard collision floor (#1) act **before/independent of** steering; or exempt very-short-range separation moves from island deflection; or give combatants a small "sea-room" bias away from land when holding a standoff. |
| 7 | **`data/economy.json`** (tuning ~`:56-60`, `:289-352`, `:317-352`) | Add the collision-floor radius (e.g. `SHIP_COLLIDE_RANGE ≈ 34`) and/or a standoff strength/damping const. Existing keys to keep in mind: `COMBAT_STANDOFF 80`, `PIRATE_COMBAT_RANGE 150`, `SHIP_SEPARATION_RANGE 44`, `PORT_CANNON_RANGE 700`. |
| 8 | **`game/sim/shore.js:51-55`** & **`game/sim/havens.js:202-203`** | Not bugs — but note these strip rig on everything hostile near an island, which is the *input* to the stacking loop. No change required if #1 lands (the floor makes rig-slowdown harmless for stacking); flagged so the implementer understands why "near an island" is worse. |
| 9 | **`game/WorldRenderer.js:461-465`** (`_computeBerths`) + `drawShips` | Visual only: sheltered target drawn at a berth while its sim pos (and any stacked raider) sits at the harbour edge. Consider whether a raider engaging a docked ship should draw at the berth vicinity, or whether #4 removes the situation entirely. |
| 10 | **Tests** — `tests/simSeparation.test.js:57-68` **must be updated** (it asserts the buggy "held at 20u" behavior); **`tests/simCombat.test.js`** add a real multi-substep regression | See test guidance below. |

### Recommended minimal, robust change set
Do **#1 + #2 first** — together they make full overlap impossible and self-recovering, which fixes the
*symptom* for every scenario (duel, asymmetric, dogpile, near-island). Then **#3/#5 + #4** remove the
*causes* (don't aim at exact enemy coords; don't sit on docked prey) so ships hold a clean 80u broadside
gap instead of oscillating near the floor. **#6** only if near-island fights still look pinned after
#1. **#7** carries any new constants. **#10** locks it all in.

---

## Test guidance

- **`tests/simCombat.test.js`** — the existing tests jump `simTime` by `COMBAT_ROUND_SEC` per iteration,
  so they only ever hit fire ticks and never move ships. Add a case that steps by **`SIM_STEP`** for a
  few hundred substeps with a rig-damaged pirate hunting a merchant whose voyage target sits **beyond**
  the pirate (so the merchant sails through it). Assert the center-to-center distance **never drops below
  the collision radius** and settles near `COMBAT_STANDOFF`.
- **`tests/simSeparation.test.js:57-68`** — update the "hunter and prey EXEMPT" test: at 20u the pair
  should now be **pushed apart to the collision radius** (the give-way veer stays exempt; the hard shove
  does not). Add a case for **N attackers on one target** asserting none of them overlap the target.
- **Near-island** — a case with a fight started inside `PORT_CANNON_RANGE` of an armed port: assert
  ships still don't overlap even as the shore strips their rig.
- Keep the whole suite green (`npm test`, Node `--test`, zero deps).

---

## Open questions / things to verify before shipping

1. Confirm the collision-floor radius doesn't break **boarding/plunder** cadence — combat resolution
   only needs the hulls within `PIRATE_COMBAT_RANGE = 150`, and 34u ≪ 150, so a floor at ~34u should be
   safe. Verify a prize is still taken (`resolveCombat`/`boardPrize`) with the floor in place.
2. Confirm `separation` running **last** still lets the floor win — the standoff (piracy/antipiracy)
   runs earlier and could push back; the floor should be the final word each substep.
3. Decide whether the give-way veer should stay fully exempt during a chase (probably yes — a boarding
   action shouldn't politely give way) while only the hard shove applies. The report assumes yes.
4. Re-check the **serialization/determinism** rules (any new per-hull bearing must be id-derived, no
   `Math.random`/`Date.now`) — `standoffPoint`'s degenerate fix and any floor tie-break must be pure.
5. Watch for **regression in blockade behavior**: a floor that's too large could stop a pirate from
   holding a tight blockade or a besieger from pressing a haven. Keep the floor ≪ standoff.

---

## Appendix — key file:line references

- `game/sim/separation.js:25-84` (system), `:30` (atSea filter excludes `_sheltered`), `:45` (`_prey` exemption), `:49-52` (existing GOLDEN split for exactly-stacked non-exempt hulls)
- `game/sim/piracy.js:44-51` (`standoffPoint`), `:100-278` (`piracy` driver), `:152-175` (defend-haven), `:182-207` (hunt/prey), `:187` (sticky prey), `:294-299` (`shelteredAtPort`), `:347-365` (`exchangeFire`, chain-shot doctrine)
- `game/sim/antipiracy.js:47-211` (driver), `:171-207` (combat branches), `:183` (standoff), `:189/:197/:200` (close-to-exact)
- `game/sim/shore.js:21-73` (shore batteries; rig damage `:51-55`)
- `game/sim/havens.js:192-214` (`assaultHaven`; rig damage `:202-203`)
- `game/sim/navigation.js:16-20` (`islandLandRadius`), `:26-65` (`steerAroundIslands`)
- `game/sim/ship.js:160-208` (`panicRun`/`shelterOrFlee`), `:334-378` (`fleeTarget`, run-the-blockade)
- `game/WorldRenderer.js:47-48` (`COMBAT_VIS_RANGE`), `:458-514` (`drawShips`), `:461-465` (berths)
- `data/economy.json` — tuning as listed above
- `tests/simCombat.test.js`, `tests/simSeparation.test.js`
