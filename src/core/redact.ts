/**
 * redact.ts — redaction (step 4b). Strips NPI from the transcript BEFORE it leaves the workflow for
 * the Anthropic API.
 *
 * Acceptance case: regression fixture R-07's
 * `redaction_targets` — a digit SSN, a SPOKEN date of birth, a street address, and an account
 * fragment, all of which must be gone from the text this module returns.
 *
 * 🚩 THIS IS THE CONTROL, NOT THE PROMPT RULE. The prompt's "never output SSNs" line is
 * defense-in-depth; this module is the difference between "we instructed the model not to
 * repeat it" and "it was never sent." The guard in guard.ts (`assertRedacted`) enforces
 * that this ran — it throws on an SSN shape at step 5b, so skipping 4b fails the first call
 * loudly instead of processing thousands silently.
 *
 * DESIGN RULES, each load-bearing:
 *
 *  1. **Placeholders, not deletion.** "It's [SSN]." reads as a sentence, so the model still
 *     understands the turn; and no placeholder contains a digit, so redaction can never GROUND a
 *     number — the exact failure R-07 asserts (an SSN fragment grounding a fabricated
 *     max_payment of 9067) becomes structurally impossible.
 *  2. **Context-triggered for ambiguous shapes.** A date is only a DOB next to date-of-birth
 *     language; four digits are only an account fragment next to account language. Blanket
 *     rules would eat follow-up dates and dollar figures — and a nulled follow-up date deletes
 *     a captured promise, the false-drop direction every module in this codebase treats as the
 *     dangerous one.
 *  3. **Phone numbers are deliberately NOT redacted.** They are how the contact is matched in
 *     the first place, their shape (3-3-4) is distinct from an SSN's (3-2-4), and a rule blunt
 *     enough to catch them spoken would catch dollar amounts too. Long digit runs the context
 *     rules didn't claim are left for assertRedacted's warning path.
 *  4. **Counts out, never contents.** The result reports HOW MANY of each kind were redacted —
 *     never the original strings. The counts flow to the run record; the NPI must not.
 *  5. **Idempotent.** No placeholder contains a digit or a month name, so running the module on
 *     its own output changes nothing.
 *  6. **Bilingual, same tables.** Many callers are Spanish-speaking and calls
 *     code-switch mid-sentence (fixtures R-05/R-10), so the context lexicons carry both
 *     languages in the same patterns — the same judgement the numeral parser made. A
 *     `language === 'es'` branch would fail on the common case.
 *
 * ⚠️ A warning here means a context phrase was seen but nothing in its window matched a
 * redactable shape — i.e. the lexicon may have a gap. A PATTERN of such warnings in the run record
 * means this file needs a new rule; that is the observability loop the spec asks for.
 */

// ---------------------------------------------------------------------------
// Shapes shared with the step 5b guard (one copy — guard.ts imports these)
// ---------------------------------------------------------------------------

/** 123-45-6789 / 123 45 6789 — high-signal, effectively never a mortgage figure. */
export const SSN_SHAPE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;

/** Suspicious but ambiguous — a spoken phone number or a quoted account. Warn, never throw. */
export const LONG_DIGIT_RUN = /\b\d{9,}\b/;

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

