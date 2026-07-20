// Piracy — the black-flag antagonist. Combat is decided by captain skill, crew morale, and
// WEAPONS aboard (the offense/defense equation); pirates spawn only by CONVERSION of an existing
// crew (nothing appears for free), are capped as a fraction of the fleet (self-limiting), and can
// be sunk when they pick the wrong fight. These tests lock those invariants in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/simWorld.js';
import {
  combatStrength, weaponsAboard, pirateCount, canTurnPirate, turnPirate, maybeTurnRogue, piracy,
} from '/game/sim/piracy.js';
import { hardenToPirate } from '/game/sim/captains.js';
import { snapshotShipsCold } from '/game/sim/snapshot.js';
import { GOLD } from '/game/sim/resources.js';

const anyMerchant = (w) => w.ships.find((s) => !s.pirate && !s.privateer) || w.ships[0];

test('hardenToPirate keeps a captain’s identity but leans him bold + greedy + blooded', () => {
  const c = { name: 'Meek Merchant', voiceSeed: 42, traits: { boldness: 0.2, wanderlust: 0.5, greed: 0.1 }, xp: { sea: 0, gun: 0, cmd: 0 } };
  hardenToPirate(c);
  assert.equal(c.name, 'Meek Merchant', 'same name'); assert.equal(c.voiceSeed, 42, 'same hand in the log');
  assert.ok(c.traits.boldness >= 0.7 && c.traits.greed >= 0.6, 'harder now — bold and greedy');
  assert.ok(c.xp.gun >= 180, 'blooded enough to fight');
});

test('a seeded raider ({fresh}) takes a NEW master and records no honest predecessor', () => {
  const w = makeWorld();
  const ship = anyMerchant(w);
  const cap0 = ship.captain;
  turnPirate(w, ship, { fresh: true });
  assert.ok(ship.pirate, 'the black flag is up');
  const ev = w.events.filter((e) => e.kind === 'pirate').pop();
  assert.equal(ev.data.regime.cause, 'pirate', 'a fresh raider is a seizure, not a captain-led turn');
  assert.equal(ev.data.regime.from, null, 'no prior keeper recorded');
  assert.notEqual(ship.captain, cap0, 'a new, fearsome master commands');
});

test('a mutiny that turns pirate ({overthrow}) casts out the old captain for a new master', () => {
  const w = makeWorld();
  const ship = anyMerchant(w);
  const name0 = ship.captain.name;
  turnPirate(w, ship, { overthrow: true });
  const ev = w.events.filter((e) => e.kind === 'pirate').pop();
  assert.equal(ev.data.regime.cause, 'pirate');
  assert.equal(ev.data.regime.from.name, name0, 'the ousted captain is the outgoing keeper');
  assert.match(ev.text, /cast out Capt\. /, 'the log names the captain thrown over');
});

test('a bold, greedy merchant captain may raise the black flag of his OWN accord', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, ROGUE_TEMPT_BASE: 2, ROGUE_TEMPT_MAX: 1, PIRATE_MAX_FRAC: 1 }; // force the temptation to land + room in the seas
  const ship = anyMerchant(w);
  const cap0 = ship.captain;
  cap0.traits = { boldness: 0.95, greed: 0.95, wanderlust: 0.5 }; ship.morale = 0.7; ship._temptCd = 0;
  assert.ok(maybeTurnRogue(w, ship), 'the temptation fired');
  assert.ok(ship.pirate, 'she flies the black flag — no mutiny, no haven');
  const reg = w.events.filter((e) => e.kind === 'pirate').pop().data.regime;
  if (reg.cause === 'rogue') assert.equal(ship.captain, cap0, 'a captain who leads keeps command and his hand');
  else assert.equal(reg.cause, 'pirate', 'else the crew took the chance to throw him over');
});

test('an easygoing or timid captain is never tempted to piracy', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, ROGUE_TEMPT_BASE: 2, ROGUE_TEMPT_MAX: 1, PIRATE_MAX_FRAC: 1 };
  const ship = anyMerchant(w);
  ship.captain.traits = { boldness: 0.2, greed: 0.2, wanderlust: 0.5 }; ship.morale = 0.7; ship._temptCd = 0;
  assert.equal(maybeTurnRogue(w, ship), false, 'below the boldness/greed bar → no lure to the black flag');
  assert.ok(!ship.pirate);
});

