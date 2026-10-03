// scripts/scan-staged.mjs
// Fails the commit if the staged diff contains a scrubbed name or a secret-shaped string.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const LIST = 'private/scrub-names.txt';
if (!existsSync(LIST)) {
  console.error(`scan: ${LIST} is missing. Refusing to pass (fail closed).`);
  process.exit(1);
}
const patterns = readFileSync(LIST, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => new RegExp(l, 'i'));
// Generic id shapes (app.../rec...) are NOT used: they false-match code like applyD1Migrations.
// The real base and record ids go in the private list instead.
patterns.push(/sk-ant-[a-z0-9_-]{10,}/i);

const diff = execSync('git diff --cached -U0', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let file = '';
const hits = [];
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) file = line.slice(6);
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const p of patterns) if (p.test(line)) hits.push(`${file}: ${p} :: ${line.slice(0, 120)}`);
}
if (hits.length) {
  console.error('scan: BLOCKED\n' + hits.join('\n'));
  process.exit(1);
}
console.log('scan: clean');
