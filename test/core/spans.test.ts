/**
 * spans.test.ts — G1 evidence spans.
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * The suite is organised around the two things that decide whether G1 is usable in production:
 *   1. Does a quote a real model would emit survive the check? (curly apostrophes, dropped
 *      commas, re-cased first letters — false drops here delete the guardrail feature silently)
 *   2. Does an invented or paraphrased quote still get caught? (the entire point)
 *
 * ⚠️ FIXTURES ARE INLINE, DELIBERATELY. `fixtures/*.json` is reserved for the ~20 REAL
 * transcripts in the acceptance gate. These are hand-written to be shaped like model output —
 * including the mess: curly quotes, ragged whitespace, a paraphrase where a quote was asked for.
 * When the real fixtures land, they test the prompt; these keep testing the validator.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExtraction,
  canonicalizeSpan,
  summarizeFailures,
  MIN_SPAN_WORDS,
  type SpannedExtraction,
} from '../../src/core/validate.ts';

// ---------------------------------------------------------------------------
// The reference transcript. Speaker-labelled and ragged, like phone-system output.
// Every span below is copied out of THIS text — if you edit it, re-check the spans.
// ---------------------------------------------------------------------------

const TRANSCRIPT = `
  Renata: Hey Maria, thanks for hopping on. I pulled everything this morning and I've got good news.
  Maria: Oh good - we've been going back and forth on that house on Bayshore.
  Renata: So with the updated income docs, we can get you approved up to four hundred thousand on the purchase price.
  Maria: Okay, that's higher than last time.
  Renata: It is. Now on the payment side, at that price you'd be looking at about thirty two hundred a month all in — that's principal, interest, taxes and insurance.
  Maria: And what would we need at closing?
  Renata: You'd want to plan on roughly twelve thousand five hundred out of pocket at closing, give or take.
  Maria: And the rate?
  Renata: Today we're somewhere between six and a half and six and seven eighths depending on when you lock.
  Maria: My husband is going to ask about the timeline.
  Renata: Your preapproval letter is dated August fifteenth, so you're good for ninety days. I'll email it over this afternoon.
  Maria: We're still waiting on my CPA to send over the 2025 tax returns though, that hasn't happened yet.
  Renata: That's the one thing holding us up. Once those land I'll refresh the file. Let's talk again next Friday.
`;

/** Spans as a model would emit them — curly apostrophes, sentence case preserved. */
const SPAN = {
  approved_price:
    'with the updated income docs, we can get you approved up to four hundred thousand on the purchase price',
  max_payment: 'at that price you’d be looking at about thirty two hundred a month all in',
  max_out_of_pocket:
    'You’d want to plan on roughly twelve thousand five hundred out of pocket at closing',
  rate: 'Today we’re somewhere between six and a half and six and seven eighths depending on when you lock',
  preapproval:
    'Your preapproval letter is dated August fifteenth, so you’re good for ninety days. I’ll email it over this afternoon.',
  follow_up:
    'That’s the one thing holding us up. Once those land I’ll refresh the file. Let’s talk again next Friday.',
  blocker:
    'We’re still waiting on my CPA to send over the 2025 tax returns though, that hasn’t happened yet',
};

/** A complete, entirely valid extraction. Individual tests corrupt one field at a time. */
function goodExtraction(): SpannedExtraction {
  return {
    guardrails: {
      approved_price: { value: 400000, evidence: SPAN.approved_price },
      max_payment: { value: 3200, evidence: SPAN.max_payment },
      max_out_of_pocket: { value: 12500, evidence: SPAN.max_out_of_pocket },
      rate_range_quoted: { value: '6.5–6.875%', evidence: SPAN.rate },
      preapproval_date: { value: '2026-08-15', evidence: SPAN.preapproval },
    },
    key_facts: [
      { value: 'Preapproval letter dated Aug 15, valid 90 days; being emailed today.', evidence: SPAN.preapproval },
      { value: 'Cash to close estimated at $12,500.', evidence: SPAN.max_out_of_pocket },
    ],
    follow_up_date: { value: '2026-08-21', evidence: SPAN.follow_up },
    blocker: { value: 'Waiting on CPA for 2025 tax returns', evidence: SPAN.blocker },
  };
}

