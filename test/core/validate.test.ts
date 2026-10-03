/**
 * validate.test.ts — G0 grounding checks.
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * The suite is organised around the two things that decide whether G0 is usable in production:
 *   1. Does it recognise figures the way a mortgage call actually says them? (recall — false
 *      drops here silently delete the guardrail feature)
 *   2. Does it still catch a fabricated number? (the entire point)
 *
 * F-1 through F-4 mirror the adversarial fixtures named in the build spec's acceptance gate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGuardrails,
  normalizeTranscript,
  extractNumbers,
  extractDigitNumbers,
  extractSpokenNumbers,
  parseRateBounds,
  summarizeFailures,
} from '../../src/core/validate.ts';

/** Convenience: does the transcript yield this number under any reading? */
function has(transcript: string, n: number): boolean {
  return extractNumbers(normalizeTranscript(transcript)).some((x) => Math.abs(x - n) < 1e-6);
}

// ---------------------------------------------------------------------------

describe('normalisation', () => {
  test('strips thousands separators inside numbers only', () => {
    assert.equal(normalizeTranscript('about $3,200 a month'), 'about 3200 a month');
  });

  test('leaves sentence commas alone', () => {
    assert.equal(normalizeTranscript('Well, sure, yes'), 'well, sure, yes');
  });

  test('splits hyphenated number words', () => {
    assert.equal(normalizeTranscript('thirty-two hundred'), 'thirty two hundred');
  });
});

describe('digit extraction', () => {
  test('plain and decimal', () => {
    const n = extractDigitNumbers(normalizeTranscript('3200 at 6.5 percent'));
    assert.ok(n.includes(3200));
    assert.ok(n.includes(6.5));
  });

  test('k and m suffixes', () => {
    const n = extractDigitNumbers(normalizeTranscript('approved to 400k, maybe 1.2m later'));
    assert.ok(n.includes(400000));
    assert.ok(n.includes(1_200_000));
  });

  test('currency and separators', () => {
    assert.ok(has('cash to close is $12,500', 12500));
  });
});

describe('spoken numerals — the reason this module exists', () => {
  test('"thirty two hundred" -> 3200', () => {
    assert.ok(has('looking at about thirty two hundred a month', 3200));
  });

  test('"three thousand two hundred" -> 3200', () => {
    assert.ok(has('three thousand two hundred all in', 3200));
  });

  test('"twenty five hundred" -> 2500', () => {
    assert.ok(has('call it twenty five hundred', 2500));
  });

  test('"four hundred thousand" -> 400000', () => {
    assert.ok(has('approved up to four hundred thousand', 400000));
  });

  test('"four hundred k" -> 400000', () => {
    assert.ok(has('somewhere around four hundred k', 400000));
  });

  test('"six point five" -> 6.5', () => {
    assert.ok(has('rate is six point five', 6.5));
  });

  test('"six point eight seven five" -> 6.875', () => {
    assert.ok(has('locked at six point eight seven five', 6.875));
  });

  test('teens parse', () => {
    assert.ok(has('closing in fifteen days', 15));
  });

  test('does not swallow prose after a number', () => {
    // "and then" must not extend the run; 6 should survive as 6, not absorb later words.
    const n = extractSpokenNumbers(normalizeTranscript('six and then we talked about the house'));
    assert.ok(n.includes(6));
  });
});

describe('mortgage rate fractions — rates are quoted in eighths', () => {
  test('"six and a half" -> 6.5', () => {
    assert.ok(has('right around six and a half', 6.5));
  });

  test('"six and a quarter" -> 6.25', () => {
    assert.ok(has('six and a quarter today', 6.25));
  });

  test('"six and three quarters" -> 6.75', () => {
    assert.ok(has('six and three quarters', 6.75));
  });

  test('"six and seven eighths" -> 6.875', () => {
    assert.ok(has('six and seven eighths on that program', 6.875));
  });

  test('"six and five eighths" -> 6.625', () => {
    assert.ok(has('six and five eighths', 6.625));
  });
});

describe('colloquial runs emit every genuine reading', () => {
  test('"six seventy five" yields the rate reading 6.75', () => {
    assert.ok(has('we could get you six seventy five', 6.75));
  });

  test('"six seventy five" also yields 675', () => {
    assert.ok(has('we could get you six seventy five', 675));
  });

  test('"four twenty five" yields 425 (price shorthand)', () => {
    assert.ok(has('approved at four twenty five', 425));
  });

  test('"four twenty five" yields 4.25 (rate reading)', () => {
    assert.ok(has('four twenty five', 4.25));
  });
});

