// Preview tool for the procedural roster (the generator itself lives in
// game/sim/roster.js and runs at server boot). `node scripts/gen-roster.mjs [seed]`
// prints a summary of the sea a given seed produces — handy for eyeballing balance.
import { generateRoster } from '../game/sim/roster.js';

const seed = Number(process.argv[2] || 1);
const { ocean, islands } = generateRoster(seed);

const rc = {}, pc = { Food: 0, Ale: 0, Clothing: 0, Weapons: 0, LuxuryGoods: 0, Ships: 0 };
for (const i of islands) { rc[i.primary] = (rc[i.primary] || 0) + 1; for (const g of i.produces) pc[g]++; }
console.log(`roster seed ${seed}: ${islands.length} islands in a ${ocean.width}x${ocean.height} ocean`);
console.log('  raw producers:', rc);
console.log('  good producers:', pc, '| shipyards:', islands.filter((i) => i.type === 'shipyard').length);
console.log('  sample:', islands.slice(0, 4).map((i) => `${i.name}(${i.primary} @${i.x},${i.y})`).join('  '));