/** Word count as the validator counts it — after canonicalisation. */
function words(s: string): number {
  return canonicalizeSpan(s).split(' ').filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------

describe('canonicalisation — the mismatches that would fail every check silently', () => {
  test('curly apostrophes fold to ASCII', () => {
    assert.equal(canonicalizeSpan('you’d be looking'), canonicalizeSpan("you'd be looking"));
  });

  test('curly double quotes fold to ASCII', () => {
    assert.equal(canonicalizeSpan('he said “about that”'), canonicalizeSpan('he said "about that"'));
  });

  test('a contraction counts as one word, not two', () => {
    assert.equal(words("you'd be looking"), 3);
  });

  test('case and ragged whitespace are irrelevant', () => {
    assert.equal(canonicalizeSpan('  Thirty   Two\n  Hundred  '), 'thirty two hundred');
  });

  test('punctuation is dropped but decimals survive', () => {
    assert.equal(canonicalizeSpan('locked at 6.875%, finally.'), 'locked at 6.875 finally');
  });

  test('a quote that stops one character short of a trailing % still matches', () => {
    // Found by the false-drop probe, not by writing a test first: a transcript reading
    // "That's 6.875%." quoted as "That's 6.875" is a truncation, not a paraphrase, and was
    // being reported as a fabricated quote.
    const transcript = "The rate we are looking at today is six and seven eighths, so that is 6.875%. Locked for thirty days.";
    const r = validateExtraction(
      {
        guardrails: {
          rate_range_quoted: {
            value: '6.875%',
            evidence: 'The rate we are looking at today is six and seven eighths, so that is 6.875',
          },
        },
      },
      transcript,
    );
    assert.deepEqual(r.failures, [], summarizeFailures(r.failures));
    assert.equal(r.guardrails.rate_range_quoted, '6.875%');
  });

  test('⚠️ an ELIDED quote fails, and that is correct', () => {
    // "quote ... quote" is two quotes. Nothing here can prove the elided text says what the
    // model implies, so it must not pass. The prompt asks for one contiguous quote instead.
    const e = goodExtraction();
    e.guardrails!.approved_price = {
      value: 400000,
      evidence: 'with the updated income docs, we can get you approved ... four hundred thousand on the purchase price',
    };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  // ⚠️ CHANGED 2026-08-15 with the Spanish lexicon. This test used to assert that accents
  // survive canonicalisation verbatim. They are now FOLDED, and that serves the original
  // intent — "Spanish spans must still match" — strictly better, because folding also absorbs
  // accent DISAGREEMENT between the model's quote and the transcript. Unfolded, a model writing
  // "está" against a transcript reading "esta" failed as evidence_not_in_transcript, i.e. was
  // reported as a fabricated quote. Folding runs on both sides, so the substring guarantee holds.
  test('accents are folded, so an accent disagreement still matches', () => {
    assert.equal(canonicalizeSpan('la tasa está en seis'), canonicalizeSpan('la tasa esta en seis'));
  });

  test('folding does not mangle the Spanish words themselves', () => {
    assert.equal(canonicalizeSpan('la tasa está en seis'), 'la tasa esta en seis');
    assert.equal(canonicalizeSpan('el año que viene'), 'el ano que viene');
  });

  test('a genuine Spanish paraphrase is still rejected — folding is not fuzzy matching', () => {
    const transcript = 'vimos una casa el sabado pero esta un poco cara para nosotros';
    assert.equal(canonicalizeSpan(transcript).includes(canonicalizeSpan('vimos una casa el domingo')), false);
  });

  test('hyphenated number words match their spoken form', () => {
    assert.equal(canonicalizeSpan('thirty-two hundred'), canonicalizeSpan('thirty two hundred'));
  });
});

describe('span length — calibrated, not copied from the spec', () => {
  test("the spec's own illustrative span is 13 words and must pass", () => {
    // "so we'd be looking at about thirty two hundred a month all in" — the example printed in
    // the spec. At the literal "~15 words" it would be nulled, which
    // is why MIN_SPAN_WORDS is 12. If this test fails, the constant was raised without
    // re-reading the spec example.
    const example = "so we'd be looking at about thirty two hundred a month all in";
    assert.equal(words(example), 13);
    assert.ok(words(example) >= MIN_SPAN_WORDS);
  });

  test('every span in the reference fixture clears the bar with margin', () => {
    for (const [name, span] of Object.entries(SPAN)) {
      assert.ok(
        words(span) >= MIN_SPAN_WORDS + 2,
        `${name} is ${words(span)} words — too close to the boundary to be a useful fixture`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateExtraction — a clean, fully spanned extraction', () => {
  const r = validateExtraction(goodExtraction(), TRANSCRIPT);

  test('nothing fails', () => {
    assert.deepEqual(r.failures, [], summarizeFailures(r.failures));
  });

  test('guardrails survive as plain values, ready for write-back', () => {
    assert.equal(r.guardrails.approved_price, 400000);
    assert.equal(r.guardrails.max_payment, 3200);
    assert.equal(r.guardrails.max_out_of_pocket, 12500);
    assert.equal(r.guardrails.rate_range_quoted, '6.5–6.875%');
    assert.equal(r.guardrails.preapproval_date, '2026-08-15');
  });

  test('preapproval_date is checked at last — G0 skipped it entirely', () => {
    const bad = goodExtraction();
    bad.guardrails!.preapproval_date = { value: '2026-08-15', evidence: 'the letter is dated the fifteenth of August and runs ninety days from then' };
    const out = validateExtraction(bad, TRANSCRIPT);
    assert.equal(out.guardrails.preapproval_date, null);
    assert.equal(out.failures[0].field, 'preapproval_date');
    assert.equal(out.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('text fields and key_facts survive', () => {
    assert.equal(r.follow_up_date, '2026-08-21');
    assert.equal(r.blocker, 'Waiting on CPA for 2025 tax returns');
    assert.equal(r.key_facts.length, 2);
  });

  test('surviving spans are returned for the run record', () => {
    assert.equal(r.evidence.max_payment, SPAN.max_payment);
    assert.equal(r.evidence['key_facts[0]'], SPAN.preapproval);
    assert.ok(!('crm_note' in r.evidence), 'only span-carrying fields appear');
  });

  test('the rate span carries BOTH bounds — the fraction-closes-phrase fix works inside a span', () => {
    // "between six and a half and six and seven eighths" must yield 6.5 AND 6.875 when the
    // haystack is the span rather than the whole transcript. This was G0's second shipped bug;
    // span-scoping re-runs the same parser on a much shorter string, so it can resurface.
    assert.equal(r.guardrails.rate_range_quoted, '6.5–6.875%');
  });
});

// ---------------------------------------------------------------------------
// The failures G1 exists to catch
// ---------------------------------------------------------------------------

describe('a quote that is not in the transcript', () => {
  test('a wholly invented span nulls the field', () => {
    const e = goodExtraction();
    e.guardrails!.max_payment = {
      value: 3200,
      evidence: 'and we agreed your absolute ceiling on the monthly payment would be thirty two hundred',
    };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('🚩 a PARAPHRASE is caught — the most likely real failure', () => {
    // Every word here is plausible and the number is genuinely in the transcript, so G0 passes
    // it. The model just did not quote. This single case is why the substring check is
    // mandatory rather than garnish.
    const e = goodExtraction();
    e.guardrails!.max_payment = {
      value: 3200,
      evidence: 'at that price you would be looking at approximately thirty two hundred per month all included',
    };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('a span stitched from two separate sentences does not pass', () => {
    const e = goodExtraction();
    e.guardrails!.max_out_of_pocket = {
      value: 12500,
      evidence: 'You’d want to plan on roughly twelve thousand five hundred out of pocket at closing and the rate is six and a half',
    };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_out_of_pocket, null);
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
  });

  test('word boundaries are respected — "in rent" must not match "in rental"', () => {
    const transcript = 'we have twelve more months to run in rental payments before the lease is up';
    const e: SpannedExtraction = {
      blocker: { value: 'still renting', evidence: 'we have twelve more months to run in rent' },
    };
    const r = validateExtraction(e, transcript);
    // The boundary check must REJECT the quote — "in rent" is not a word-boundary match for "in rental".
    assert.equal(r.failures[0].reason, 'evidence_not_in_transcript');
    // A blocker is KEPT-and-flagged on a quote miss, not dropped: the blocker is
    // synthesised/paraphrased and the same text already flows through the evidence-exempt crm_note, so
    // a silent drop would empty the Blocker field on a stuck file. The flag routes it to Needs review.
    assert.equal(r.blocker, 'still renting');
    assert.equal(r.groundingNeedsReview, true);
  });
});

describe('spans too short to review', () => {
  test('a fragment is rejected even though it is genuinely present', () => {
    const e = goodExtraction();
    e.guardrails!.max_payment = { value: 3200, evidence: 'about thirty two hundred a month' };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'evidence_too_short');
  });

  test('a short AND absent span reports too_short — the actionable prompt fix', () => {
    const e = goodExtraction();
    e.guardrails!.approved_price = { value: 400000, evidence: 'approved to four hundred k' };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.failures[0].reason, 'evidence_too_short');
  });
});

describe('the span-scoped numeric check is tighter than G0', () => {
  test('a real quote that does not contain the number is rejected', () => {
    // 3200 IS in the transcript, so G0 passes this. The quote is real, so the substring check
    // passes too. Only running the numeric check INSIDE the span catches it — which is the
    // upgrade G1 buys on numeric fields.
    const e = goodExtraction();
    e.guardrails!.max_payment = { value: 3200, evidence: SPAN.approved_price };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'not_grounded_in_transcript');
    assert.ok(r.transcriptNumbers.includes(3200), 'the number is in the transcript — G0 would have passed it');
  });

  test('a rate bound outside the quoted span drops the whole range', () => {
    const e = goodExtraction();
    e.guardrails!.rate_range_quoted = { value: '6.5–7.25%', evidence: SPAN.rate };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.rate_range_quoted, null);
    assert.equal(r.failures[0].bound, 7.25);
  });

  test('an implausible value is rejected before its span is even examined', () => {
    const e = goodExtraction();
    e.guardrails!.max_payment = { value: 3_200_000, evidence: SPAN.max_payment };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'implausible_for_field');
  });
});

describe('null, missing and bare shapes', () => {
  test('null value with null evidence is "not discussed", not a failure', () => {
    const r = validateExtraction(
      { guardrails: { approved_price: { value: null, evidence: null }, max_payment: { value: 3200, evidence: SPAN.max_payment } } },
      TRANSCRIPT,
    );
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.guardrails.max_payment, 3200);
  });

  test('a value with no evidence is nulled — a span-carrying field must carry its span', () => {
    const e = goodExtraction();
    e.guardrails!.max_payment = { value: 3200, evidence: null };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'evidence_missing');
  });

  test('whitespace-only evidence counts as missing, not as a short span', () => {
    const e = goodExtraction();
    e.guardrails!.max_payment = { value: 3200, evidence: '   \n  ' };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.failures[0].reason, 'evidence_missing');
  });

  test('a BARE value falls back to the G0 whole-transcript check', () => {
    // The upgrade path: a prompt that spans some fields and not others still gets both checked.
    const r = validateExtraction(
      { guardrails: { max_payment: 3200, approved_price: 525000 } },
      TRANSCRIPT,
    );
    assert.equal(r.guardrails.max_payment, 3200, 'said on the call, no span needed');
    assert.equal(r.guardrails.approved_price, null, 'fabricated — G0 still catches it');
    assert.equal(r.failures[0].reason, 'not_grounded_in_transcript');
  });

  test('absent fields are not invented in the output', () => {
    const r = validateExtraction({ guardrails: { max_payment: { value: 3200, evidence: SPAN.max_payment } } }, TRANSCRIPT);
    assert.ok(!('approved_price' in r.guardrails));
    assert.ok(!('preapproval_date' in r.guardrails));
    assert.deepEqual(r.key_facts, []);
    assert.equal(r.blocker, null);
  });

  test('an empty extraction object is valid and produces nothing', () => {
    const r = validateExtraction({}, TRANSCRIPT);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.key_facts, []);
    assert.deepEqual(r.evidence, {});
  });
});

describe('key_facts — each fact stands or falls alone', () => {
  test('one fabricated fact is dropped, the rest survive', () => {
    const e = goodExtraction();
    e.key_facts = [
      { value: 'Preapproval letter emailed today, good for 90 days.', evidence: SPAN.preapproval },
      { value: 'Client agreed to put down twenty percent at closing next month.', evidence: 'she confirmed she would be putting a full twenty percent down at the closing table' },
      { value: 'Cash to close estimated at $12,500.', evidence: SPAN.max_out_of_pocket },
    ];
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.key_facts.length, 2);
    assert.ok(!r.key_facts.some((f) => f.includes('twenty percent')));
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].field, 'key_facts');
    assert.equal(r.failures[0].index, 1, 'the run record must name WHICH fact failed');
  });

  test('bare string facts pass through unchecked', () => {
    const r = validateExtraction({ key_facts: ['Realtor is Dana at Coastal.'] }, TRANSCRIPT);
    assert.deepEqual(r.key_facts, ['Realtor is Dana at Coastal.']);
    assert.deepEqual(r.failures, []);
  });
});

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

describe('run record summary', () => {
  test('the failing field, index and reason all appear', () => {
    const e = goodExtraction();
    e.key_facts = [{ value: 'Invented fact.', evidence: 'a sentence that was never spoken on this call by anyone at all' }];
    e.guardrails!.max_payment = { value: 3200, evidence: null };
    const s = summarizeFailures(validateExtraction(e, TRANSCRIPT).failures);
    assert.match(s, /max_payment=3200 \(evidence_missing\)/);
    assert.match(s, /key_facts\[0\]=Invented fact\. \(evidence_not_in_transcript\)/);
  });

  test('a long blocker is truncated so it cannot swamp the field', () => {
    const long = 'x'.repeat(200);
    const r = validateExtraction({ blocker: { value: long, evidence: 'not in the transcript anywhere at all, not even close to it' } }, TRANSCRIPT);
    const s = summarizeFailures(r.failures);
    assert.ok(s.length < 100, `summary was ${s.length} chars`);
    assert.match(s, /\.\.\. \(evidence_not_in_transcript\)/);
  });
});

// ---------------------------------------------------------------------------
// Adversarial fixtures — spec § Acceptance gate
// ---------------------------------------------------------------------------

describe('adversarial fixtures (spec F-1 … F-4)', () => {
  test('F-1: a call with no figures — every invented span is caught', () => {
    const transcript = `
      Hey, just checking in. We're still waiting on your CPA for the tax returns.
      Once those come through I'll run the numbers and we can talk properly.
      Give me a shout if anything changes on the house you were looking at.
    `;
    const r = validateExtraction(
      {
        guardrails: {
          approved_price: { value: 450000, evidence: 'we can get you approved up to four hundred and fifty thousand on this one' },
          max_payment: { value: 2800, evidence: 'your payment would come in right around twenty eight hundred a month all in' },
          max_out_of_pocket: { value: 15000, evidence: 'you would need about fifteen thousand dollars at the closing table for this' },
          rate_range_quoted: { value: '6.5–6.875%', evidence: 'rates today are between six and a half and six and seven eighths on that program' },
        },
      },
      transcript,
    );
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.guardrails.max_out_of_pocket, null);
    assert.equal(r.guardrails.rate_range_quoted, null);
    assert.equal(r.failures.length, 4, 'all four must be reported, not just the first');
    assert.ok(r.failures.every((f) => f.reason === 'evidence_not_in_transcript'));
  });

  test('F-2: two competing figures — the span decides which one is meant', () => {
    // This is where G1 genuinely beats G0. BOTH numbers were said, so G0 passes either. The
    // span pins the extraction to the sentence that carries the current approval.
    const transcript = `
      Back in March we had you approved at three fifty, but with the new income
      documentation we can now go all the way up to four hundred thousand on the price.
    `;
    const current = validateExtraction(
      { guardrails: { approved_price: { value: 400000, evidence: 'with the new income documentation we can now go all the way up to four hundred thousand on the price' } } },
      transcript,
    );
    assert.deepEqual(current.failures, []);
    assert.equal(current.guardrails.approved_price, 400000);

    const stale = validateExtraction(
      { guardrails: { approved_price: { value: 350000, evidence: 'with the new income documentation we can now go all the way up to four hundred thousand on the price' } } },
      transcript,
    );
    assert.equal(stale.guardrails.approved_price, null, 'the stale figure is not in the quoted sentence');
    assert.equal(stale.failures[0].reason, 'not_grounded_in_transcript');
  });

  test('F-3: code-switched call — a Spanish span still validates', () => {
    const transcript = `
      Perfecto, entonces el pago sería como thirty two hundred al mes con todo incluido,
      y la tasa está en six and a half por ciento ahorita.
    `;
    const r = validateExtraction(
      {
        guardrails: {
          max_payment: { value: 3200, evidence: 'entonces el pago sería como thirty two hundred al mes con todo incluido' },
          rate_range_quoted: { value: '6.5%', evidence: 'y la tasa está en six and a half por ciento ahorita' },
        },
      },
      transcript,
    );
    assert.deepEqual(r.failures, [], summarizeFailures(r.failures));
    assert.equal(r.guardrails.max_payment, 3200);
  });

  test('🚩 F-4: KNOWN LIMIT — misattribution passes G1 too, on purpose', () => {
    // The figure is the client's CURRENT RENT. The quote is genuine, long enough, and contains
    // the number, so every G1 check passes and the value is still wrong. G1 buys reviewability,
    // not correctness. If this test ever fails, G1 gained a capability it was not designed to
    // have and the spec's claim ("catches fabrication, not misattribution") needs revisiting —
    // as does what we tell the team it does.
    const transcript = `So right now we're paying about thirty two hundred a month in rent on our current place.`;
    const r = validateExtraction(
      {
        guardrails: {
          max_payment: { value: 3200, evidence: "So right now we're paying about thirty two hundred a month in rent on our current place." },
        },
      },
      transcript,
    );
    assert.deepEqual(r.failures, [], 'G1 cannot see role — this is fixture and prompt work');
    assert.equal(r.guardrails.max_payment, 3200);
    assert.ok(r.evidence.max_payment, 'the quote reaches the run record, which is the actual mitigation');
  });
});

