import { readFileSync } from 'node:fs';
import { buildWorld, stepWorld } from './game/sim/world.js';
import { generateRoster } from './game/sim/roster.js';
const base = JSON.parse(readFileSync('./data/economy.json','utf8'));
for (const [label, embThresh] of [['teeth ON', base.tuning.REP_EMBARGO_THRESHOLD], ['embargo OFF', -9]]) {
  const economy = JSON.parse(JSON.stringify(base)); economy.tuning.REP_EMBARGO_THRESHOLD = embThresh; economy.tuning.EVENT_LOG_MAX = 1e9;
  let tot={ships:0,starve:0,famine:0,aid:0,betray:0,embargo:0}; const seeds=[1,7,42];
  for (const rs of seeds) {
    const w = buildWorld({ economy, roster: generateRoster(rs), seed: 1337 });
    for (let d=0; d<90; d++) for(let i=0;i<60;i++) stepWorld(w,1.0);
    const c={}; for (const e of w.events) c[e.kind]=(c[e.kind]||0)+1;
    tot.ships+=w.ships.length; tot.starve+=c.starve||0; tot.famine+=c.famine||0; tot.aid+=c.aid||0; tot.betray+=c.betray||0; tot.embargo+=c.embargo||0;
  }
  const n=seeds.length;
  console.log(`${label}: ships ${(tot.ships/n).toFixed(0)} | starve ${(tot.starve/n).toFixed(0)} famine ${(tot.famine/n).toFixed(0)} | aid ${(tot.aid/n).toFixed(0)} betray ${(tot.betray/n).toFixed(0)} embargo ${(tot.embargo/n).toFixed(0)}`);
}
