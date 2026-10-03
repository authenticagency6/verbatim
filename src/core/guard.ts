import { SSN_SHAPE, LONG_DIGIT_RUN } from './redact.ts';

export class UnredactedTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnredactedTranscriptError';
  }
}

/**
 * Fail loudly if the transcript still carries an SSN.
 *
 * 🚩 **This does not prevent a disclosure — by step 5b the text has already gone to the model.**
 * It exists to make a wiring mistake impossible to ship: if step 4b is skipped, reordered, or
 * wired to the wrong variable, the very first call throws instead of processing thousands
 * silently. The error workflow already alerts on any node failure, so this lands where a human
 * sees it, which is the spec's "no silent drops" rule.
 *
 * ⚠️ **Only the SSN shape is fatal, deliberately.** A blunt "9 or more digits" rule would throw on
 * a spoken phone number and stop call processing altogether — a worse outcome than the thing it
 * guards. Account numbers are flagged into the run record instead, because their shapes overlap
 * ordinary figures too much to be worth a hard stop.
 */
export function assertRedacted(transcript: string): string[] {
  const warnings: string[] = [];
  const t = transcript || '';

  // 123-45-6789 / 123 45 6789 — high-signal, effectively never a mortgage figure.
  // The shape is defined ONCE, in redact.ts — the module whose job is to remove it. If the
  // definitions diverged, redaction could pass its own postcondition and still throw here.
  if (new RegExp(SSN_SHAPE.source).test(t)) {
    throw new UnredactedTranscriptError(
      'Transcript still contains an SSN-shaped number. Step 4b (redaction) did not run, or the ' +
        'raw transcript was passed to step 5b instead of the redacted one. Fix the wiring — ' +
        'validating against unredacted text lets an SSN fragment ground a fabricated figure ' +
        '(fixture R-07).',
    );
  }

  // Long digit runs are suspicious but ambiguous. Record, do not stop.
  if (new RegExp(LONG_DIGIT_RUN.source).test(t)) {
    warnings.push('long_digit_run_present');
  }
  return warnings;
}