test('a crew below the mutiny line MUTINIES rather than following the captain rogue', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, ROGUE_TEMPT_BASE: 2, ROGUE_TEMPT_MAX: 1, PIRATE_MAX_FRAC: 1 };
  const ship = anyMerchant(w);
  ship.captain.traits = { boldness: 0.95, greed: 0.95, wanderlust: 0.5 };
  ship.morale = (w.rules.MUTINY_MORALE || 0.3) - 0.05; ship._temptCd = 0;
  assert.equal(maybeTurnRogue(w, ship), false, 'a rebellious crew revolts; it does not follow him to piracy');
});

test('an organic turn is self-consistent: a KEPT captain is ROGUE, a REPLACED one is a seizure', () => {
  const w = makeWorld();
  const ship = anyMerchant(w);
  const cap0 = ship.captain;
  turnPirate(w, ship); // organic — the stat roll decides who commands
  const reg = w.events.filter((e) => e.kind === 'pirate').pop().data.regime;
  if (reg.cause === 'rogue') {
    assert.equal(ship.captain, cap0, 'a captain who LED his crew keeps his name and hand');
    assert.ok(cap0.traits.boldness >= 0.7 && cap0.traits.greed >= 0.6, 'hardened into a raider');
    assert.equal(reg.from.voiceSeed, reg.to.voiceSeed, 'from == to — the same person, before and after');
  } else {
    assert.equal(reg.cause, 'pirate', 'otherwise a new master seized her');
    assert.notEqual(ship.captain, cap0, 'a changed hand');
  }
});

test('combat strength rises with guns, skill, morale — and a pirate fights harder', () => {
  const w = makeWorld();
  const a = w.ships[0], b = w.ships[1];
  a.cargo = { Gold: 0, People: 0, Weapons: 0 }; a.morale = 0.5;
  b.cargo = { Gold: 0, People: 0, Weapons: 10 }; b.morale = 0.5; b.captain = a.captain;
  assert.ok(combatStrength(w, b) > combatStrength(w, a), 'more guns → more strength');
  assert.equal(weaponsAboard(b), 10);

  const plain = { ...b, pirate: false }, rogue = { ...b, pirate: true };
  assert.ok(combatStrength(w, rogue) > combatStrength(w, plain), 'a pirate gets the ferocity bonus');
});

test('weapons contribution is capped by the hull class (a ship cannot stack infinite guns)', () => {
  const w = makeWorld();
  const s = w.ships[0];
  const cap = w.rules.SHIP_TYPES[s.type].weaponCap; // per-hull gun capacity
  s.cargo = { Gold: 0, People: 0, Weapons: cap }; s.morale = 0.5;
  const atCap = combatStrength(w, s);
  s.cargo.Weapons = cap * 4;
  assert.ok(Math.abs(combatStrength(w, s) - atCap) < 1e-9, 'guns past the hull cap add nothing');
});

test('turning pirate is a CONVERSION — no ship is created, the hull is reused under a new flag', () => {
  const w = makeWorld();
  const before = w.ships.length;
  const ship = w.ships[0];
  const id = ship.id, hull = ship.capacity, home = ship.homeId;
  ship.voyage = { reason: 'trade', stops: [], index: 0 };
  turnPirate(w, ship);
  assert.equal(w.ships.length, before, 'no new ship spawned — piracy adds nothing free to the fleet');
  assert.equal(ship.id, id, 'same hull');
  assert.equal(ship.capacity, hull, 'same capacity');
  assert.equal(ship.homeId, home, 'still remembers its home port');
  assert.equal(ship.pirate, true, 'flying the black flag');
  assert.equal(ship.voyage, null, 'abandoned its merchant voyage');
  assert.ok(ship.captain && ship.captain.name, 'sails under a fresh captain');
  assert.ok(pirateCount(w) >= 1);
});

