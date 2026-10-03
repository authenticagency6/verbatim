/**
 * redact.test.ts — redaction (step 4b).
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * Organised around the two questions every suite in this codebase answers:
 *   1. Does it remove what must be gone? (fixture R-07's `redaction_targets` is the
 *      acceptance case — the fixture was built for this module before the module existed)
 *   2. Does it leave alone what the Engine needs? (false redaction is this module's version
 *      of the false drop — eat a spoken figure and G0 nulls a correct guardrail downstream)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { redactTranscript } from '../../src/core/redact.ts';
import { assertRedacted } from '../../src/core/guard.ts';

// The regression set is private (gitignored). Skip the acceptance block when it is absent.
const R07_URL = new URL('../../private/regression/R-07-application-intake.json', import.meta.url);
const R07 = existsSync(R07_URL)
  ? (JSON.parse(readFileSync(R07_URL, 'utf8')) as { transcript: string; redaction_targets: string[] })
  : null;
const R07_SKIP = R07 ? false : 'private regression set absent';

describe('R-07 acceptance — the fixture built for this module', { skip: R07_SKIP }, () => {
  if (!R07) return;
  const r07 = R07;
  const result = redactTranscript(r07.transcript);

  for (const target of r07.redaction_targets) {
    test(`target gone: "${target.slice(0, 30)}…"`, () => {
      assert.ok(!result.redacted.includes(target), `still present: ${target}`);
    });
  }

  test('output passes the step 5b guard without throwing', () => {
    assert.doesNotThrow(() => assertRedacted(result.redacted));
  });

  test('all four kinds were counted', () => {
    assert.ok(result.counts.ssn >= 1, 'ssn');
    assert.ok(result.counts.dob >= 1, 'dob');
    assert.ok(result.counts.address >= 1, 'address');
    assert.ok(result.counts.account >= 1, 'account');
  });

  test('what the Engine needs SURVIVES — the referral, the deadline, the follow-up day', () => {
    assert.ok(result.redacted.includes('Renata Alvarez over at Coastal Realty'));
    assert.ok(result.redacted.includes('sign those within a few days or the file stalls'));
    assert.ok(result.redacted.includes('check in with you on Wednesday'));
  });

  test('placeholders read as sentence parts, not holes', () => {
    assert.ok(result.redacted.includes('[SSN]'));
    assert.ok(result.redacted.includes('[DOB]'));
    assert.ok(result.redacted.includes('[ADDRESS]'));
  });
});

describe('SSN', () => {
  test('digit shape is removed with no context at all', () => {
    const { redacted, counts } = redactTranscript('Sure, 412-88-9067, got a pen?');
    assert.ok(!redacted.includes('412-88-9067'));
    assert.equal(counts.ssn, 1);
  });

  test('spoken digits after SSN language are removed', () => {
    const { redacted } = redactTranscript(
      'Priya: Social security number when you are ready.\nClient: four one two, eight eight, nine zero six seven.',
    );
    assert.ok(!/four one two/.test(redacted), redacted);
  });

  test('🚩 a PHONE number is not an SSN — 3-3-4 stays, and nothing throws', () => {
    const text = 'Best number for you? 555-555-0142, that is my cell.';
    const { redacted } = redactTranscript(text);
    assert.equal(redacted, text);
    assert.doesNotThrow(() => assertRedacted(redacted));
  });

  test('SSN language with nothing redactable in the window warns — the lexicon-gap signal', () => {
    const { warnings } = redactTranscript(
      'Priya: I still need your social security number, but we can grab that tomorrow.',
    );
    assert.ok(warnings.includes('ssn_context_without_redaction'));
  });
});

describe('DOB — context-gated, because dates are everywhere', () => {
  test('spoken date across a speaker turn is removed (the R-07 shape)', () => {
    const { redacted } = redactTranscript(
      'Priya: And your date of birth?\nClient: March fourth, nineteen eighty eight.',
    );
    assert.ok(!redacted.includes('March fourth'), redacted);
    assert.ok(redacted.includes('[DOB]'));
  });

  test('digit date after DOB language is removed', () => {
    const { redacted } = redactTranscript('My DOB is 3/4/1988 if you need it.');
    assert.ok(!redacted.includes('3/4/1988'));
  });

  test('🚩 a FOLLOW-UP date is not a DOB — no context, no redaction', () => {
    const text = 'Renata: I will follow up with you March fourth once the appraisal is back.';
    const { redacted } = redactTranscript(text);
    assert.equal(redacted, text);
  });

  test('"born" without a date nearby warns instead of guessing', () => {
    const { redacted, warnings } = redactTranscript('Client: Born and raised in Tallbrook, actually.');
    assert.ok(redacted.includes('Born and raised in Tallbrook'));
    assert.ok(warnings.includes('dob_context_without_redaction'));
  });
});

describe('addresses and accounts', () => {
  test('street address is removed shape-only, no context needed', () => {
    const { redacted } = redactTranscript('We are over at 1420 Bayshore Court in Tallbrook.');
    assert.ok(!redacted.includes('1420 Bayshore Court'));
    assert.ok(redacted.includes('[ADDRESS] in Tallbrook'));
  });

  test('account fragment names itself and is removed', () => {
    const { redacted } = redactTranscript('Harbor Point Credit Union, account ends 5583.');
    assert.ok(!redacted.includes('5583'));
  });

  test('full digit run near account language is removed', () => {
    const { redacted } = redactTranscript('The account number is 004417822953 at Harbor Point.');
    assert.ok(!redacted.includes('004417822953'));
  });
});

describe('what must survive — the false-redaction guard', () => {
  test('spoken mortgage figures are untouched', () => {
    const text =
      'Renata: We can approve you up to four hundred thousand, payment right around thirty ' +
      'two hundred a month, maybe twelve thousand five hundred out of pocket. Rate is between ' +
      'six and a half and six and seven eighths.';
    const { redacted, counts } = redactTranscript(text);
    assert.equal(redacted, text);
    assert.deepEqual(counts, { ssn: 0, dob: 0, address: 0, account: 0 });
  });

  test('digit figures are untouched', () => {
    const text = 'Client: So $3,200 a month on a 400k approval, and rates near 6.875?';
    const { redacted } = redactTranscript(text);
    assert.equal(redacted, text);
  });
});

describe('module properties', () => {
  test('idempotent — redacting redacted text changes nothing', { skip: R07_SKIP }, () => {
    const r07 = R07!;
    const once = redactTranscript(r07.transcript).redacted;
    const twice = redactTranscript(once).redacted;
    assert.equal(twice, once);
  });

  test('the result carries no original NPI anywhere — counts and fixed strings only', { skip: R07_SKIP }, () => {
    const r07 = R07!;
    const result = redactTranscript(r07.transcript);
    const everything = JSON.stringify({ counts: result.counts, warnings: result.warnings });
    for (const target of r07.redaction_targets) {
      assert.ok(!everything.includes(target));
    }
  });

  test('empty and null-ish input is handled', () => {
    assert.equal(redactTranscript('').redacted, '');
  });
});