// ---------------------------------------------------------------------------
// Smoke test
//
// G0's worst bug passed every unit test and was only caught by running a realistic transcript
// end to end (sentence-final figures lost their last word). Trap #1 in the G1 brief says to
// expect an analogue, so this runs the whole reference call through in one go.
// ---------------------------------------------------------------------------

describe('smoke test — the full reference call, end to end', () => {
  test('a realistic extraction over a realistic transcript passes cleanly', () => {
    const r = validateExtraction(goodExtraction(), TRANSCRIPT);
    assert.equal(summarizeFailures(r.failures), '', 'no field may drop on a clean call');
    // 5 guardrails + 2 key_facts + follow_up_date + blocker.
    assert.equal(Object.keys(r.evidence).length, 9, 'every span-carrying field reports its quote');
  });

  test('every span in the fixture is verbatim — the fixture itself is honest', () => {
    // Guards against the fixture drifting from the transcript and quietly making the suite
    // test nothing. If a span is edited, this fails before the assertions above do.
    const canonical = canonicalizeSpan(TRANSCRIPT);
    for (const [name, span] of Object.entries(SPAN)) {
      assert.ok(
        (' ' + canonical + ' ').includes(' ' + canonicalizeSpan(span) + ' '),
        `${name} is no longer a verbatim quote from TRANSCRIPT`,
      );
    }
  });

  test('one corrupted field drops alone — the rest of the call still writes', () => {
    const e = goodExtraction();
    e.guardrails!.approved_price = { value: 525000, evidence: SPAN.approved_price };
    const r = validateExtraction(e, TRANSCRIPT);
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.guardrails.max_payment, 3200);
    assert.equal(r.guardrails.max_out_of_pocket, 12500);
    assert.equal(r.guardrails.rate_range_quoted, '6.5–6.875%');
    assert.equal(r.key_facts.length, 2);
    assert.equal(r.blocker, 'Waiting on CPA for 2025 tax returns');
    assert.equal(r.failures.length, 1);
  });
});