describe('regressions — both of these shipped broken and were caught by this suite', () => {
  test('a fraction closes the phrase, so BOTH rates in a range are found', () => {
    // Original bug: "six and a half and six and seven eighths" collected as ONE run. The parser
    // returned 6.5 at the first fraction and the scanner skipped the rest, so 6.875 was never
    // emitted — nulling a correctly-extracted upper bound. Rate ranges are stated this way on
    // nearly every call, so this single case decided whether G0 was usable at all.
    const t = 'somewhere between six and a half and six and seven eighths depending on the lock';
    assert.ok(has(t, 6.5), 'lower bound');
    assert.ok(has(t, 6.875), 'upper bound');
  });

  test('three fractions in one breath all survive', () => {
    const t = 'could be six and a quarter, six and a half, or six and three quarters';
    assert.ok(has(t, 6.25));
    assert.ok(has(t, 6.5));
    assert.ok(has(t, 6.75));
  });

  test('spoken k suffix scales the whole phrase', () => {
    // Original bug: "k" was only handled by the digit regex, so worded amounts with a spoken
    // suffix ("four hundred k") grounded as 400 and failed the 400000 check.
    assert.ok(has('somewhere around four hundred k', 400000));
    assert.ok(has('call it four fifty k', 450000));
  });

  test('a stray "k" in prose does not invent a number', () => {
    const n = extractSpokenNumbers(normalizeTranscript('k so anyway lets move on'));
    assert.deepEqual(n, []);
  });

  test('sentence-final figures keep their last word', () => {
    // Original bug: '.' is kept inside tokens so decimals survive, which glued sentence
    // punctuation onto the final word — "hundred." stopped being a scale word and
    // "thirty two hundred." parsed as 32. Numbers end sentences constantly on a real call,
    // so this was a high-rate false-drop hiding behind tests that all had trailing words.
    assert.ok(has('your payment is thirty two hundred.', 3200));
    assert.ok(has('rate is six and a half.', 6.5));
    assert.ok(has('approved to four hundred k.', 400000));
    assert.ok(has('the rate is 6.5%.', 6.5), 'percent sign must not break the decimal');
  });

  test('decimals still survive tokenisation', () => {
    assert.ok(has('locked at 6.875 percent', 6.875));
  });
});

describe('rate bound parsing', () => {
  test('range with en dash', () => {
    assert.deepEqual(parseRateBounds('6.5–6.875%'), [6.5, 6.875]);
  });

  test('single value with prose', () => {
    assert.deepEqual(parseRateBounds('around 6.5%'), [6.5]);
  });

  test('empty string', () => {
    assert.deepEqual(parseRateBounds(''), []);
  });
});

// ---------------------------------------------------------------------------
// End-to-end validation
// ---------------------------------------------------------------------------

describe('validateGuardrails — grounded values survive', () => {
  const transcript = `
    So based on what you've given me, we can get you approved up to four hundred thousand.
    Your payment would be right around thirty two hundred a month all in, and you'd need
    about twelve thousand five hundred out of pocket at closing. Rate today is somewhere
    between six and a half and six and seven eighths depending on the lock.
  `;

  test('all four guardrails pass and are unchanged', () => {
    const r = validateGuardrails(
      {
        approved_price: 400000,
        max_payment: 3200,
        max_out_of_pocket: 12500,
        rate_range_quoted: '6.5–6.875%',
      },
      transcript,
    );
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.approved_price, 400000);
    assert.equal(r.guardrails.max_payment, 3200);
    assert.equal(r.guardrails.max_out_of_pocket, 12500);
    assert.equal(r.guardrails.rate_range_quoted, '6.5–6.875%');
  });

  test('summary is empty on a clean run', () => {
    const r = validateGuardrails({ max_payment: 3200 }, transcript);
    assert.equal(summarizeFailures(r.failures), '');
  });
});

describe('validateGuardrails — fabrication is caught', () => {
  const transcript = `
    We talked through the program and the timeline. You'd be looking at roughly
    thirty two hundred a month. I'll get you the full breakdown tomorrow.
  `;

  test('an invented approved_price is nulled and logged', () => {
    const r = validateGuardrails({ approved_price: 525000, max_payment: 3200 }, transcript);
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.guardrails.max_payment, 3200, 'the grounded field must survive');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].field, 'approved_price');
    assert.equal(r.failures[0].reason, 'not_grounded_in_transcript');
  });

  test('failure summary names the field for the run record', () => {
    const r = validateGuardrails({ approved_price: 525000 }, transcript);
    assert.match(summarizeFailures(r.failures), /approved_price=525000 \(not_grounded_in_transcript\)/);
  });

  test('an out-of-band value is rejected as implausible', () => {
    const r = validateGuardrails({ max_payment: 3_200_000 }, transcript);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.failures[0].reason, 'implausible_for_field');
  });
});