export interface RedactionResult {
  /** The transcript with NPI replaced by [SSN] / [DOB] / [ADDRESS] / [ACCOUNT]. */
  redacted: string;
  /** How many of each kind were replaced. Safe for the run record — contains no NPI. */
  counts: { ssn: number; dob: number; address: number; account: number };
  /**
   * Context phrases seen with nothing redactable in their window — a possible lexicon gap.
   * Feeds the run record's redaction warnings alongside assertRedacted's own warnings.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

/** How far after a context phrase the redactable value may sit. Crosses speaker turns on
 *  purpose: "And your date of birth?\nMr. Okonkwo: March fourth..." answers on the next line. */
const CONTEXT_WINDOW = 120;

const SSN_CONTEXT = /social security(?: number)?|\bSSN\b|seguro social/gi;

/**
 * Bare "social" ("my social is 123456789", "last four of my social"). Too common
 * a word for the loose SSN_DIGITS window ("social media … 350,000" would lose the 350), so it only
 * claims SSN-SHAPED values: nine digits, 3-2-4 with or without separators, or a spoken digit run.
 * A four-digit "last four" is claimed separately by LAST_FOUR_SOCIAL.
 */
const SOCIAL_CONTEXT = /\bsocial\b(?!\s+(?:security|media|worker|club|event|life|skills|services))/gi;
const SSN_STRICT = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;
const LAST_FOUR_SOCIAL =
  /\b(?:last (?:four|4)(?: digits)?|[úu]ltimos (?:cuatro|4)(?: d[íi]gitos)?)\b[^.\n\d]{0,40}?\b(?:social|SSN|seguro social)\b[^\d\n]{0,30}?(\d{4})\b/gi;

const DOB_CONTEXT = /date of birth|\bDOB\b|\bborn\b|fecha de nacimiento|\bnacimiento\b|nacio|nació/gi;

/**
 * Account-number language. Includes loan/card wording in both languages ("my loan number is …",
 * "número de préstamo", "credit card", "tarjeta"). Bare "loan" and "préstamo" stay OUT: every call
 * says them next to prices, so they would open a window on nearly every figure for no gain.
 */
const ACCOUNT_CONTEXT =
  /\baccount\b|\brouting\b|\bcuenta\b|\bloan (?:number|no\.?|#)|\bn[úu]mero (?:de(?:l)? )?pr[ée]stamo\b|\bcard\b|\btarjeta\b|\bmember (?:number|id)\b|\bpolicy number\b/gi;

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

/**
 * Words that may follow a month name inside a spoken date: ordinals, cardinals, year words, and
 * the connective tissue of both languages. "March fourth, nineteen eighty eight" consumes
 * fourth/nineteen/eighty/eight; "cuatro de marzo de mil novecientos ochenta y ocho" works from
 * the month outward the same way.
 */
const DATE_WORDS = new Set([
  // ordinals
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth', 'thirtieth',
  // cardinals that appear in spoken dates and years
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'oh',
  // spanish
  'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'veinte', 'treinta', 'mil', 'novecientos',
  'ochenta', 'noventa', 'setenta', 'sesenta', 'cincuenta', 'cuarenta',
  // connectives
  'and', 'y', 'de', 'del', 'the', 'of',
  // Spanish days said BEFORE the month ("el veintidós de abril") — the backward walk
  'primero', 'dieciséis', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veintiuno', 'veintiún', 'veintidós', 'veintidos', 'veintitrés', 'veintitres', 'veinticuatro',
  'veinticinco', 'veintiséis', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve',
]);

/** Leading words the backward walk may cross but never starts or ends a date on by itself. */
const DATE_LEAD_SKIP = new Set(['de', 'del', 'the', 'of', 'and', 'y']);

/**
 * `1420 Bayshore Court` — house number + capitalized name(s) + street suffix. Context-free: the
 * shape is specific enough that false positives are rare, and unlike dates an address has no
 * legitimate role in any extracted field. An optional unit tail ("Apt 4B", "Unit 12") rides
 * along. Spanish street forms lead with the type ("Calle Ocho 1420"), covered separately.
 */
const STREET_SUFFIX =
  'Street|St|Avenue|Ave|Court|Ct|Drive|Dr|Lane|Ln|Road|Rd|Boulevard|Blvd|Way|Circle|Cir|' +
  'Place|Pl|Terrace|Ter|Trail|Parkway|Pkwy|Highway|Hwy';
const ADDRESS_SHAPE = new RegExp(
  `\\b\\d{1,6}\\s+(?:[A-Z][A-Za-z]+\\s+){1,3}(?:${STREET_SUFFIX})\\b\\.?` +
    `(?:,?\\s+(?:Apt|Apartment|Unit|Suite|Ste)\\.?\\s+\\w{1,6})?`,
  'g',
);
const ADDRESS_SHAPE_ES = /\b(?:Calle|Avenida|Carretera)\s+(?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+\s+){0,3}\d{1,6}\b/g;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  placeholder: string;
  kind: keyof RedactionResult['counts'];
}

/** Collect every match of `re` (must be /g/) in `text` within [from, to) as a span. */
function collect(
  text: string,
  re: RegExp,
  from: number,
  to: number,
  placeholder: string,
  kind: Span['kind'],
  out: Span[],
): number {
  let found = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= from && end <= to) {
      out.push({ start, end, placeholder, kind });
      found++;
    }
    if (end >= to) break;
  }
  return found;
}