test('piracy is self-limiting — the fleet-fraction cap blocks the next conversion', () => {
  const w = makeWorld();
  const cap = Math.max(1, w.ships.length * w.rules.PIRATE_MAX_FRAC);
  let guard = 0;
  while (canTurnPirate(w) && guard++ < 1000) {
    const victim = w.ships.find((s) => !s.pirate);
    if (!victim) break;
    turnPirate(w, victim);
  }
  assert.ok(!canTurnPirate(w), 'the seas refuse another pirate once the cap is reached');
  assert.ok(pirateCount(w) <= Math.ceil(cap), `pirates (${pirateCount(w)}) stay within the cap (${cap})`);
});

test('the world is seeded with a few rogues already at large (the early seas are not empty)', () => {
  const w = makeWorld();
  const pirates = w.ships.filter((s) => s.pirate);
  assert.equal(pirates.length, w.rules.START_PIRATES, 'START_PIRATES raiders sail from day one');
  for (const p of pirates) {
    assert.ok((p.cargo.Weapons || 0) > 0, 'a seeded rogue is armed for the fight');
    assert.ok((p.cargo.Food || 0) > 0, 'and victualled to hunt before it must raid');
  }
});

test('a pirate does NOT chase a merchant into a port’s shelter — it drops her and blockades (no bouncing off the wharf)', () => {
  const w = makeWorld();
  const isle = w.islands[0]; isle.haven = false;
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed → won't raid; it will hunt if it can
  pirate._huntCd = 0; pirate._prey = null;
  pirate.x = isle.x + 400; pirate.y = isle.y;                    // out in the approaches
  const merch = w.ships.find((s) => s !== pirate && !s.pirate) || w.ships[1];
  merch.pirate = false; merch.privateer = false; merch.state = 'outbound'; // UNDER WAY (not idle/trading) …
  merch.cargo = { Gold: 500, People: 0, Food: 10, Weapons: 0 };  // …a fat prize, but
  merch.x = isle.x + 40; merch.y = isle.y;                       // tucked in the port's roads — under its guns
  w.ships = w.ships.filter((s) => s === pirate || s === merch);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  for (let i = 0; i < 80; i++) piracy(w, w.rules.SIM_STEP);
  assert.notEqual(pirate._act && pirate._act.k, 'hunt', 'the raider did not chase the sheltering merchant onto the wharf');
  assert.equal(pirate._act && pirate._act.k, 'blockade', 'it stood off and blockaded, waiting for her to stand back out');
  assert.ok(!merch._sunk, 'the merchant was safe under the port’s guns');
  assert.ok(Math.hypot(pirate.x - isle.x, pirate.y - isle.y) > w.rules.PIRATE_RAID_RANGE, 'the pirate held off the port (no bouncing on the wharf)');
});

test('a fed pirate with no prey does NOT camp an island wharf — it stands off in the approaches', () => {
  const w = makeWorld();
  const isle = w.islands[0];
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed (won't raid) and not laden (won't fence)
  pirate._huntCd = 0; pirate._prey = null;
  pirate.x = isle.x; pirate.y = isle.y;               // sitting right on the wharf
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no merchant is under way → no prey at sea
  for (let i = 0; i < 60; i++) piracy(w, w.rules.SIM_STEP);
  const d = Math.hypot(pirate.x - isle.x, pirate.y - isle.y);
  assert.ok(d > w.rules.PIRATE_RAID_RANGE, `the pirate stood off the wharf (dist ${Math.round(d)}u) instead of camping it`);
});

test('a blockading pirate circles a port (never camps it) and stokes the fear of its waters', () => {
  const w = makeWorld();
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed (won't raid) + not laden (won't fence)
  pirate._huntCd = 0; pirate._prey = null;
  const isle = w.islands[0];
  pirate.x = isle.x + 120; pirate.y = isle.y;           // right off the wharf
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no prey at sea → it blockades
  for (const i of w.islands) i.danger = 0;
  const track = [];
  for (let i = 0; i < 80; i++) { piracy(w, w.rules.SIM_STEP); track.push({ x: pirate.x, y: pirate.y }); }
  // It KEEPS MOVING (circling), not sitting dead on a fixed mark.
  const moved = track.some((p) => Math.hypot(p.x - track[0].x, p.y - track[0].y) > 30);
  assert.ok(moved, 'the blockader circles rather than parking on one spot');
  // It stays out in the approaches, off the wharf (not camping the port).
  assert.ok(Math.hypot(pirate.x - isle.x, pirate.y - isle.y) > w.rules.PIRATE_RAID_RANGE, 'held off the wharf');
  // And a blockade makes these waters feared (which is what draws the privateers).
  assert.ok(w.islands.some((i) => (i.danger || 0) > 0), 'the blockade stoked danger, summoning the law');
});

