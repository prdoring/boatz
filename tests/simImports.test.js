import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Footgun #1 guard: the pure sim (game/sim/**) must import ZERO engine/config —
// only sibling ./ modules and node: builtins — so it loads identically under bare
// `node` (npm start), the browser, and the test loader. The existing
// importGraph.test.js can't catch a stray /engine/ specifier here (its static pass
// treats /engine/ as a valid mount; its dynamic pass skips game/), so we assert it.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function specifiersOf(src) {
  const specs = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

test('game/sim modules import only sibling ./ modules and node: builtins', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'game', 'sim'))) {
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('./') && !spec.startsWith('node:')) {
        offenders.push(`${path.relative(ROOT, file)}  ->  ${spec}`);
      }
    }
  }
  assert.equal(offenders.length, 0, `sim must be self-contained:\n  ${offenders.join('\n  ')}`);
});