describe('rate ranges fail closed', () => {
  const transcript = 'rate is six and a half today, could move a bit';

  test('one ungrounded bound drops the whole field', () => {
    const r = validateGuardrails({ rate_range_quoted: '6.5–7.25%' }, transcript);
    assert.equal(r.guardrails.rate_range_quoted, null);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].bound, 7.25);
  });

  test('a fully grounded single rate survives', () => {
    const r = validateGuardrails({ rate_range_quoted: '6.5%' }, transcript);
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.rate_range_quoted, '6.5%');
  });
});

describe('nulls and absent fields', () => {
  test('nulls pass through untouched and raise no failure', () => {
    const r = validateGuardrails(
      { approved_price: null, max_payment: null, max_out_of_pocket: null, rate_range_quoted: null },
      'no numbers here at all',
    );
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.approved_price, null);
  });

  test('preapproval_date is not a G0 concern and is passed through', () => {
    const r = validateGuardrails({ preapproval_date: '2026-08-15' }, 'nothing numeric');
    assert.deepEqual(r.failures, []);
    assert.equal(r.guardrails.preapproval_date, '2026-08-15');
  });

  test('empty rate string is ignored, not failed', () => {
    const r = validateGuardrails({ rate_range_quoted: '' }, 'nothing');
    assert.deepEqual(r.failures, []);
  });
});

// ---------------------------------------------------------------------------
// Adversarial fixtures — spec § Acceptance gate
// ---------------------------------------------------------------------------

describe('adversarial fixtures (spec F-1 … F-4)', () => {
  test('F-1: a call with no figures at all — every invented guardrail is dropped', () => {
    const transcript = `
      Hey, just checking in. We're still waiting on your CPA for the tax returns.
      Once those come through I'll run the numbers and we can talk properly.
      Give me a shout if anything changes on the house you were looking at.
    `;
    const r = validateGuardrails(
      {
        approved_price: 450000,
        max_payment: 2800,
        max_out_of_pocket: 15000,
        rate_range_quoted: '6.5–6.875%',
      },
      transcript,
    );
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.guardrails.max_payment, null);
    assert.equal(r.guardrails.max_out_of_pocket, null);
    assert.equal(r.guardrails.rate_range_quoted, null);
    assert.equal(r.failures.length, 4, 'all four must be reported, not just the first');
  });

  test('F-2: two competing figures — the one actually said survives, the other does not', () => {
    const transcript = `
      Back in March we had you approved at three fifty, but with the new income
      documentation we can now go up to four hundred thousand.
    `;
    const ok = validateGuardrails({ approved_price: 400000 }, transcript);
    assert.deepEqual(ok.failures, []);

    const stale = validateGuardrails({ approved_price: 375000 }, transcript);
    assert.equal(stale.guardrails.approved_price, null, 'a figure said by neither party must drop');
  });

  test('F-3: code-switched call — figures still ground off the digits present', () => {
    const transcript = `
      Perfecto, entonces el pago seria como thirty two hundred al mes,
      y la tasa esta en six and a half por ciento.
    `;
    const r = validateGuardrails({ max_payment: 3200, rate_range_quoted: '6.5%' }, transcript);
    assert.deepEqual(r.failures, []);
  });

  test('F-4: KNOWN LIMIT — misattribution is NOT caught by G0', () => {
    // The figure is the client's current rent, not an approved payment. G0 passes it because
    // the number WAS said. This test documents the gap deliberately: if it ever starts
    // failing, G0 gained a capability it was never designed to have and the claim in the
    // spec ("catches fabrication, not misattribution") needs revisiting.
    const transcript = `We're paying about thirty two hundred a month right now in rent.`;
    const r = validateGuardrails({ max_payment: 3200 }, transcript);
    assert.deepEqual(r.failures, [], 'G0 cannot see role — this is G1 and fixture work');
    assert.equal(r.guardrails.max_payment, 3200);
  });
});

describe('diagnostics', () => {
  test('transcriptNumbers is sorted and de-duplicated', () => {
    const r = validateGuardrails({}, 'thirty two hundred and 3200 and six point five');
    const n = r.transcriptNumbers;
    assert.deepEqual(n, [...new Set(n)].sort((a, b) => a - b));
    assert.ok(n.includes(3200));
    assert.ok(n.includes(6.5));
  });
});

// ---------------------------------------------------------------------------
// Spanish lexicon.
//
// The lexicons are bilingual by design rather than language-switched: many callers are
// Spanish-speaking and the calls code-switch mid-sentence, so a `language === 'es'`
// branch would have failed on the common case. These tests exist because the gap they close was
// a SILENT one — before the lexicon, every numeric guardrail on a Spanish call was dropped as
// ungrounded, which reads as "the feature just doesn't work" rather than as an error.
// ---------------------------------------------------------------------------

