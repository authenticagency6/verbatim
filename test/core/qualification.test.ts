/**
 * qualification.test.ts — the `qualification` array.
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * The seven qualification fields ride in ONE array of `{field, value, evidence}` entries to stay
 * under the 16-union structured-outputs ceiling (schema.ts). `validateQualification` grounds each
 * entry's evidence exactly like `key_facts`, then coerces the value to the field's stored type.
 * These checks mirror the two questions the rest of validate is organised around:
 *   1. Does it accept the legal shapes a model actually emits? (recall — a false drop here loses a
 *      captured qualification fact, and an enum miss also flags review)
 *   2. Does it still reject a fabricated quote or an illegal value? (the point)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction, validateForWriteback } from '../../src/core/validate.ts';

const CALL_DATE = new Date(Date.UTC(2026, 8, 5)); // 2026-09-05

/**
 * One transcript with a grounded, ≥12-word quote for each field. Every `evidence` below is a
 * contiguous substring of this text, so it clears the span floor and the containment check.
 */
const TRANSCRIPT = [
  'So just to recap where we landed on this file today with him.',
  'He told me this is going to be an investment property that he intends to rent out to tenants for the long term.',
  'It is a standard residential purchase and nothing about the loan program is unusual at all in this case.',
  'We walked through the numbers and we are looking at a loan amount of roughly 425000 on this particular purchase.',
  'His plan is a buy and hold strategy where he keeps the property for well over three years before ever selling.',
  'He mentioned he is already working with another lender and is getting a second opinion from us today on the terms.',
  'The clear next step is that he will send over his last two pay stubs by Friday afternoon of this week.',
].join(' ');

/** Evidence quotes reused across tests — each is a real substring of TRANSCRIPT. */
const EV = {
  occupancy: 'this is going to be an investment property that he intends to rent out to tenants for the long term',
  product_fit: 'It is a standard residential purchase and nothing about the loan program is unusual at all in this case',
  loan_amount: 'we are looking at a loan amount of roughly 425000 on this particular purchase',
  exit_strategy: 'His plan is a buy and hold strategy where he keeps the property for well over three years before ever selling',
  hold_period: 'he keeps the property for well over three years before ever selling',
  second_opinion: 'he is already working with another lender and is getting a second opinion from us today on the terms',
  next_step: 'The clear next step is that he will send over his last two pay stubs by Friday afternoon of this week',
};

/** Run just the qualification pass and return its values + failures. */
function qual(entries: unknown[]) {
  return validateExtraction({ qualification: entries as never }, TRANSCRIPT);
}

describe('qualification — accepts the legal shapes a model emits', () => {
  test('all seven fields validate and coerce to the stored type', () => {
    const r = qual([
      { field: 'occupancy', value: 'investment', evidence: EV.occupancy },
      { field: 'product_fit', value: 'standard residential', evidence: EV.product_fit },
      { field: 'loan_amount', value: '425000', evidence: EV.loan_amount },
      { field: 'exit_strategy', value: 'buy & hold', evidence: EV.exit_strategy },
      { field: 'hold_period', value: '3+ years', evidence: EV.hold_period },
      { field: 'second_opinion', value: 'already has a lender', evidence: EV.second_opinion },
      { field: 'next_step', value: 'Send last two pay stubs by Friday', evidence: EV.next_step },
    ]);
    assert.deepEqual(r.failures, [], 'clean input should not fail');
    assert.equal(r.qualification.occupancy, 'Investment');
    assert.equal(r.qualification.product_fit, 'Standard residential');
    assert.equal(r.qualification.loan_amount, 425000);
    assert.equal(r.qualification.exit_strategy, 'Buy & hold');
    assert.equal(r.qualification.hold_period, '3+ years');
    assert.equal(r.qualification.second_opinion, true);
    assert.equal(r.qualification.next_step, 'Send last two pay stubs by Friday');
    assert.equal(r.qualificationNeedsReview, false);
  });

  test('enum coercion tolerates case, spacing and dash variants', () => {
    // A model emitting an ASCII hyphen where the label has an em/en dash must still land.
    const r = qual([
      { field: 'product_fit', value: 'Not offered - fix & flip', evidence: EV.product_fit },
      { field: 'hold_period', value: '1-3 years', evidence: EV.hold_period },
    ]);
    assert.deepEqual(r.failures, []);
    assert.equal(r.qualification.product_fit, 'Not offered — fix & flip');
    assert.equal(r.qualification.hold_period, '1–3 years');
  });

  test('a field not discussed is simply absent, never a failure', () => {
    const r = qual([{ field: 'occupancy', value: '', evidence: EV.occupancy }]);
    assert.deepEqual(r.failures, []);
    assert.equal('occupancy' in r.qualification, false);
  });
});

describe('qualification — rejects what would corrupt the record', () => {
  test('an enum miss drops the value AND flags review (fail-closed-then-flag)', () => {
    const r = validateForWriteback(
      { qualification: [{ field: 'product_fit', value: 'jumbo something', evidence: EV.product_fit }] as never },
      TRANSCRIPT,
      CALL_DATE,
    );
    assert.equal('product_fit' in r.qualification, false, 'illegal enum value is never written');
    assert.equal(r.needsReview, true, 'product_fit gates routing, so a miss flags review');
    assert.equal(r.failures[0].reason, 'not_a_valid_enum_value');
    assert.equal(r.failures[0].qualificationField, 'product_fit');
  });

  test('a fabricated quote drops the entry and does NOT flag review', () => {
    const r = validateForWriteback(
      { qualification: [{ field: 'occupancy', value: 'investment', evidence: 'he said it is an investment for sure and that is completely final' }] as never },
      TRANSCRIPT,
      CALL_DATE,
    );
    assert.equal('occupancy' in r.qualification, false);
    assert.equal(r.needsReview, false, 'a dropped fact is a blank a human fills');
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('a too-short quote is rejected', () => {
    const r = qual([{ field: 'occupancy', value: 'investment', evidence: 'investment property' }]);
    assert.equal('occupancy' in r.qualification, false);
    assert.equal(r.failures[0].reason, 'evidence_too_short');
  });

  test('loan_amount must appear inside its own quote', () => {
    const r = qual([{ field: 'loan_amount', value: '999999', evidence: EV.loan_amount }]);
    assert.equal('loan_amount' in r.qualification, false);
    assert.equal(r.failures[0].reason, 'not_grounded_in_transcript');
  });

  test('an implausible loan_amount is dropped before grounding', () => {
    const r = qual([{ field: 'loan_amount', value: '500', evidence: EV.loan_amount }]);
    assert.equal('loan_amount' in r.qualification, false);
    assert.equal(r.failures[0].reason, 'implausible_for_field');
  });

  test('an unknown field name is reported, not silently dropped', () => {
    const r = qual([{ field: 'credit_score', value: '720', evidence: EV.next_step }]);
    assert.equal(r.failures[0].reason, 'unknown_qualification_field');
    assert.equal(r.failures[0].field, 'qualification');
  });

  test('second_opinion is set-true-only — never false', () => {
    const r = qual([{ field: 'second_opinion', value: 'yes', evidence: EV.second_opinion }]);
    assert.equal(r.qualification.second_opinion, true);
    // An absent entry leaves it unset (undefined), so write-back's skip-null keeps the box as-is.
    const none = qual([]);
    assert.equal(none.qualification.second_opinion, undefined);
  });
});
