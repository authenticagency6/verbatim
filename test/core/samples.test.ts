import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { redactTranscript } from '../../src/core/redact.ts';

const DIR = new URL('../../samples/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

test('three samples exist', () => assert.equal(files.length, 3));

for (const f of files) {
  const s = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
  test(`${f}: shape`, () => {
    assert.ok(s.id && s.title && /^\d{4}-\d{2}-\d{2}$/.test(s.callDate));
    assert.ok(s.transcript.split(/\s+/).length >= 150, 'a demo call should be at least 150 words');
    assert.match(s.transcript, /^Renata: /m);
  });
  test(`${f}: nothing for redaction to remove (demo text is clean)`, () => {
    const r = redactTranscript(s.transcript);
    assert.equal(r.redacted, s.transcript);
  });
}
