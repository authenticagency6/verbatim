// test/core/port.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const coreFiles = readdirSync(new URL('../../src/core/', import.meta.url)).filter((f) => f.endsWith('.ts'));

test('no NUL bytes in core sources (git would treat the file as binary)', () => {
  for (const f of coreFiles) {
    const buf = readFileSync(new URL(`../../src/core/${f}`, import.meta.url));
    assert.equal(buf.includes(0), false, `${f} contains a NUL byte`);
  }
});

test('core imports nothing outside src/core', () => {
  for (const f of coreFiles) {
    const src = readFileSync(new URL(`../../src/core/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      assert.match(m[1], /^\.\/[\w-]+\.ts$/, `${f} imports ${m[1]}`);
    }
  }
});

test('the six ported modules exist', () => {
  for (const f of ['redact.ts', 'guard.ts', 'validate.ts', 'schema.ts', 'types.ts', 'extract.ts']) {
    assert.ok(coreFiles.includes(f), `missing ${f}`);
  }
});
