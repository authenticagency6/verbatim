// Runs the private regression set if present. Asserts each fixture's `expected` extraction
// survives validation (the false-drop guard). Probe semantics live in the fixtures themselves.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { validateForWriteback, summarizeFailures } from '../src/core/validate.ts';

const DIR = new URL('../private/regression/', import.meta.url);
if (!existsSync(DIR)) {
  console.log('regress: private/regression absent; skipping');
  process.exit(0);
}
let failed = 0;
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
  const r = validateForWriteback(fx.expected, fx.transcript, new Date(fx.call_date + 'T12:00:00Z'));
  const drops = r.failures.filter((x) => x.reason !== 'older_call_kept');
  if (drops.length) {
    failed++;
    console.log(`FAIL ${fx.id}: ${summarizeFailures(drops)}`);
  } else console.log(`ok   ${fx.id}`);
}
process.exit(failed ? 1 : 0);
