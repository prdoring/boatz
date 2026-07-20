// Shared PERSON-name vocabulary for the sim's named people — ship captains (captains.js) and
// island magistrates (magistrate.js). Pooled here so both draw from the same deep lists and a big
// sea reads as a cast of distinct people, not a dozen "Anne Bonny"s and "Governor Blackstock"s.
// PURE: imports nothing but the seeded RNG; the 'captain'/'mag' streams are supplied by the caller.
// (Vessel names live in naming.js — a separate namespace with the same preference-not-forced dedup.)

/** Given (fore) names, shared by captains and magistrates. */
export const GIVEN = [
  'Bartholomew', 'Anne', 'Edward', 'Mary', 'Henry', 'Jack', 'Grace', 'Samuel', 'Eliza', 'Roderick',
  'Isabel', 'Cutler', 'Morgan', 'Selby', 'Oona', 'Diego', 'Fen', 'Cormac', 'Halvard', 'Nadia',
  'Tobias', 'Wren', 'Amara', 'Lorcan', 'Sim', 'Petra', 'Osric', 'Yara', 'Bram', 'Cassia',
  'Elias', 'Ffion', 'Gideon', 'Hester', 'Ines', 'Joris', 'Kestrel', 'Lena', 'Merrick', 'Niamh',
  'Otto', 'Perrin', 'Corin', 'Rhys', 'Saskia', 'Thaddeus', 'Ulric', 'Vesper', 'Willa', 'Ximena',
  'Yohan', 'Zadie', 'Alaric', 'Brisa', 'Caspian', 'Dagny', 'Emeric', 'Faye', 'Galen', 'Rosa',
  'Aldous', 'Bertrand', 'Clara', 'Dorian', 'Esme', 'Florian', 'Greta', 'Hugo', 'Imogen', 'Jasper',
  'Katarina', 'Leopold', 'Marguerite', 'Nikolai', 'Odette', 'Percival', 'Quenby', 'Reyna', 'Sebastian', 'Tamsin',
  'Ursula', 'Valentina', 'Wendell', 'Xanthe', 'Yseult', 'Zephyr', 'Ambrose', 'Beatrix', 'Conrad', 'Delphine',
  'Ewan', 'Fiora', 'Gustav', 'Helena', 'Isidore', 'Juno', 'Konrad', 'Liesel', 'Matthias', 'Noor',
];
/** Family names — captains take one directly ("Anne Bonny"), magistrates after a title. */
export const SURNAME = [
  'Blackwood', 'Ironside', 'Vane', 'Roberts', 'Bonny', 'Teague', 'Kidd', 'Sharpe', 'Thorne', 'Doubloon',
  'Marlowe', 'Ashgrave', 'Quill', 'Storm', 'Bellweather', 'Crane', 'Voss', 'Hollick', 'Dunmore', 'Salt',
  'Redfern', 'Copperhand', 'Yarrow', 'Finch', 'Mercer', 'Grimsby', 'Hawke', 'Fenwick', 'Locke', 'Ravenscar',
  'Sable', 'Thornbury', 'Underhill', 'Wexley', 'Ashby', 'Calloway', 'Drummond', 'Everhart', 'Frost', 'Garrick',
  'Holloway', 'Ironwood', 'Jarrow', 'Kingsley', 'Lambert', 'Moore', 'Nash', 'Oakes', 'Pryce', 'Rourke',
  'Sterling', 'Tandy', 'Vance', 'Whitlock', 'Ayers', 'Brine', 'Cobb', 'Delgado', 'Emberly', 'Fairweather',
  'Ashcombe', 'Pennywise', 'Harrow', 'Thistlewood', 'Crowe', 'Blackstock', 'Hargrave', 'Stoneleigh', 'Verity', 'Loxley',
  'Pembroke', 'Rookwood', 'Cordwainer', 'Dabney', 'Marchbanks', 'Ravenscroft', 'Thorncastle', 'Wexford', 'Alderton', 'Bramwell',
  'Cutteridge', 'Darrow', 'Ellery', 'Fallowbrook', 'Grimshaw', 'Hartley', 'Ivorson', 'Jessop', 'Kettering', 'Larkspur',
  'Merrivale', 'Netherby', 'Oldcastle', 'Pettigrew', 'Quillan', 'Rathbone', 'Stormont', 'Trevelyan', 'Ufford', 'Vexley',
  'Warlow', 'Yardley', 'Ashford', 'Bellamy', 'Corwin', 'Dunbar', 'Ellsworth', 'Fitchett', 'Grindle', 'Hocking',
  'Ingram', 'Jerrold', 'Kilbride', 'Lockwood', 'Marrow', 'Norrington', 'Ostrander', 'Paskell', 'Ridley', 'Swann',
  'Tolliver', 'Weatherby', 'Alcott', 'Blythe', 'Carrow', 'Deverell', 'Esterbrook', 'Fanshawe', 'Golightly', 'Hemlock',
];
/** Pirate bynames used in place of a surname ("Cormac Redhand"). */
export const EPITHET = [
  'the Bold', 'the Shrewd', 'Redhand', 'the Patient', 'Stormborn', 'the Lucky', 'Ironwill', 'the Quiet', 'Longreach',
  'the Fair', 'the Dread', 'Blackheart', 'the Cunning', 'Saltbeard', 'the Merciless', 'Ironhand', 'the Relentless',
  'Stormcrow', 'the Grim', 'Deadeye', 'the Ruthless', 'Coldhand', 'the Fearless', 'the Vengeful', 'Gravewater',
  'the Undaunted', 'Farhaven', 'the Wily',
];

export const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];

// Uniqueness is a PREFERENCE, never forced: re-roll a composed name a handful of times to dodge one a
// living person of the same kind already bears, then accept whatever came up rather than loop forever.
const DEDUP_TRIES = 24;

/** Compose a name, preferring one not already in `taken` (the caller's set of living names of this
 *  kind), then record it. `compose` draws from the seeded stream; `taken` is derived from live world
 *  state (a pure function of the sea, so it survives serialize→deserialize identically) or a shared
 *  batch set threaded through world genesis so a whole cast dedupes in one pass. */
export function composeUniqueName(compose, taken) {
  let name = compose();
  for (let t = 0; t < DEDUP_TRIES && taken.has(name); t++) name = compose();
  taken.add(name);
  return name;
}