test('a hungry pirate on a raided port’s cooldown STANDS OFF — it does not park dead-centre on the island', () => {
  const w = makeWorld();
  const isle = w.islands[0];
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 0, Weapons: 8 }; // starving → it WANTS to raid…
  pirate._huntCd = 0; pirate._prey = null;
  isle.stock = { ...(isle.stock || {}), Food: 0 };           // …but the port is stripped bare and
  isle._raidCd = w.simTime + 100000;                         // freshly raided → on a long cooldown (can't raid)
  pirate.x = isle.x + 300; pirate.y = isle.y;
  for (const p of w.islands) p.haven = false;                // no haven to slink to
  for (const s of w.ships) if (!s.pirate) s.state = 'idle';  // no prey at sea
  w.rules = { ...w.rules, SINK_PER_1000: 0 };                // deterministic: no foundering mid-test

  for (let i = 0; i < 120; i++) piracy(w, w.rules.SIM_STEP);
  const d = Math.hypot(pirate.x - isle.x, pirate.y - isle.y);
  assert.ok(d > w.rules.PIRATE_RAID_RANGE,
    `the raider held off the port (dist ${Math.round(d)}u) instead of freezing in its centre`);
  assert.equal(pirate._act && pirate._act.k, 'blockade', 'it fell through to blockading the approaches');
});

test('a STARVING pirate hunts a lean prize its greedy, well-fed self would scorn (and won’t lie low)', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.captain.traits = { ...pirate.captain.traits, greed: 0.95, wanderlust: 0.1 }; // greedy (scorns lean hulls) + not a rover
  pirate.captain.xp = 5000;                                    // skilled → wins the boarding
  pirate.cargo = { Gold: 0, People: 0, Food: 0, Weapons: 40 }; // STARVING (the prize is food, not plunder)
  pirate.x = 3000; pirate.y = 3000; pirate.morale = 1;
  pirate._huntCd = w.simTime + 100000;                         // "resting" with loot — a FED pirate would not hunt
  const lean = { Gold: 5, People: 0, Food: 1, Weapons: 0 };    // prize ≈ 15, well under PIRATE_GREED_MIN_PRIZE (55)
  victim.x = 3000; victim.y = 3000; victim.state = 'outbound'; victim.pirate = false;
  victim.cargo = { ...lean }; victim.morale = 0.05;
  w.ships = w.ships.filter((s) => s === pirate || s === victim);
  w.rules = { ...w.rules, SINK_PER_1000: 0 };                  // deterministic: no foundering mid-test

  piracy(w, w.rules.SIM_STEP);
  assert.equal(pirate._act && pirate._act.k, 'hunt', 'the starving raider chose to HUNT the lean hull (greed/rest overridden)');
  assert.ok(weaponsAboard(pirate) < 40, 'and actually engaged it — a fight burned powder (it did not scorn the prize)');
});

test('a pirate DEFENDS its haven — it turns on a besieging privateer instead of standing off', () => {
  const w = makeWorld();
  const den = w.islands[0];
  den.haven = true; den.havenStrength = 0.85; // a stronghold under threat
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 30 }; // fed (won't resupply) + strong (matched → charges)
  pirate.x = den.x + 300; pirate.y = den.y; pirate._huntCd = 0; pirate._prey = null; pirate._raidCd = 0;
  // A privateer come to assault the haven, within its defended waters but not yet at gun-range.
  const priv = w.ships.find((s) => s !== pirate && !s.pirate) || w.ships[1];
  priv.privateer = true; priv.pirate = false; priv.homeId = w.islands[1].id;
  priv.cargo = { Gold: 0, People: 0, Food: 200, Weapons: 4 };
  priv.x = den.x - 200; priv.y = den.y;
  w.ships = w.ships.filter((s) => s === pirate || s === priv);
  w.rules = { ...w.rules, SINK_PER_1000: 0 }; // deterministic: no foundering mid-test

  const before = Math.hypot(pirate.x - priv.x, pirate.y - priv.y);
  let defended = false;
  for (let i = 0; i < 30; i++) { piracy(w, w.rules.SIM_STEP); if (pirate._act && pirate._act.k === 'defend') defended = true; }
  const after = Math.hypot(pirate.x - priv.x, pirate.y - priv.y);
  assert.ok(defended, 'the raider marked itself defending the haven');
  assert.ok(after < before - 50 || pirate._sunk || priv._sunk || (priv.cargo.Weapons || 0) < 4,
    'it closed on the besieger / traded blows rather than ignoring it');
});