/**
 * A spoken date anchored on a month name: the month plus every following token that belongs to
 * the spoken-date lexicon. Requires at least two consumed tokens so "March is busy for us"
 * survives untouched. Only ever invoked inside a DOB context window — "I'll follow up March
 * fourth" without that context is a promise, not NPI, and stays.
 */
function collectSpokenDates(text: string, from: number, to: number, out: Span[]): number {
  const monthRe = new RegExp(`\\b(?:${MONTHS})\\b`, 'gi');
  let found = 0;
  monthRe.lastIndex = from;
  for (let m = monthRe.exec(text); m !== null && m.index < to; m = monthRe.exec(text)) {
    let end = m.index + m[0].length;
    let consumed = 0;
    // Walk forward token by token while the words stay date-shaped.
    const tail = /[\s,]+([A-Za-záéíóúñ]+|\d{1,4})/y;
    tail.lastIndex = end;
    for (let t = tail.exec(text); t !== null; t = tail.exec(text)) {
      const word = t[1].toLowerCase();
      if (!DATE_WORDS.has(word) && !/^\d{1,4}$/.test(word)) break;
      end = tail.lastIndex;
      consumed++;
      if (consumed >= 8) break;
    }
    // Walk BACKWARD too — Spanish (and "the fourth of March") put the day first, and the
    // forward walk alone left "el veintidós de [DOB]". Stops at the context window's start, and
    // never ends on a bare connective (the "de" of "fecha de nacimiento" is not part of the date).
    let start = m.index;
    let lead = 0;
    let probe = m.index;
    for (let steps = 0; steps < 4; steps++) {
      const before = /([A-Za-záéíóúñ]+|\d{1,2})[\s,]+$/.exec(text.slice(from, probe));
      if (!before) break;
      const word = before[1].toLowerCase();
      if (!DATE_WORDS.has(word) && !/^\d{1,2}$/.test(word)) break;
      probe = from + before.index;
      if (!DATE_LEAD_SKIP.has(word)) { start = probe; lead++; }
    }
    if (consumed + lead >= 2) {
      out.push({ start, end, placeholder: '[DOB]', kind: 'dob' });
      found++;
    }
  }
  return found;
}

/** Digit-form dates — 3/4/1988, 03-04-88, 1988-03-04, "March 4, 1988". */
const DIGIT_DATE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;
const MONTH_DIGIT_DATE = new RegExp(
  `\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`,
  'gi',
);

/** Inside an SSN window: digit groups, or a run of three-plus spoken digit words. */
const SSN_DIGITS = /\b\d{2,9}(?:[- ]\d{2,4}){0,3}\b/g;
const SPOKEN_DIGIT =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|oh|' +
  'cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)';
const SSN_SPOKEN = new RegExp(`\\b${SPOKEN_DIGIT}(?:[\\s,-]+${SPOKEN_DIGIT}){2,}\\b`, 'gi');

/** Inside an account window: a stated fragment ("ends 5583", "last four is 5583") or a full run. */
const ACCOUNT_FRAGMENT =
  /\b(?:ends(?: in)?|ending in|last four(?: digits)?(?: is| are)?|termina en)\s+\d{3,6}\b/gi;