describe('spanish — spoken numerals', () => {
  test('hundreds are single words and add rather than multiply', () => {
    assert.ok(has('lo aprobamos hasta trescientos veinte mil para la compra', 320000));
    assert.ok(has('cuatrocientos cincuenta mil', 450000));
    assert.ok(has('cien mil de enganche', 100000));
    assert.ok(has('ciento veinte mil', 120000));
  });

  test('mil and millon scale correctly, including with nothing in front', () => {
    assert.ok(has('el pago queda en dos mil cuatrocientos al mes', 2400));
    assert.ok(has('mil quinientos al mes', 1500));
    assert.ok(has('un millon doscientos mil', 1_200_000), 'a bare scale word reads as one');
  });

  test('rates in fractions and decimals', () => {
    assert.ok(has('la tasa quedo en seis y medio', 6.5));
    assert.ok(has('seis y tres cuartos', 6.75));
    assert.ok(has('seis punto siete cinco', 6.75));
    assert.ok(has('seis punto setenta y cinco', 6.75), 'tens+unit is one decimal group');
  });

  test('contracted twenties', () => {
    assert.ok(has('veinticinco mil de enganche', 25000));
    assert.ok(has('veintiocho mil', 28000));
  });

  test('accents are optional on both sides', () => {
    assert.ok(has('un millón doscientos mil', 1_200_000));
    assert.ok(has('dieciséis mil', 16000));
    assert.ok(has('dieciseis mil', 16000));
  });

  test('a figure never said is still not grounded', () => {
    const t = 'lo aprobamos hasta trescientos veinte mil para la compra';
    const r = validateGuardrails({ approved_price: 450000 }, t);
    assert.equal(r.guardrails.approved_price, null);
    assert.equal(r.failures[0].reason, 'not_grounded_in_transcript');
  });
});

describe('spanish — code-switching in one sentence', () => {
  test('an English figure inside a Spanish sentence grounds', () => {
    assert.ok(has('el pago mensual seria about thirty two hundred a month', 3200));
  });

  test('a Spanish figure inside an English sentence grounds', () => {
    assert.ok(has('we can approve you up to trescientos veinte mil', 320000));
  });

  test('both languages ground from the same transcript', () => {
    const t = 'approved up to four hundred thousand, y el pago es dos mil cuatrocientos al mes';
    assert.ok(has(t, 400000));
    assert.ok(has(t, 2400));
  });
});

describe('spanish — words that are also ordinary English words', () => {
  test('"once" in English prose does not emit eleven', () => {
    // This exact phrasing is in fixture R-01. Eleven sits inside the rate plausibility band,
    // so admitting it would let a fabricated rate ground itself against prose.
    assert.equal(has('call you Friday once you have had a chance to talk it over', 11), false);
  });

  test('"once" next to a number word does emit eleven', () => {
    assert.ok(has('el pago es de once mil dolares', 11000));
  });

  test('"media" in English prose does not emit a half', () => {
    assert.equal(has('we found them through social media last year', 0.5), false);
  });

  test('"media" in a Spanish number phrase does', () => {
    assert.ok(has('la tasa quedo en seis y media', 6.5));
  });

  test('the indefinite article is deliberately not a numeral', () => {
    // "un poco cara" would otherwise emit a 1 on half the sentences of a Spanish call.
    assert.equal(has('esta un poco cara para nosotros', 1), false);
  });
});

describe('sentence boundaries terminate a run', () => {
  test('two figures in adjacent sentences both survive', () => {
    // Before the fix this collected as ONE run and parsed to 6.7512 — a garbage figure, with
    // both real ones dropped. English bug, found while adding the Spanish lexicon.
    const t = 'the rate is six point seven five. Twelve thousand five hundred to close';
    assert.ok(has(t, 6.75));
    assert.ok(has(t, 12500));
    assert.equal(has(t, 6.7512), false, 'the merged garbage reading must be gone');
  });

  test('the same shape in Spanish', () => {
    const t = 'la tasa es seis y tres cuartos. Cien mil de enganche';
    assert.ok(has(t, 6.75));
    assert.ok(has(t, 100000));
  });

  test('a decimal inside a sentence is untouched', () => {
    assert.ok(has('the rate is 6.875 today', 6.875));
    assert.ok(has('six point eight seven five percent works', 6.875));
  });

  test('a sentence-final decimal still parses', () => {
    assert.ok(has('the rate is 6.5. Next question', 6.5));
  });
});