// ---------------------------------------------------------------------------
// next_action and blocker are KEPT (and the file flagged) on a quote miss,
// never silently dropped. Numbers, dates and key_facts keep strict-drop. See validate.ts.
// ---------------------------------------------------------------------------

describe('next_action / blocker survive a quote miss (kept + flagged)', () => {
  // A real, contiguous ≥8-word span lifted verbatim from TRANSCRIPT (a Maria line).
  const GOOD_BLOCKER_QUOTE = 'still waiting on my CPA to send over the 2025 tax returns';

  test('a blocker with a real contiguous quote is written and does NOT flag review', () => {
    const r = validateExtraction(
      { blocker: { value: 'CPA has not sent 2025 tax returns', evidence: GOOD_BLOCKER_QUOTE } },
      TRANSCRIPT,
    );
    assert.equal(r.blocker, 'CPA has not sent 2025 tax returns');
    assert.equal(r.groundingNeedsReview, false);
    assert.equal(r.failures.length, 0);
  });

  test('a paraphrased blocker (quote not in transcript) is KEPT, logged, and flags review', () => {
    const r = validateExtraction(
      {
        blocker: {
          value: 'waiting on the CPA for tax returns',
          evidence: 'the client is still waiting for their accountant to deliver last year tax paperwork',
        },
      },
      TRANSCRIPT,
    );
    assert.equal(r.blocker, 'waiting on the CPA for tax returns'); // not dropped
    assert.equal(r.groundingNeedsReview, true);
    assert.ok(r.failures.some((f) => f.field === 'blocker' && f.reason === 'evidence_not_in_transcript'));
  });

  test('a too-short blocker quote is also KEPT and flags review', () => {
    const r = validateExtraction(
      { blocker: { value: 'waiting on CPA', evidence: 'waiting on the CPA' } },
      TRANSCRIPT,
    );
    assert.equal(r.blocker, 'waiting on CPA');
    assert.equal(r.groundingNeedsReview, true);
    assert.ok(r.failures.some((f) => f.field === 'blocker' && f.reason === 'evidence_too_short'));
  });

  test('no blocker present → no grounding review flag', () => {
    const r = validateExtraction({ key_facts: [] }, TRANSCRIPT);
    assert.equal(r.groundingNeedsReview, false);
  });

  test('REGRESSION: a number with a bad quote STILL drops and does NOT grounding-flag (strict stays strict)', () => {
    const r = validateExtraction(
      {
        guardrails: {
          max_payment: {
            value: 3200,
            evidence: 'we agreed your ceiling is thirty two hundred a month somewhere off the transcript',
          },
        },
      },
      TRANSCRIPT,
    );
    assert.equal(r.guardrails.max_payment, null); // dropped, unchanged
    assert.equal(r.groundingNeedsReview, false);   // numbers never use the keep-and-flag path
  });

  test('REGRESSION: a key_fact with a bad quote STILL drops individually and does NOT grounding-flag', () => {
    const r = validateExtraction(
      {
        key_facts: [
          { value: 'invented fact', evidence: 'this sentence is nowhere in the reference transcript at all today' },
        ],
      },
      TRANSCRIPT,
    );
    assert.deepEqual(r.key_facts, []); // dropped, unchanged
    assert.equal(r.groundingNeedsReview, false);
  });
});