test('a ship’s specific ACTIVITY rides the wire to the client (a blockader reads "blockade")', () => {
  const w = makeWorld();
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed + not laden → it blockades
  pirate._huntCd = 0; pirate._prey = null;
  const isle = w.islands[0];
  pirate.x = isle.x + 120; pirate.y = isle.y;
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no prey at sea
  for (let i = 0; i < 20; i++) piracy(w, w.rules.SIM_STEP);

  assert.equal(pirate._act && pirate._act.k, 'blockade', 'the sim tagged what it is actually doing');
  const cold = snapshotShipsCold(w);
  assert.equal(cold[pirate.id].act, 'blockade', 'and that activity is projected onto the cold snapshot');
  assert.ok(cold[pirate.id].actId, 'with the blockaded port’s id, so the panel can name it');
});

test('a circling blockader POINTS ALONG its travel — heading tracks movement, not a stale mark', () => {
  const w = makeWorld();
  const pirate = w.ships.find((s) => s.pirate) || w.ships[0];
  turnPirate(w, pirate);
  pirate.cargo = { Gold: 0, People: 0, Food: 999, Weapons: 10 }; // fed + not laden → it blockades (orbits)
  pirate._huntCd = 0; pirate._prey = null;
  const isle = w.islands[0];
  pirate.x = isle.x + w.rules.PIRATE_BLOCKADE_RANGE; pirate.y = isle.y; // roughly on the ring
  for (const s of w.ships) if (!s.pirate) s.state = 'idle'; // no prey at sea → it blockades
  w.rules = { ...w.rules, SINK_PER_1000: 0 };

  let prev = { x: pirate.x, y: pirate.y };
  let checks = 0, aligned = 0;
  for (let i = 0; i < 80; i++) {
    piracy(w, w.rules.SIM_STEP);
    const mvx = pirate.x - prev.x, mvy = pirate.y - prev.y;
    if (Math.hypot(mvx, mvy) > 0.5) { // it actually travelled this step
      let dd = Math.abs(pirate.heading - Math.atan2(mvy, mvx)) % (Math.PI * 2);
      if (dd > Math.PI) dd = Math.PI * 2 - dd;
      checks++;
      if (dd < 0.35) aligned++; // heading within ~20° of the true direction of travel
    }
    prev = { x: pirate.x, y: pirate.y };
  }
  assert.ok(checks > 20, 'the blockader kept circling (moving each tick)');
  assert.ok(aligned / checks > 0.9, `its bow follows its course (${aligned}/${checks} ticks aligned — the stale-heading bug was near 0)`);
});

test('a pirate that catches a merchant plunders its coin and cargo (weapons burn as a sink)', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  // Put the victim right on top of the pirate, inside combat range, so piracy() resolves a fight.
  turnPirate(w, pirate);
  pirate.x = 1000; pirate.y = 1000; pirate.morale = 1; pirate._huntCd = 0;
  pirate.cargo = { Gold: 0, People: 0, Weapons: 40 }; // heavily armed → very likely to win
  pirate.captain.xp = 5000; // a fearsome, skilled captain
  victim.x = 1000; victim.y = 1000; victim.state = 'outbound'; victim.pirate = false;
  victim.morale = 0.1; victim.cargo = { Gold: 500, People: 0, Food: 30, Weapons: 2 };
  victim.captain.xp = 0;
  const pirateWeaponsBefore = weaponsAboard(pirate);

  piracy(w, w.rules.SIM_STEP);

  const tookLoot = (pirate.cargo[GOLD] || 0) > 0 || (pirate.cargo.Food || 0) > 0;
  const victimStripped = (victim.cargo[GOLD] || 0) < 500 || !!victim._sunk;
  assert.ok(tookLoot, 'the pirate carried off coin and/or cargo');
  assert.ok(victimStripped, 'the merchant lost its coin (or went under)');
  assert.ok(weaponsAboard(pirate) < pirateWeaponsBefore, 'guns were spent in the fight (a weapons sink)');
});