/**
 * 8+ digits, contiguous OR in groups joined by single spaces/hyphens ("1234-5678-9012",
 * "4111 1111 1111 1111") — a spoken account is rarely one unbroken run. Grouped runs need 3+ digits
 * in every group, so no date shape (2026-09-10, 09/10/2026) can qualify — a looser rule ate an ISO date
 * written next to the word "card". A 3-3-4 phone number is
 * skipped even here (design rule 3), and the length check drops groups that sum below 8 digits.
 */
const ACCOUNT_RUN = /\b\d{3,}(?:[- ]\d{3,})*\b(?![,.]\d)/g;
const MIN_ACCOUNT_DIGITS = 8;
const PHONE_SHAPE = /^\d{3}[- ]\d{3}[- ]\d{4}$/;

/**
 * A payment-card number, context-free — 13–19 digits in 4-digit groups or one run, AND a
 * valid Luhn checksum. The checksum is what makes it safe without context: a random digit string
 * passes 1 time in 10, and no price, phone or date has this length.
 */
const CARD_SHAPE = /\b(?:\d{4}[- ]){3}\d{1,7}\b|\b\d{13,19}\b/g;
function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Apply spans right-to-left so earlier offsets stay valid; overlaps collapse to the first. */
function applySpans(text: string, spans: Span[]): { out: string; counts: RedactionResult['counts'] } {
  const counts = { ssn: 0, dob: 0, address: 0, account: 0 };
  // Sort by start; drop spans contained in or overlapping an earlier (longer-first) claim.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let cursor = -1;
  for (const s of spans) {
    if (s.start < cursor) continue; // overlaps something already kept
    kept.push(s);
    cursor = s.end;
  }
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const s = kept[i];
    out = out.slice(0, s.start) + s.placeholder + out.slice(s.end);
    counts[s.kind]++;
  }
  return { out, counts };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Step 4b. Call on the RAW transcript; send `result.redacted` to the model, and pass the
 * same string to validation at step 5b. `result.warnings` merges into the run record's
 * redaction warnings next to whatever `assertRedacted` adds.
 */
