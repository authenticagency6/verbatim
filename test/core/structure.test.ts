/**
 * structure.test.ts — enum compliance and date sanity.
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * These checks guard a different failure than G0/G1. Grounding asks whether a value was said on
 * the call; this asks whether the value is legal for the field it is about to be written to. The
 * production consequence is specific and silent: a novel `urgency_flag` string written into a
 * single-select either 422s or creates a junk option that no automation rule matches,
 * so the rush alert never fires and nobody finds out.
 *
 * The suite is organised the same way validate.test.ts is, around the two questions that decide
 * whether this is usable:
 *   1. Does it accept the legal values a model actually emits? (recall — false drops here delete
 *      alerts and captured promises, and they do it silently)
 *   2. Does it still reject what would break a downstream automation? (the point)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStructure,
  validateForWriteback,
  summarizeFailures,
  ENUM_VALUES,
  STRUCTURAL_ENUM_FIELDS,
  MAX_FOLLOW_UP_DAYS,
  MAX_PREAPPROVAL_AGE_DAYS,
} from '../../src/core/validate.ts';

/** The call all the date tests are anchored to. Never "now" — see validateStructure's docs. */
const CALL_DATE = new Date(Date.UTC(2026, 7, 15)); // 2026-08-15

/** Offset from CALL_DATE, as the YYYY-MM-DD string the model would emit. */
function dayOffset(days: number): string {
  const d = new Date(CALL_DATE.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------

describe('enum — accepts what the schema defines', () => {
  test('every declared member of every STRUCTURAL enum validates unchanged', () => {
    // Only the structural enums — the qualification selects are validated by validateQualification,
    // not validateStructure, and are covered in validate.test.ts.
    for (const field of STRUCTURAL_ENUM_FIELDS) {
      for (const value of ENUM_VALUES[field]) {
        const r = validateStructure({ [field]: value }, CALL_DATE);
        assert.deepEqual(r.failures, [], `${field}=${value} should pass`);
        assert.equal(r.fields[field as keyof typeof r.fields], value);
      }
    }
  });

  test('null is "not extracted", not a failure', () => {
    const r = validateStructure({ urgency_flag: null, waiting_on: null }, CALL_DATE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.needsReview, false);
    assert.equal(r.fields.urgency_flag, null);
  });

  test('empty string is treated as null, not as a bad value', () => {
    const r = validateStructure({ urgency_flag: '   ' }, CALL_DATE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.fields.urgency_flag, null);
  });

  test('absent keys are not defaulted into the output', () => {
    const r = validateStructure({ urgency_flag: 'rush' }, CALL_DATE);
    assert.equal('waiting_on' in r.fields, false);
    assert.equal('language' in r.fields, false);
  });
});

describe('enum — coercion is formatting only', () => {
  test('case and surrounding whitespace are repaired', () => {
    for (const raw of ['Rush', 'RUSH', ' rush ', '\trush\n']) {
      const r = validateStructure({ urgency_flag: raw }, CALL_DATE);
      assert.deepEqual(r.failures, [], `${JSON.stringify(raw)} should coerce`);
      assert.equal(r.fields.urgency_flag, 'rush');
    }
  });

  test('third-party survives underscore and space spellings', () => {
    for (const raw of ['third_party', 'third party', 'Third-Party']) {
      const r = validateStructure({ waiting_on: raw }, CALL_DATE);
      assert.deepEqual(r.failures, [], `${raw} should coerce`);
      assert.equal(r.fields.waiting_on, 'third-party');
    }
  });

  test('multi-word stage names coerce on case alone', () => {
    const r = validateStructure({ loan_stage: 'under contract' }, CALL_DATE);
    assert.equal(r.fields.loan_stage, 'Under Contract');
  });

  test('🚩 a plausible SYNONYM is rejected, not guessed at', () => {
    // The boundary that keeps this a deterministic gate. "high" clearly means rush to a human;
    // mapping it would put a probabilistic step inside the validator guarding the write.
    for (const raw of ['high', 'urgent', 'asap', 'medium', 'low']) {
      const r = validateStructure({ urgency_flag: raw }, CALL_DATE);
      assert.equal(r.failures.length, 1, `${raw} must not be coerced`);
      assert.equal(r.failures[0].reason, 'not_a_valid_enum_value');
      assert.equal(r.fields.urgency_flag, null);
    }
  });

  test('a prose answer is rejected', () => {
    const r = validateStructure(
      { urgency_flag: 'the client seems fairly urgent about this' },
      CALL_DATE,
    );
    assert.equal(r.failures[0].reason, 'not_a_valid_enum_value');
    assert.equal(r.fields.urgency_flag, null);
  });

  test('a value legal for a DIFFERENT enum is still rejected', () => {
    const r = validateStructure({ waiting_on: 'rush' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_enum_value');
  });

  test('language does not accept a full language name', () => {
    const r = validateStructure({ language: 'spanish' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_enum_value');
    assert.equal(r.fields.language, null);
  });
});

describe('enum — failures route to review', () => {
  test('a bad enum sets needsReview', () => {
    const r = validateStructure({ urgency_flag: 'high' }, CALL_DATE);
    assert.equal(r.needsReview, true);
  });

  test('a clean run does not', () => {
    const r = validateStructure({ urgency_flag: 'rush', waiting_on: 'client' }, CALL_DATE);
    assert.equal(r.needsReview, false);
  });

  test('the failure reaches the run-record summary with the offending value', () => {
    const r = validateStructure({ urgency_flag: 'high' }, CALL_DATE);
    const summary = summarizeFailures(r.failures);
    assert.match(summary, /urgency_flag=high/);
    assert.match(summary, /not_a_valid_enum_value/);
  });
});

describe('date — format', () => {
  test('a well-formed near-term follow-up passes', () => {
    const r = validateStructure({ follow_up_date: dayOffset(7) }, CALL_DATE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.fields.follow_up_date, dayOffset(7));
  });

  test('an unresolved relative date is rejected', () => {
    // The model is asked for YYYY-MM-DD. "next Friday" means it did not do the resolution,
    // and the store would reject or misparse it.
    const r = validateStructure({ follow_up_date: 'next Friday' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_date');
    assert.equal(r.fields.follow_up_date, null);
  });

  test('a rollover date that Date.parse would silently accept is rejected', () => {
    const r = validateStructure({ follow_up_date: '2026-02-30' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_date');
  });

  test('an impossible month is rejected', () => {
    const r = validateStructure({ follow_up_date: '2026-13-01' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_date');
  });

  test('a real leap day is accepted', () => {
    const r = validateStructure({ follow_up_date: '2028-02-29' }, new Date(Date.UTC(2028, 1, 1)));
    assert.deepEqual(r.failures, []);
  });

  test('US-format and slashed dates are rejected rather than guessed', () => {
    for (const raw of ['08/22/2026', '22-08-2026', 'Aug 22 2026']) {
      const r = validateStructure({ follow_up_date: raw }, CALL_DATE);
      assert.equal(r.failures[0].reason, 'not_a_valid_date', `${raw} should be rejected`);
    }
  });

  test('a datetime is rejected — the schema says date', () => {
    const r = validateStructure({ follow_up_date: '2026-08-22T14:00:00Z' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'not_a_valid_date');
  });
});

describe('date — follow_up_date window', () => {
  test('same-day is valid, not "in the past"', () => {
    const r = validateStructure({ follow_up_date: dayOffset(0) }, CALL_DATE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.fields.follow_up_date, dayOffset(0));
  });

  test('the day before the call is rejected', () => {
    const r = validateStructure({ follow_up_date: dayOffset(-1) }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'date_before_call');
    assert.equal(r.fields.follow_up_date, null);
  });

  test('a stale year is rejected as before-call, which is the honest reason', () => {
    const r = validateStructure({ follow_up_date: '2025-08-22' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'date_before_call');
  });

  test('a long but real horizon is kept', () => {
    // "call me after the holidays" / "when my lease is up" are real follow-ups.
    const r = validateStructure({ follow_up_date: dayOffset(180) }, CALL_DATE);
    assert.deepEqual(r.failures, []);
  });

  test('the boundary itself is inclusive', () => {
    const r = validateStructure({ follow_up_date: dayOffset(MAX_FOLLOW_UP_DAYS) }, CALL_DATE);
    assert.deepEqual(r.failures, []);
  });

  test('one day past the boundary is rejected', () => {
    const r = validateStructure({ follow_up_date: dayOffset(MAX_FOLLOW_UP_DAYS + 1) }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'date_implausibly_far');
  });

  test('a century typo is caught', () => {
    const r = validateStructure({ follow_up_date: '2126-08-22' }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'date_implausibly_far');
  });

  test('🚩 a weekend follow-up is NOT dropped', () => {
    // 2026-08-22 is a Saturday. This team works weekends; nulling it would delete a real
    // promise to enforce an office convention the client does not keep.
    const saturday = '2026-08-22';
    assert.equal(new Date(saturday + 'T00:00:00Z').getUTCDay(), 6, 'fixture must be a Saturday');
    const r = validateStructure({ follow_up_date: saturday }, CALL_DATE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.fields.follow_up_date, saturday);
  });
});

describe('date — preapproval_date window', () => {
  test('today and the recent past are valid', () => {
    for (const offset of [0, -1, -30, -89]) {
      const r = validateStructure({ preapproval_date: dayOffset(offset) }, CALL_DATE);
      assert.deepEqual(r.failures, [], `offset ${offset} should pass`);
    }
  });

  test('a future pre-approval is rejected — it is issued, never scheduled', () => {
    const r = validateStructure({ preapproval_date: dayOffset(3) }, CALL_DATE);
    assert.equal(r.failures[0].reason, 'date_in_future');
    assert.equal(r.fields.preapproval_date, null);
  });

  test('an ancient pre-approval is rejected', () => {
    const r = validateStructure(
      { preapproval_date: dayOffset(-(MAX_PREAPPROVAL_AGE_DAYS + 1)) },
      CALL_DATE,
    );
    assert.equal(r.failures[0].reason, 'date_implausibly_far');
  });

  test('the two date fields use opposite windows', () => {
    // Same date, one field each: tomorrow is fine to follow up on, impossible to be approved on.
    const tomorrow = dayOffset(1);
    const followUp = validateStructure({ follow_up_date: tomorrow }, CALL_DATE);
    const preapproval = validateStructure({ preapproval_date: tomorrow }, CALL_DATE);
    assert.deepEqual(followUp.failures, []);
    assert.equal(preapproval.failures[0].reason, 'date_in_future');
  });
});

describe('callDate is the call, not wall-clock', () => {
  test('a backfilled transcript keeps a follow-up that is now in the past', () => {
    // A batch sweep or a manual ingest can deliver a transcript days late. Judging
    // against "now" would null a follow-up that was correct when the promise was made.
    const oldCall = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01
    const r = validateStructure({ follow_up_date: '2026-07-08' }, oldCall);
    assert.deepEqual(r.failures, []);
    assert.equal(r.fields.follow_up_date, '2026-07-08');
  });
});

describe('validateForWriteback — the step 5b entry point', () => {
  const transcript =
    'so we would be looking at about thirty two hundred a month all in, and I will give you a call back next week';

  test('grounding and structural failures merge into one list', () => {
    const r = validateForWriteback(
      {
        guardrails: { max_payment: 9999 }, // never said → grounding failure
        urgency_flag: 'high', // not an enum → structural failure
      },
      transcript,
      CALL_DATE,
    );
    assert.equal(r.failures.length, 2);
    const reasons = r.failures.map((f) => f.reason).sort();
    assert.deepEqual(reasons, ['not_a_valid_enum_value', 'not_grounded_in_transcript']);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.structural.urgency_flag, null);
    assert.equal(r.needsReview, true);
  });

  test('a grounded value with a legal enum passes both', () => {
    const r = validateForWriteback(
      { guardrails: { max_payment: 3200 }, urgency_flag: 'rush', follow_up_date: dayOffset(7) },
      transcript,
      CALL_DATE,
    );
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.max_payment, 3200);
    assert.equal(r.structural.urgency_flag, 'rush');
    assert.equal(r.follow_up_date, dayOffset(7));
    assert.equal(r.needsReview, false);
  });

  test('🚩 a date rejected by the structural pass stays null on the way out', () => {
    // The `??` bug this guards against restored the rejected value from the grounding result.
    const r = validateForWriteback({ follow_up_date: dayOffset(-30) }, transcript, CALL_DATE);
    assert.equal(r.follow_up_date, null);
    assert.equal(r.failures[0].reason, 'date_before_call');
  });

  test('a preapproval_date rejected by the structural pass stays null in guardrails', () => {
    const r = validateForWriteback(
      { guardrails: { preapproval_date: dayOffset(30) } },
      transcript,
      CALL_DATE,
    );
    assert.equal(r.guardrails.preapproval_date, null);
    assert.equal(r.failures[0].reason, 'date_in_future');
  });

  test('a date already nulled for a fabricated quote is not re-reported as a bad date', () => {
    const r = validateForWriteback(
      {
        follow_up_date: {
          value: dayOffset(7),
          evidence: 'a sentence that was never spoken on this call at any point whatsoever',
        },
      },
      transcript,
      CALL_DATE,
    );
    assert.equal(r.follow_up_date, null);
    assert.equal(r.failures.length, 1, 'one failure, not two');
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('fields the extraction never included are not invented', () => {
    const r = validateForWriteback({ guardrails: { max_payment: 3200 } }, transcript, CALL_DATE);
    assert.equal('urgency_flag' in r.structural, false);
    assert.equal('follow_up_date' in r.structural, false);
  });

  test('key_facts and blocker still pass through the grounding pass untouched', () => {
    const r = validateForWriteback(
      { key_facts: ['client is pre-approved'], blocker: 'waiting on CPA', urgency_flag: 'normal' },
      transcript,
      CALL_DATE,
    );
    assert.deepEqual(r.key_facts, ['client is pre-approved']);
    assert.equal(r.blocker, 'waiting on CPA');
    assert.deepEqual(r.failures, []);
  });
});