test('a pirate captain EARNS experience from taking a prize (like a merchant does from a voyage)', () => {
  const w = makeWorld();
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = 1200; pirate.y = 1200; pirate.morale = 1; pirate._huntCd = 0;
  pirate.cargo = { Gold: 0, People: 0, Weapons: 40 }; // heavily armed → very likely to win the boarding
  pirate.captain.xp = 200;
  victim.x = 1200; victim.y = 1200; victim.state = 'outbound'; victim.pirate = false;
  victim.morale = 0.1; victim.cargo = { Gold: 500, People: 0, Food: 30, Weapons: 1 };
  victim.captain.xp = 0;
  const xpBefore = pirate.captain.xp;
  piracy(w, w.rules.SIM_STEP);
  assert.ok(pirate.captain.xp.gun > xpBefore, 'the raider’s captain gained experience for the prize (grows more skilled)');
});

test('a pirate takes a struck merchant as a PRIZE — the hull changes flag and joins the black fleet', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PRIZE_CHANCE: 5, PIRATE_MAX_FRAC: 1 }; // certain capture; the seas can bear it
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = victim.x = 1000; pirate.y = victim.y = 1000;
  pirate.morale = 1; pirate._huntCd = 0; pirate.cargo = { Gold: 0, People: 0, Weapons: 40 };
  pirate.captain.xp = { sea: 0, gun: 5000, cmd: 0 };
  pirate.captain.traits = { boldness: 0.8, wanderlust: 0.3, greed: 0.3 };
  victim.pirate = false; victim.state = 'outbound'; victim.morale = 0.04; victim.hull = 1; victim.rig = 1;
  victim.cargo = { Gold: 100, People: 0, Food: 10, Weapons: 1 };
  victim.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  for (let i = 0; i < 12 && !victim.pirate && !victim._sunk; i++) { piracy(w, w.rules.SIM_STEP); w.simTime += w.rules.COMBAT_ROUND_SEC; }
  assert.ok(victim.pirate, 'she struck, was boarded, and now flies the black flag as a prize');
});

test('prize capture respects the fleet-fraction cap — at the cap, the struck merchant is not taken', () => {
  const w = makeWorld();
  w.rules = { ...w.rules, PRIZE_CHANCE: 5, PIRATE_MAX_FRAC: 0 }; // the seas are already at their pirate limit
  const pirate = w.ships[0], victim = w.ships[1];
  turnPirate(w, pirate);
  pirate.x = victim.x = 1000; pirate.y = victim.y = 1000;
  pirate.morale = 1; pirate._huntCd = 0; pirate.cargo = { Gold: 0, People: 0, Weapons: 40 };
  pirate.captain.xp = { sea: 0, gun: 5000, cmd: 0 };
  pirate.captain.traits = { boldness: 0.8, wanderlust: 0.3, greed: 0.3 };
  victim.pirate = false; victim.state = 'outbound'; victim.morale = 0.04; victim.hull = 1; victim.rig = 1;
  victim.cargo = { Gold: 500, People: 0, Food: 30, Weapons: 1 };
  victim.captain.xp = { sea: 0, gun: 0, cmd: 0 };
  for (let i = 0; i < 12 && !victim._sunk && victim.state !== 'inbound'; i++) { piracy(w, w.rules.SIM_STEP); w.simTime += w.rules.COMBAT_ROUND_SEC; }
  assert.ok(!victim.pirate, 'no capture when the seas are already at their pirate cap');
  assert.ok(victim._sunk || victim.state === 'inbound', 'she was scuttled or freed to limp home stripped instead');
});