export function redactTranscript(raw: string): RedactionResult {
  const text = raw || '';
  const spans: Span[] = [];
  const warnings: string[] = [];

  // 1. SSN digit shape — always, no context needed. The one shape 5b treats as fatal.
  collect(text, new RegExp(SSN_SHAPE.source, 'g'), 0, text.length, '[SSN]', 'ssn', spans);

  // 2. SSN context windows — digit groups and spoken digit runs near SSN language.
  SSN_CONTEXT.lastIndex = 0;
  for (let m = SSN_CONTEXT.exec(text); m !== null; m = SSN_CONTEXT.exec(text)) {
    const from = m.index + m[0].length;
    const to = Math.min(text.length, from + CONTEXT_WINDOW);
    const n =
      collect(text, SSN_DIGITS, from, to, '[SSN]', 'ssn', spans) +
      collect(text, SSN_SPOKEN, from, to, '[SSN]', 'ssn', spans);
    if (n === 0 && !spans.some((s) => s.kind === 'ssn' && s.start >= from && s.end <= to)) {
      warnings.push('ssn_context_without_redaction');
    }
  }

  // 2b. Bare "social" — SSN-shaped values only (see SOCIAL_CONTEXT), plus "last four of my
  //     social is 6789" (only the four digits are replaced, so the sentence still reads).
  SOCIAL_CONTEXT.lastIndex = 0;
  for (let m = SOCIAL_CONTEXT.exec(text); m !== null; m = SOCIAL_CONTEXT.exec(text)) {
    const from = m.index + m[0].length;
    const to = Math.min(text.length, from + CONTEXT_WINDOW);
    collect(text, SSN_STRICT, from, to, '[SSN]', 'ssn', spans);
    collect(text, SSN_SPOKEN, from, to, '[SSN]', 'ssn', spans);
  }
  LAST_FOUR_SOCIAL.lastIndex = 0;
  for (let m = LAST_FOUR_SOCIAL.exec(text); m !== null; m = LAST_FOUR_SOCIAL.exec(text)) {
    const start = m.index + m[0].length - m[1].length;
    spans.push({ start, end: start + 4, placeholder: '[SSN]', kind: 'ssn' });
  }

  // 3. DOB context windows — digit dates, month-digit dates, and fully spoken dates.
  DOB_CONTEXT.lastIndex = 0;
  for (let m = DOB_CONTEXT.exec(text); m !== null; m = DOB_CONTEXT.exec(text)) {
    const from = m.index + m[0].length;
    const to = Math.min(text.length, from + CONTEXT_WINDOW);
    const n =
      collect(text, DIGIT_DATE, from, to, '[DOB]', 'dob', spans) +
      collect(text, MONTH_DIGIT_DATE, from, to, '[DOB]', 'dob', spans) +
      collectSpokenDates(text, from, to, spans);
    if (n === 0) warnings.push('dob_context_without_redaction');
  }

  // 4. Addresses — context-free by design (see lexicon note).
  collect(text, ADDRESS_SHAPE, 0, text.length, '[ADDRESS]', 'address', spans);
  collect(text, ADDRESS_SHAPE_ES, 0, text.length, '[ADDRESS]', 'address', spans);

  // 5. Account fragments — the stated-fragment form anywhere (it names itself), full digit
  //    runs only near account/routing language (a bare long run may be a spoken phone number,
  //    which is assertRedacted's warning path, not ours).
  collect(text, ACCOUNT_FRAGMENT, 0, text.length, '[ACCOUNT]', 'account', spans);
  ACCOUNT_CONTEXT.lastIndex = 0;
  for (let m = ACCOUNT_CONTEXT.exec(text); m !== null; m = ACCOUNT_CONTEXT.exec(text)) {
    const from = m.index + m[0].length;
    const to = Math.min(text.length, from + CONTEXT_WINDOW);
    const runs: Span[] = [];
    collect(text, ACCOUNT_RUN, from, to, '[ACCOUNT]', 'account', runs);
    for (const s of runs) {
      const run = text.slice(s.start, s.end);
      if (run.replace(/\D/g, '').length >= MIN_ACCOUNT_DIGITS && !PHONE_SHAPE.test(run)) spans.push(s);
    }
  }

  // 6. Card numbers anywhere, checksum-gated. Counted as `account` (the run record shape is fixed).
  CARD_SHAPE.lastIndex = 0;
  for (let m = CARD_SHAPE.exec(text); m !== null; m = CARD_SHAPE.exec(text)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
      spans.push({ start: m.index, end: m.index + m[0].length, placeholder: '[CARD]', kind: 'account' });
    }
  }

  const { out, counts } = applySpans(text, spans);
  return { redacted: out, counts, warnings };
}

// ---------------------------------------------------------------------------
// Model-bound CONTEXT, not just the transcript
// ---------------------------------------------------------------------------

/**
 * The same redactor for any string headed to the model that a person may have typed: notes,
 * key-fact lines, coaching, waiting-on, realtor updates. Null-safe; returns '' for empty input so
 * callers keep their own "(not provided)" fallbacks.
 */
export function redactText(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  return s ? redactTranscript(s).redacted : '';
}

/**
 * Pre-request gate: the high-signal shapes that must never be in a request body after redaction —
 * a 3-2-4 SSN and a checksum-valid card number. Returns the kind found, or null. The request
 * builder's caller throws on a hit (the run fails into the error path instead of sending), so a context field someone adds
 * later without redaction fails its first call loudly rather than leaking quietly.
 */
export function findUnredacted(text: string): 'ssn' | 'card' | null {
  const t = text || '';
  if (new RegExp(SSN_SHAPE.source).test(t)) return 'ssn';
  CARD_SHAPE.lastIndex = 0;
  for (let m = CARD_SHAPE.exec(t); m !== null; m = CARD_SHAPE.exec(t)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) return 'card';
  }
  return null;
}
