/**
 * validate.ts — G0 + G1 grounding checks for the extraction core.
 *
 * WHAT THIS IS
 * ------------
 * G0 answers one question per numeric guardrail: *was this number actually said on the call?*
 * G1 tightens it to *which sentence says it?* — the model returns a verbatim quote per
 * extractive field, code proves the quote is really in the transcript, and the number is then
 * grounded inside that quote. Either way, a field that fails is dropped rather than written.
 * This is the enforcement behind the prompt's "never fabricate numbers" rule — the same move
 * redact.ts makes for disclosure: the difference between "we instruct the model not to" and
 * "it cannot reach the record".
 *
 * TWO ENTRY POINTS, ONE OF THEM TRANSITIONAL
 * ------------------------------------------
 *   `validateGuardrails(guardrails, transcript)`  — G0. Bare values, no spans.
 *   `validateExtraction(extraction, transcript)`  — G1. Spanned values, and it still runs the
 *                                                   G0 check on any field that arrives bare,
 *                                                   so the prompt can gain spans field by field.
 * Once the prompt emits spans for all ~6 fields, step 5b calls `validateExtraction`.
 *
 * WHAT THEY CATCH, AND WHAT THEY DO NOT
 * -------------------------------------
 *   ✅ Fabrication      — a figure, or now a quote, appearing nowhere in the transcript.
 *   ❌ Misattribution   — "we're paying about thirty two hundred a month right now" is the
 *                         client's CURRENT RENT. Filed as max_payment it PASSES both gates:
 *                         the number was said, and the quote is genuine. Still wrong.
 * G1 makes misattribution REVIEWABLE by putting the quote in front of a human; it does not
 * eliminate it. That is fixture and prompt work. Never describe either as a guarantee.
 *
 * DESIGN NOTE — WHY THIS IS BIGGER THAN "REGEX THE NUMBERS"
 * --------------------------------------------------------
 * Transcripts are speech-to-text. Mortgage figures are spoken far more often than digitised:
 * "thirty two hundred", "four hundred thousand", "six and seven eighths", "six seventy five".
 * A naive /\d+/ finds none of those and would null correct guardrails on nearly every call —
 * which is worse than no check at all, because the team quietly loses the guardrail feature.
 * Spoken numerals are the whole difficulty here; the parser below is the actual deliverable.
 *
 * RECALL IS DELIBERATELY FAVOURED OVER PRECISION
 * ----------------------------------------------
 * Ambiguous spoken runs emit MULTIPLE candidate readings ("six seventy five" -> 81, 675, 6.75).
 * A false drop costs a real guardrail the team needed; a missed fabrication is still caught by
 * G1, the adversarial fixtures, and human review of the draft. Every candidate emitted here
 * corresponds to a genuine reading of the words actually spoken — never an arbitrary
 * combination. That distinction is what keeps the check meaningful.
 *
 * CONSTRAINTS
 * -----------
 *  - Pure functions, no I/O. Callable from a test, a script, or a sandboxed code step.
 *  - NO external modules — sandboxed code steps cannot import them. Nothing here imports.
 *  - No TS features requiring codegen (no enum / namespace / decorators / parameter properties),
 *    so `node --experimental-strip-types` runs this file directly. That is not a convenience:
 *    it is the machine-checked guarantee that the file is paste-safe into a plain-JS code step
 *    once types are stripped. If the core tests run, that target is valid.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardrailKey =
  | 'approved_price'
  | 'max_payment'
  | 'max_out_of_pocket'
  | 'rate_range_quoted';

export interface Guardrails {
  approved_price?: number | null;
  max_payment?: number | null;
  max_out_of_pocket?: number | null;
  rate_range_quoted?: string | null;
  /** Date, not numeric. G0 does not check it — see G1 (evidence spans). */
  preapproval_date?: string | null;
}

/** Fields that can fail validation. G0 covers the guardrails; G1 adds the other span carriers. */
export type SpanFieldKey =
  | GuardrailKey
  | 'preapproval_date'
  | 'follow_up_date'
  | 'blocker'
  | 'key_facts'
  /** The qualification array as a whole; the specific member is named in `qualificationField`. */
  | 'qualification'
  /* The stage signal and the next-action object. */
  | 'stage_signal'
  | 'next_action';

/**
 * Fields checked by structural validation (§ Structural validation, below) rather than by
 * grounding. A different axis: grounding asks *was this said?*, structure asks *is this a legal
 * value for the field?* The two date fields appear in both — a date can be genuinely quoted and
 * still be nonsense.
 */
export type StructuralFieldKey =
  | 'urgency_flag'
  | 'waiting_on'
  | 'language'
  | 'loan_stage'
  | 'follow_up_date'
  | 'preapproval_date';

export type ValidatedFieldKey = SpanFieldKey | StructuralFieldKey | 'realtor_update';

export interface ValidationFailure {
  field: ValidatedFieldKey;
  /** Which element of `key_facts` (or `qualification`) failed. Absent for scalar fields. */
  index?: number;
  /** Which of the seven qualification members failed, when `field === 'qualification'`. */
  qualificationField?: QualificationField;
  /** The value as the model returned it. */
  value: number | string;
  /** For rate_range_quoted: which bound failed. Absent for scalar fields. */
  bound?: number;
  reason:
    | 'not_grounded_in_transcript'
    | 'implausible_for_field'
    /* G1 — see § Evidence spans. */
    | 'evidence_missing'
    | 'evidence_not_in_transcript'
    | 'evidence_too_short'
    /* Structural — see § Structural validation. */
    | 'not_a_valid_enum_value'
    | 'not_a_valid_date'
    | 'date_before_call'
    | 'date_in_future'
    | 'date_implausibly_far'
    /* Qualification array — see § validateQualification. */
    | 'unknown_qualification_field'
    /* Realtor update — see validateRealtorUpdate. */
    | 'realtor_update_unsafe'
    /* Key facts ops — refused by the list, not by grounding. */
    | 'key_fact_human_line'
    | 'key_fact_no_such_line'
    | 'key_fact_same_line_twice'
    /* The engine had a blocker but a person had rewritten the field; theirs stays. */
    | 'human_edit_kept'
    /* This call is OLDER than the record's last call date (a replay or a late paste), so the
       newer call's Blocker stays; this call's view goes to the run record. */
    | 'older_call_kept';
  /** Every reading we searched for, so a tuning session can see why it missed. */
  candidates: number[];
}

export interface ValidationResult {
  /** Guardrails with failed fields set to null. Safe to write. */
  guardrails: Guardrails;
  /** Feeds the run record's `validation_failures` field. Empty on a clean run. */
  failures: ValidationFailure[];
  /** Every number G0 found in the transcript. Diagnostic only — do not write to the store. */
  transcriptNumbers: number[];
}

// ---------------------------------------------------------------------------
// Field rules
//
// Tunable against the ~20 fixtures. These encode mortgage-desk speech habits, so
// they are judgement calls, not physics — revisit them when fixtures disagree.
// ---------------------------------------------------------------------------

interface FieldRule {
  /** Plausibility band. Outside it, the value is wrong regardless of the transcript. */
  min: number;
  max: number;
  /**
   * Spoken shorthand divisors. "Approved you up to four hundred" means $400,000, so when
   * checking 400000 we also accept a bare 400 in the transcript.
   * Deliberately empty for max_payment: dividing 3200 by 1000 gives 3.2, which collides with
   * the rate numbers said on the same call and would make the check trivially passable.
   */
  shorthandDivisors: number[];
  /** Rates are quoted in eighths and read as "six seventy five". Enables those readings. */
  isRate: boolean;
}

const FIELD_RULES: Record<GuardrailKey, FieldRule> = {
  approved_price: { min: 25_000, max: 20_000_000, shorthandDivisors: [1000], isRate: false },
  max_payment: { min: 200, max: 100_000, shorthandDivisors: [], isRate: false },
  max_out_of_pocket: { min: 100, max: 2_000_000, shorthandDivisors: [1000], isRate: false },
  rate_range_quoted: { min: 0.5, max: 25, shorthandDivisors: [], isRate: true },
};

/** Floating-point tolerance. Rates in eighths (6.875) need more than exact equality. */
const EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

/**
 * 🚩 THE LEXICONS ARE BILINGUAL, AND THAT IS THE DESIGN — NOT A LANGUAGE SWITCH.
 *
 * Many callers are Spanish-speaking, and the calls do not divide neatly:
 * fixture R-05 has a figure in English and the sentence around it in Spanish. So English and
 * Spanish number words live in the SAME tables and the parser never asks what language it is
 * reading. A `language === 'es'` branch would have failed on every code-switched call, which is
 * the common case here rather than the exotic one.
 *
 * Everything downstream — collectRun, parseRunStandard, parseRunColloquial — is language-agnostic
 * and needed no changes. Adding a third language is a lexicon edit.
 */
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,

  // Spanish. Accents are folded before lookup, so only unaccented spellings are needed
  // ("dieciséis" -> "dieciseis"). See normalizeTranscript.
  cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  // 21–29 contract into single words and behave as one additive chunk.
  veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,

  // ⚠️ `un` / `una` / `uno` are deliberately ABSENT. They are the Spanish indefinite article and
  // appear constantly in ordinary speech ("un poco cara"), so admitting them would emit a 1 for
  // half the sentences on a call — and 1 sits inside the rate plausibility band, so it would let
  // a fabricated rate ground itself. "un millón" still parses correctly without them, because a
  // scale word with nothing accumulated in front of it already reads as one (see parseRunStandard).
  // Cost: "cuarenta y uno" reads as 40. Nobody quotes a mortgage figure of forty-one.
  // But they DO quote "trescientos cuarenta y un mil" (341,000), which used to
  // split into 340 and 1000 and null a correct approved price. collectRun now reads un/uno/una as 1
  // in exactly one place: INSIDE a number run and IMMEDIATELY before a scale word (mil / millón).
  // A bare article never starts a run, so "un poco cara" still yields nothing.
};

/** The Spanish "one" forms, admitted only mid-run before a scale word. See collectRun. */
const SPANISH_ONE = new Set(['un', 'uno', 'una']);

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,

  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};

/**
 * Spanish states the hundreds as single words rather than "<n> hundred", so they are additive
 * like TENS rather than multiplicative like SCALES: "trescientos veinte mil" accumulates
 * 300 + 20 and only then meets the scale word.
 *
 * Feminine forms are included because they cost nothing and speech-to-text will produce whichever
 * the speaker said.
 */
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100,
  doscientos: 200, doscientas: 200,
  trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};

const SCALES: Record<string, number> = {
  hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000,

  mil: 1000, millon: 1_000_000, millones: 1_000_000,
};

/** Mortgage rates are quoted in eighths — this lexicon is load-bearing, not decoration. */
const FRACTIONS: Record<string, number> = {
  half: 0.5, halves: 0.5,
  quarter: 0.25, quarters: 0.25,
  third: 1 / 3, thirds: 1 / 3,
  eighth: 0.125, eighths: 0.125,
  sixteenth: 0.0625, sixteenths: 0.0625,

  // "seis y medio" = 6.5, "seis y tres cuartos" = 6.75 — how a rate is actually said in Spanish.
  medio: 0.5, media: 0.5, medios: 0.5,
  cuarto: 0.25, cuartos: 0.25,
  tercio: 1 / 3, tercios: 1 / 3,
  octavo: 0.125, octavos: 0.125,
};

/** `y` joins Spanish number phrases exactly as `and` does in English. */
const CONNECTORS = new Set(['and', 'a', 'an', 'point', 'y', 'punto', 'coma']);

/** Words that open a decimal tail: "six point seven five", "seis punto siete cinco". */
const DECIMAL_MARKERS = new Set(['point', 'punto', 'coma']);

/**
 * 🚩 Spanish number words that are also ordinary ENGLISH words, and would otherwise poison every
 * English transcript with phantom figures.
 *
 * `once` is 11 in Spanish and appears in nearly every English call ("once you've had a chance" —
 * that exact phrase is in fixture R-01). `media` is 0.5 and collides with "social media". Both
 * land inside the rate plausibility band, so admitting them unconditionally would let a
 * fabricated rate ground itself against prose.
 *
 * Resolution: these count as numbers ONLY when a genuine number word sits next to them, looking
 * through connectors. "once mil" is eleven thousand; "once you've" is not a number. Handled in
 * `resolveAmbiguous`, before any run is collected.
 */
const AMBIGUOUS = new Set(['once', 'media', 'coma']);

/**
 * Spoken suffixes: "four hundred k". These never START a number, so they are handled as a
 * continuation only — otherwise a stray "k" in prose would open a phantom run.
 */
const SUFFIX_SCALES: Record<string, number> = { k: 1000, m: 1_000_000 };

function isNumberWord(w: string): boolean {
  return w in UNITS || w in TENS || w in HUNDREDS || w in SCALES || w in FRACTIONS;
}

/** A number word that is unambiguously one — used to license the words in AMBIGUOUS. */
function isUnambiguousNumberWord(w: string): boolean {
  return isNumberWord(w) && !AMBIGUOUS.has(w);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Lowercase, fold accents, join hyphenated number words ("thirty-two" -> "thirty two"), strip
 * thousands separators inside numbers only, and drop currency symbols. Decimal points and %
 * survive.
 *
 * 🚩 **Accent folding is load-bearing twice over, and it is safe because it runs on BOTH sides.**
 * `canonicalizeSpan` builds on this function, so the transcript and the model's quote are folded
 * identically and the substring guarantee is untouched.
 *   1. Number words: the lexicon then needs one spelling of "millon" rather than two, and a
 *      transcript that writes "dieciséis" still grounds.
 *   2. Spans: speech-to-text and the model disagree about accents constantly. Unfolded, that
 *      reads as `evidence_not_in_transcript` — a fabricated quote — which is the same class of
 *      silent false drop as the curly-apostrophe bug.
 */
export function normalizeTranscript(raw: string): string {
  let t = (raw || '').toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip combining accents: e-acute -> e
  t = t.replace(/[‐-―−]/g, '-'); // unicode dashes -> ascii hyphen
  t = t.replace(/(\d),(?=\d{3}(\D|$))/g, '$1'); // 1,200 -> 1200 (only between digit groups)
  t = t.replace(/[$£€]/g, ' ');
  t = t.replace(/-/g, ' ');
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

/**
 * 🚩 Trailing '.' and '%' MUST be stripped, and this is not cosmetic.
 *
 * '.' is kept inside tokens so decimals survive ("6.5"), but that also glues sentence-final
 * punctuation onto the last word: "thirty two hundred." tokenizes as [thirty, two, "hundred."],
 * "hundred." is not a scale word, and the phrase parses as 32 instead of 3200. Likewise
 * "six and a half." -> 6. Numbers land at the end of a sentence constantly on a call, so
 * without this the check would false-drop correct guardrails at a high rate — the exact failure
 * that makes a validator worse than none.
 */
/**
 * Inert token marking a sentence boundary. Letters only, so it survives the split; in no
 * lexicon, so every downstream stage treats it as ordinary prose and stops a run at it.
 */
const SENTENCE_BREAK = 'zzsentencebreak';

/**
 * 🚩 SENTENCE BOUNDARIES TERMINATE A RUN. Found while adding the Spanish lexicon; the bug
 * lives in the ENGLISH path just as badly.
 *
 * Punctuation is discarded before parsing (it has to be — decimals need the '.' inside a token),
 * which glued adjacent sentences into one run. "the rate is six point seven five. Twelve thousand
 * five hundred to close" collected as a single run, the decimal tail swallowed "twelve" as another
 * digit group, and the whole thing parsed to **6.7512** — emitting a garbage figure and dropping
 * BOTH real ones. Two guardrails silently nulled by one full stop.
 *
 * The `([.!?;:])\s` shape is what makes this safe: the punctuation must be followed by
 * whitespace, so "6.5" and "6.875" are untouched while "6.5. Twelve" splits correctly.
 */
function tokenize(normalized: string): string[] {
  const withBreaks = normalized.replace(/([.!?;:])\s/g, ' ' + SENTENCE_BREAK + ' ');
  const raw = withBreaks
    .split(/[^a-z0-9.%]+/)
    .map((t) => t.replace(/[.%]+$/, ''))
    .filter((t) => t.length > 0);
  return resolveAmbiguous(raw);
}

/**
 * Neutralise the words in AMBIGUOUS unless a genuine number word sits beside them.
 *
 * `once` is Spanish for 11 and English for "as soon as"; `media` is Spanish for a half and
 * English for the press. Both would otherwise emit a figure from ordinary prose — and both land
 * inside the rate plausibility band, so the damage is not noise, it is a fabricated rate
 * grounding itself against a sentence that has no numbers in it.
 *
 * The licence test looks THROUGH connectors, because "seis y media" is the whole reason the
 * Spanish fraction words are here: `media` is licensed by `seis` two tokens away.
 *
 * Neutralised tokens become a sentinel that is in no lexicon, so every downstream stage —
 * isNumberWord, collectRun, the parsers — treats them as ordinary prose without knowing this
 * step exists. **Word positions are preserved**, which matters: run lengths drive the scanner's
 * advance in extractSpokenNumbers.
 */
const NOT_A_NUMBER = '\u0000';

function resolveAmbiguous(tokens: string[]): string[] {
  const licensed = (from: number, step: number): boolean => {
    let i = from;
    // Walk over connectors ("y", "and", "a") looking for a real number word.
    while (i >= 0 && i < tokens.length && CONNECTORS.has(tokens[i])) i += step;
    return i >= 0 && i < tokens.length && isUnambiguousNumberWord(tokens[i]);
  };

  return tokens.map((t, i) => {
    if (!AMBIGUOUS.has(t)) return t;
    return licensed(i - 1, -1) || licensed(i + 1, 1) ? t : NOT_A_NUMBER;
  });
}

// ---------------------------------------------------------------------------
// Method A(i) — digit forms
// ---------------------------------------------------------------------------

/**
 * Pulls digit-written numbers, including k/m suffixes ("400k", "1.2 m").
 * Runs on normalized text, so commas and currency symbols are already gone.
 */
export function extractDigitNumbers(normalized: string): number[] {
  const out: number[] = [];

  // Suffixed forms first: 400k, 1.2m, 400 k
  const suffixed = /(\d+(?:\.\d+)?)\s*([km])\b/g;
  let m: RegExpExecArray | null;
  while ((m = suffixed.exec(normalized)) !== null) {
    const base = parseFloat(m[1]);
    out.push(m[2] === 'k' ? base * 1000 : base * 1_000_000);
  }

  // Bare numeric tokens. Trailing '.' or '%' are stripped by parseFloat semantics below.
  const bare = /\d+(?:\.\d+)?/g;
  while ((m = bare.exec(normalized)) !== null) {
    const v = parseFloat(m[0]);
    if (!Number.isNaN(v)) out.push(v);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Method A(ii) — spoken forms
// ---------------------------------------------------------------------------

/**
 * Collects the maximal run of number-ish tokens starting at `start`.
 *
 * Two rules that are easy to get wrong and were both caught by the test suite:
 *
 *  1. Connectors ("and", "a", "point") only extend the run when a number word follows, so
 *     ordinary prose ("...six and then we talked about...") does not swallow half a sentence.
 *
 *  2. 🚩 A FRACTION CLOSES THE PHRASE. Without this, "between six and a half and six and seven
 *     eighths" collects as ONE run: the parser returns 6.5 at the first fraction, the scanner
 *     advances past the whole run, and the second rate (6.875) is never emitted at all — so a
 *     correctly-extracted 6.875 gets nulled as ungrounded. Rate ranges are stated exactly this
 *     way on nearly every call, so this is the difference between working and useless.
 */
function collectRun(tokens: string[], start: number): string[] {
  const run: string[] = [];
  let i = start;
  let closedByFraction = false;

  while (i < tokens.length) {
    const t = tokens[i];

    if (isNumberWord(t)) {
      run.push(t);
      i++;
      if (t in FRACTIONS) { closedByFraction = true; break; }
      continue;
    }

    // "trescientos un mil" — a Spanish "one" mid-run, right before a scale word.
    if (run.length > 0 && SPANISH_ONE.has(t) && i + 1 < tokens.length && tokens[i + 1] in SCALES) {
      run.push('one');
      i++;
      continue;
    }

    if (CONNECTORS.has(t)) {
      // Look ahead past further connectors for a number word.
      let j = i + 1;
      while (j < tokens.length && CONNECTORS.has(tokens[j])) j++;
      // "cuarenta y un mil" — the same Spanish "one", reached through a connector.
      if (run.length > 0 && j + 1 < tokens.length && SPANISH_ONE.has(tokens[j]) && tokens[j + 1] in SCALES) {
        run.push(...tokens.slice(i, j), 'one');
        i = j + 1;
        continue;
      }
      if (j < tokens.length && isNumberWord(tokens[j])) {
        run.push(...tokens.slice(i, j + 1));
        const last = tokens[j];
        i = j + 1;
        if (last in FRACTIONS) { closedByFraction = true; break; }
        continue;
      }
    }
    break;
  }

  // Trailing spoken suffix: "four hundred k".
  if (run.length > 0 && !closedByFraction && i < tokens.length && tokens[i] in SUFFIX_SCALES) {
    run.push(tokens[i]);
  }

  return run;
}

/**
 * Standard English number parse. Handles "three thousand two hundred", "thirty two hundred",
 * "four hundred thousand", decimals via "point", and mortgage fractions via "and a half" /
 * "and seven eighths".
 */
function parseRunStandard(run: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;

  for (let i = 0; i < run.length; i++) {
    const w = run[i];

    if (DECIMAL_MARKERS.has(w)) {
      // Decimal tail: subsequent number words become digits after the point.
      const digits: string[] = [];
      let j = i + 1;
      while (j < run.length) {
        const d = run[j];

        // "setenta y cinco" — the connector is part of the Spanish phrase, not a terminator.
        if (CONNECTORS.has(d)) { j++; continue; }

        if (d in TENS) {
          // 🚩 A tens word followed by a unit is ONE two-digit group, not two groups.
          // Without this, "six point seventy five" parsed as 0.705 rather than 0.75 — a
          // false drop on a phrasing used constantly in both languages. The Spanish form
          // "punto setenta y cinco" reaches here through the connector skip above.
          let k = j + 1;
          while (k < run.length && CONNECTORS.has(run[k])) k++;
          const next = run[k];
          if (next !== undefined && next in UNITS && UNITS[next] < 10) {
            digits.push(String(TENS[d] + UNITS[next]));
            j = k + 1;
            continue;
          }
          digits.push(String(TENS[d]));
          j++;
          continue;
        }

        if (d in UNITS) { digits.push(String(UNITS[d])); j++; continue; }
        break;
      }
      if (digits.length > 0) {
        const frac = parseFloat('0.' + digits.join(''));
        return (total + current) + frac;
      }
      continue;
    }

    if (w in FRACTIONS) {
      // "and a half" -> +0.5 ; "and seven eighths" -> 7 * 0.125
      const unit = FRACTIONS[w];
      if (current > 0 && current < 16 && seen && i > 0 && run[i - 1] in UNITS) {
        // current already absorbed the numerator (e.g. 6 then 7 -> 13); undo it.
        const numerator = UNITS[run[i - 1]];
        current -= numerator;
        return total + current + numerator * unit;
      }
      return total + current + unit;
    }

    if (w in SUFFIX_SCALES) {
      // "four hundred k" -> everything accumulated so far is scaled.
      total = (total + current) * SUFFIX_SCALES[w];
      current = 0;
      seen = true;
      continue;
    }

    if (w in UNITS) { current += UNITS[w]; seen = true; continue; }
    if (w in TENS) { current += TENS[w]; seen = true; continue; }

    // Spanish states hundreds as one word, so they ADD to the run rather than multiplying it:
    // "trescientos veinte mil" accumulates 300 + 20 and only then meets the scale word.
    if (w in HUNDREDS) { current += HUNDREDS[w]; seen = true; continue; }

    if (w in SCALES) {
      const scale = SCALES[w];
      if (scale === 100) {
        current = (current === 0 ? 1 : current) * 100;
      } else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
      }
      seen = true;
      continue;
    }
    // Connectors fall through.
  }

  if (!seen) return null;
  return total + current;
}

/**
 * Colloquial readings of a scale-free run — the "six seventy five" case.
 *
 * "six seventy five" is not well-formed English for one number; standard parsing gives 81.
 * On a mortgage call it means 6.75, and occasionally 675. Both are genuine readings of the
 * words spoken, so both are emitted alongside the standard parse.
 *
 * Chunking: a teen or a tens[+unit] pair forms one spoken chunk; a bare unit forms its own.
 * "four twenty five" -> [4][25] -> 4.25 as a rate, and 425 as price shorthand.
 */
function parseRunColloquial(run: string[]): number[] {
  // A scale word, hundred word, fraction or explicit decimal makes the reading unambiguous —
  // no alternates. Spanish hundreds are included because "trescientos veinte" states its own
  // magnitude; there is no "six seventy five" ambiguity to resolve.
  if (run.some((w) => w in SCALES || w in HUNDREDS || w in FRACTIONS || DECIMAL_MARKERS.has(w))) {
    return [];
  }

  let words = run.filter((w) => !CONNECTORS.has(w));

  // A trailing suffix scales the colloquial reading rather than blocking it:
  // "four fifty k" is 450,000, which neither the standard parse (54,000) nor an
  // unsuffixed colloquial reading (450) produces on its own.
  let suffix = 1;
  const last = words[words.length - 1];
  if (last !== undefined && last in SUFFIX_SCALES) {
    suffix = SUFFIX_SCALES[last];
    words = words.slice(0, -1);
  }

  if (words.length < 2) return [];

  const chunks: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) {
      const next = words[i + 1];
      if (next && next in UNITS && UNITS[next] < 10) {
        chunks.push(TENS[w] + UNITS[next]);
        i++;
      } else {
        chunks.push(TENS[w]);
      }
    } else if (w in UNITS) {
      chunks.push(UNITS[w]);
    } else {
      return [];
    }
  }

  if (chunks.length < 2) return [];

  const out: number[] = [];
  const head = chunks[0];
  const tail = chunks.slice(1);

  // Concatenated reading: [6][75] -> 675 ; [4][25] -> 425 ; [4][50] + k -> 450,000
  const concat = String(head) + tail.map((c) => String(c).padStart(2, '0')).join('');
  const concatVal = parseFloat(concat);
  if (!Number.isNaN(concatVal)) out.push(concatVal * suffix);

  // Decimal reading: [6][75] -> 6.75 — how rates are actually spoken. Skipped when a suffix
  // is present, because the suffix already fixes the magnitude ("four fifty k" is 450k,
  // never 4.5k) and emitting it would only weaken the check.
  if (suffix === 1) {
    const decimal = parseFloat(String(head) + '.' + tail.map((c) => String(c).padStart(2, '0')).join(''));
    if (!Number.isNaN(decimal)) out.push(decimal);
  }

  return out;
}

/** Every number the transcript states in words, with ambiguous runs contributing all readings. */
export function extractSpokenNumbers(normalized: string): number[] {
  const tokens = tokenize(normalized);
  const out: number[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (!isNumberWord(tokens[i])) { i++; continue; }

    const run = collectRun(tokens, i);
    if (run.length === 0) { i++; continue; }

    const standard = parseRunStandard(run);
    if (standard !== null) out.push(standard);
    out.push(...parseRunColloquial(run));

    i += run.length;
  }

  return out;
}

/** Union of digit and spoken extraction — every number G0 believes was stated. */
export function extractNumbers(normalized: string): number[] {
  return [...extractDigitNumbers(normalized), ...extractSpokenNumbers(normalized)];
}

// ---------------------------------------------------------------------------
// Grounding decision
// ---------------------------------------------------------------------------

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/**
 * Candidate values that would each count as "this figure was said".
 * Only genuine alternate renderings — never arbitrary arithmetic on the value.
 */
export function candidatesFor(value: number, rule: FieldRule): number[] {
  const out = [value];
  for (const d of rule.shorthandDivisors) {
    const scaled = value / d;
    if (scaled >= 1) out.push(scaled);
  }
  return out;
}

function isGrounded(value: number, rule: FieldRule, numbers: number[]): boolean {
  const candidates = candidatesFor(value, rule);
  return candidates.some((c) => numbers.some((n) => nearlyEqual(c, n)));
}

/**
 * Type and plausibility-band guards, shared by G0 and G1 so the two paths cannot drift apart.
 * Returns the failure to record, or null if the value is worth grounding.
 *
 * Runs BEFORE any span check: a value outside the band is wrong no matter what quote came with
 * it, and reporting `implausible_for_field` is the more useful signal for prompt tuning.
 */
function plausibilityFailure(
  field: GuardrailKey,
  value: number,
  rule: FieldRule,
): ValidationFailure | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { field, value: value as number, reason: 'implausible_for_field', candidates: [] };
  }
  if (value < rule.min || value > rule.max) {
    return { field, value, reason: 'implausible_for_field', candidates: candidatesFor(value, rule) };
  }
  return null;
}

/**
 * Pulls the numeric bounds out of a rate string: "6.5-6.875%", "around 6.5%", "6.5 to 6.875".
 */
export function parseRateBounds(raw: string): number[] {
  const matches = (raw || '').match(/\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches.map((m) => parseFloat(m)).filter((n) => !Number.isNaN(n));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * G0. Run between extraction and write-back (step 5b).
 *
 * Fails closed: any guardrail whose figure cannot be found in the transcript is set to null
 * and recorded in `failures`. A nulled field is a SKIP at write-back, identical to one the
 * model returned as null — never a marker on the contact record. The team should not have to
 * reason about validation state; the signal lives in the run record.
 *
 * @param guardrails Raw `guardrails` object from the extraction call.
 * @param transcript The REDACTED transcript — the same text sent to the model (step 4b).
 */
export function validateGuardrails(
  guardrails: Guardrails,
  transcript: string,
): ValidationResult {
  const normalized = normalizeTranscript(transcript);
  const numbers = extractNumbers(normalized);

  const cleaned: Guardrails = { ...guardrails };
  const failures: ValidationFailure[] = [];

  const scalarFields: GuardrailKey[] = ['approved_price', 'max_payment', 'max_out_of_pocket'];

  for (const field of scalarFields) {
    const value = guardrails[field];
    if (value === null || value === undefined) continue;

    const rule = FIELD_RULES[field];

    const implausible = plausibilityFailure(field, value, rule);
    if (implausible) {
      cleaned[field] = null;
      failures.push(implausible);
      continue;
    }

    if (!isGrounded(value, rule, numbers)) {
      cleaned[field] = null;
      failures.push({ field, value, reason: 'not_grounded_in_transcript', candidates: candidatesFor(value, rule) });
    }
  }

  // rate_range_quoted is a string carrying one or two bounds. A partially-wrong range cannot
  // be safely repaired, so if ANY bound is ungrounded the whole field is dropped.
  const rate = guardrails.rate_range_quoted;
  if (rate !== null && rate !== undefined && String(rate).trim() !== '') {
    const rule = FIELD_RULES.rate_range_quoted;
    const bounds = parseRateBounds(String(rate));

    if (bounds.length === 0) {
      cleaned.rate_range_quoted = null;
      failures.push({ field: 'rate_range_quoted', value: rate, reason: 'implausible_for_field', candidates: [] });
    } else {
      for (const bound of bounds) {
        const implausible = bound < rule.min || bound > rule.max;
        if (implausible || !isGrounded(bound, rule, numbers)) {
          cleaned.rate_range_quoted = null;
          failures.push({
            field: 'rate_range_quoted',
            value: rate,
            bound,
            reason: implausible ? 'implausible_for_field' : 'not_grounded_in_transcript',
            candidates: candidatesFor(bound, rule),
          });
          break; // one bad bound drops the field; no need to report the rest
        }
      }
    }
  }

  return {
    guardrails: cleaned,
    failures,
    transcriptNumbers: [...new Set(numbers)].sort((a, b) => a - b),
  };
}

// ===========================================================================
// G1 — evidence spans
//
// WHAT THIS ADDS OVER G0
// ----------------------
// G0 asks "was this number said anywhere on the call?". G1 asks "which sentence says it?" —
// the model returns a verbatim quote alongside each extractive value, and code checks the quote
// is really in the transcript before trusting the value. The number is then re-grounded INSIDE
// that quote rather than against the whole transcript, which is strictly tighter.
//
// 🚩 THE SUBSTRING CHECK IS THE WHOLE POINT — DO NOT "SIMPLIFY" IT AWAY
// --------------------------------------------------------------------
// Anthropic's native citations feature guarantees valid pointers *because the API extracts the
// span itself*. A model-EMITTED quote carries no such guarantee — it is generated text and can
// be as invented as the number it is meant to justify. The substring check is the compensation
// that makes this prompt-based variant acceptable at all. Removing it leaves the weaker
// mechanism with none of the compensation.
// ⚠️ Nor can we switch to the citations API: citations return a 400 when combined with
// `output_config.format`, and extraction must stay a structured-output call.
//
// WHAT IT STILL DOES NOT CATCH
// ----------------------------
// Misattribution. "we're paying about thirty two hundred a month right now in rent" filed as
// max_payment has a genuine verbatim span and passes. G1 improves REVIEWABILITY — it puts the
// quote in front of a human — it does not close the gap. Test F-4 asserts this deliberately.
//
// SCOPE — ~6 fields carry spans, ~14 must not
// -------------------------------------------
// A span is only meaningful where the value is STATED: the guardrails, `preapproval_date`,
// `key_facts`, `follow_up_date`, `blocker`. Demanding evidence for `crm_note`, the email drafts
// or `coaching` produces theatre, not verification — those are abstractive by definition.
// Do not extend it there (that is G3, and G3 is never).
// ===========================================================================

/**
 * A model-emitted value with the transcript quote that justifies it.
 *
 * "Not discussed on this call" is the whole field being `null` (schema.ts makes the pair nullable,
 * not the value inside it — the structured-outputs 16-union limit forced it). This interface still
 * permits `value: null` so a legacy `{value:null, evidence:null}` is tolerated as "not discussed"
 * rather than rejected — `unwrapSpan` collapses both to the same outcome.
 */
export interface EvidenceSpan<T> {
  value: T | null;
  evidence: string | null;
}

/**
 * Either shape is accepted per field, and that is deliberate: it is the upgrade path. A bare
 * value is a field the prompt does not yet span, and falls back to the G0 whole-transcript
 * check. A `{value, evidence}` object is held to G1. So the prompt can be rolled out field by
 * field without a flag day, and a partially-migrated prompt never silently loses its checking.
 */
export type Spanned<T> = T | null | EvidenceSpan<T>;

export interface SpannedGuardrails {
  approved_price?: Spanned<number>;
  max_payment?: Spanned<number>;
  max_out_of_pocket?: Spanned<number>;
  rate_range_quoted?: Spanned<string>;
  /** The field G0 skipped entirely — it is a date, not numeric. G1 is where it gets checked. */
  preapproval_date?: Spanned<string>;
}

/**
 * The model's stage signal as emitted. `stage` is a member of
 * `loan_stage` or the literal `none`; `evidence` is the verbatim quote that establishes the stage
 * was REACHED on this call. A non-nullable object in the schema (zero unions), so every key is
 * present and `none` is the "nothing happened" value.
 */
export interface StageSignalRaw {
  stage?: string | null;
  evidence?: string | null;
}

/** A validated stage signal: an enum member with a grounded quote. `none` never gets this far. */
export interface StageSignal {
  stage: string;
  evidence: string;
}

/**
 * The model's next-action object as emitted. `kind` routes the write-back: only a
 * `deliverable` becomes a Task; `contact_client` is the reminder surface's job, `client_action` /
 * `third_party` are `Waiting on`. `due` is `YYYY-MM-DD` or `""` — never an interval, never a
 * default (a guessed date is worse than none). `owner` is the name as spoken.
 */
export interface NextActionRaw {
  kind?: string | null;
  action?: string | null;
  owner?: string | null;
  due?: string | null;
  evidence?: string | null;
}

/** A validated next action. `due` is null when none was stated or the stated one failed the date check. */
export interface NextAction {
  kind: string;
  action: string;
  owner: string;
  due: string | null;
  evidence: string;
  /**
   * True when the evidence quote cleared the span check. Unlike a number, a
   * next_action is synthesised across the call and the model paraphrases it, so an exact-quote miss
   * is almost always a real deliverable with a loose quote — and the Engine only ever files it as a
   * SUGGESTED Task a human accepts. So a span miss no longer drops the action; it keeps it with this
   * flag `false`, and write-back tags the Task `Why` + raises Needs review. `true` on the clean path.
   */
  evidenceVerified: boolean;
}

/** The span-carrying subset of the extraction output. Everything else passes through untouched. */
export interface SpannedExtraction {
  guardrails?: SpannedGuardrails;
  /**
   * Each entry may carry `op` (`add` | `update` | `retire`) and `line` (the
   * number of the current list line it changes). An entry without `op` is an `add` (older callers
   * and fixtures). A `retire` has an empty `value` and still needs its quote.
   */
  key_facts?: (Spanned<string> | KeyFactEntryRaw)[];
  follow_up_date?: Spanned<string>;
  blocker?: Spanned<string>;
  /** The seven qualification fields, one `{field, value, evidence}` entry each. See QUALIFICATION_FIELDS. */
  qualification?: QualificationEntry[];
  /** The stage this call established, with its quote. Absent on older callers/fixtures. */
  stage_signal?: StageSignalRaw | null;
  /** The single next action, typed by owner kind. Absent on older callers/fixtures. */
  next_action?: NextActionRaw | null;
}

/** One raw `key_facts` entry as the op-based schema emits it. */
export interface KeyFactEntryRaw {
  op?: string;
  line?: number | string;
  value?: string | null;
  evidence?: string | null;
}

/** A grounded Key facts operation, ready to apply to the contact's list. */
export interface GroundedKeyFactOp {
  op: 'add' | 'update' | 'retire';
  line: number;
  value: string;
  evidence: string;
}

export interface ExtractionValidationResult {
  /** Flattened to plain values, failures nulled. Same shape write-back already expects. */
  guardrails: Guardrails;
  /**
   * The VALUES of this call's grounded `add`/`update` ops (per-call Notes record). Facts whose span
   * failed are dropped individually — one bad fact does not void the rest.
   */
  key_facts: string[];
  /**
   * Every grounded op in order (add / update / retire), for the contact-level list. An op whose
   * quote failed is not here (it is in `failures`), so the line it aimed at stays as it was.
   */
  key_fact_ops: GroundedKeyFactOp[];
  follow_up_date: string | null;
  blocker: string | null;
  /** Validated + type-coerced qualification values, keyed by field. Absent fields simply omitted. */
  qualification: QualificationValues;
  /**
   * True when a qualification single-select value missed its enum. Threaded into `needsReview` by
   * `validateForWriteback` — an enum miss on `product_fit` in particular changes downstream routing
   * (the honor-call tab, the hygiene page), so it fails closed AND flags, exactly like the
   * structural enums. Grounding/numeric drops do NOT set it (a dropped fact is a blank a human fills).
   */
  qualificationNeedsReview: boolean;
  /**
   * True when a `next_action` or `blocker` survived a quote miss: the value is
   * kept but unverified, so the file routes to Needs review. Distinct from `qualificationNeedsReview`
   * (an enum miss that changes routing) — this is a grounding softness on a load-bearing text field.
   * `validateForWriteback` ORs it into the review decision; write-back gives it its own run-record reason.
   */
  groundingNeedsReview: boolean;
  /**
   * The stage this call established, or null (not emitted, `none`, an unknown stage name, or an
   * ungrounded quote). Write-back decides forward-only / suggest-vs-write; this only decides truth.
   */
  stage_signal: StageSignal | null;
  /**
   * The single next action, or null (not emitted, `none`, blank action, unknown kind, or an
   * ungrounded quote). `due` here is the RAW string; `validateForWriteback` date-checks it.
   */
  next_action: NextAction | null;
  /** Feeds the run record's `validation_failures` field. Empty on a clean run. */
  failures: ValidationFailure[];
  /**
   * Surviving spans keyed by field (`key_facts[1]` for array elements). **Run record only — never
   * the contact record.** G1's value to a human is the quote; if the quote reaches nobody, all
   * that was bought is a stricter drop rule.
   */
  evidence: Record<string, string>;
  /** Every number found in the whole transcript. Diagnostic only. */
  transcriptNumbers: number[];
}

/**
 * Minimum span length, in words.
 *
 * The spec asks for "~15+ words, not fragments" — a four-word quote is checkable but useless to
 * a human deciding whether the attribution is right. ⚠️ **The constant is 12, not 15, and that
 * is a deliberate calibration, not a slip:** the spec's own illustrative span —
 * *"so we'd be looking at about thirty two hundred a month all in"* — is **13 words**. At 15 the
 * check would null the exact example the spec presents as correct, and false drops are the
 * dangerous failure here (a nulled guardrail deletes a feature silently; nobody files a bug,
 * they just stop trusting it). 12 keeps one word of margin under that example while still
 * rejecting fragments. **Retune against real fixtures** — this is a judgement call.
 *
 * RETUNED 12 → 8 against real diarized transcripts. Diarization segments
 * have a MEDIAN of 3–5 words and 60–85% are under 8 words, so a 12-word floor forced the model to
 * stitch quotes across segment boundaries (which the speaker-label bug below then rejected) or to
 * give up on short-but-complete utterances ("I want to keep it under twenty five hundred a month"
 * is ten words). 8 still rejects a bare fragment; the number-inside-the-quote rule is unchanged and
 * is the check that actually stops fabrication. The prompt asks for the same floor.
 */
export const MIN_SPAN_WORDS = 8;

/**
 * Span floor for the TEXT path, deliberately far lower than the 12-word call floor.
 *
 * The 12-word floor above encodes a fact about *spoken* transcripts: a fragment of a 40-minute
 * call is unreviewable without its surrounding sentence. A text thread is the opposite — the
 * whole conversation is a handful of short messages a human reads in seconds, so the
 * reviewability argument that motivates 12 does not apply, while the anti-fabrication guarantee
 * (the evidence must actually appear in the thread, and a numeric value must sit inside its own
 * quote) is UNCHANGED. Holding a text thread to 12 words would silently null the terse-but-real
 * facts the text path exists to capture — "looking to buy near the school", "needs to close by March 15" —
 * which is the exact silent-loss failure the whole module is built to prevent, in the dangerous
 * direction (a dropped fact files no bug; the team just stops trusting the feature).
 *
 * 4 rejects a bare 1–3 word fragment ("March 15", "better rate") while passing a short natural
 * clause. ⚠️ **Retune against real pilot threads**, same judgement-call status as MIN_SPAN_WORDS.
 */
export const TEXT_MIN_SPAN_WORDS = 4;

/**
 * Canonical form for span comparison. Applied to BOTH sides, which is what preserves the
 * guarantee: anything folded away here is folded away in the transcript too, so a passing span
 * still means those words appeared in that order on the call.
 *
 * Builds on `normalizeTranscript()` — there is deliberately no second normaliser. On top of it:
 *
 *  1. 🚩 **Curly quotes and apostrophes → ASCII.** Models emit `’` where speech-to-text writes
 *     `'`. This one difference alone would fail essentially every check, and it fails silently
 *     as `evidence_not_in_transcript`, which looks exactly like a fabricated quote.
 *  2. **Apostrophes are deleted, not spaced**, so `we'd` stays ONE word and the length rule
 *     counts what a human would count.
 *  3. **Punctuation → space, except decimal points.** A model re-quoting a sentence drops a
 *     comma or a dash constantly; that is not a paraphrase and must not read as one. Word order
 *     is what is being verified, and stripping punctuation cannot make a genuine paraphrase
 *     pass — paraphrasing changes words.
 *  4. **`%` is deleted.** Found by the false-drop probe: a transcript reading `"that's 6.875%."`
 *     quoted by the model as `"that's 6.875"` failed as `evidence_not_in_transcript`, because
 *     `6.875%` and `6.875` are different tokens under a word-boundary match. The symbol carries
 *     no verification value — the figure itself is checked separately — so it goes.
 *
 * ⚠️ **Elision is NOT handled and must not be.** A span written `"approved up to four hundred
 * thousand ... at closing"` fails, correctly: it is two quotes, and nothing here can prove the
 * text between them says what the model implies. **The prompt must ask for one contiguous
 * quote** — see the prompt contract in the README.
 */
export function canonicalizeSpan(raw: string): string {
  let t = (raw || '')
    .replace(/[‘’‚‛′]/g, "'") // curly single quotes / prime
    .replace(/[“”„‟″]/g, '"') // curly double quotes
    .replace(/…/g, ' '); // ellipsis

  t = normalizeTranscript(t); // lowercase, dashes, currency, thousands separators, whitespace

  t = t.replace(/['`%]/g, ''); // contractions collapse to one word (we'd -> wed); % is noise
  t = t.replace(/\.(?!\d)/g, ' '); // sentence periods go; decimals (6.875) survive
  t = t.replace(/[^\p{L}\p{N}.\s]/gu, ' '); // any remaining punctuation, any script
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

function countWords(canonical: string): number {
  if (canonical === '') return 0;
  return canonical.split(' ').length;
}

/** Word-boundary-safe containment, so "in rent" does not match "in rental". */
function containsPhrase(haystack: string, needle: string): boolean {
  return (' ' + haystack + ' ').includes(' ' + needle + ' ');
}

type SpanReason = 'evidence_missing' | 'evidence_not_in_transcript' | 'evidence_too_short';

interface SpanCheck {
  /** null when the span is usable. */
  reason: SpanReason | null;
  /** The canonical span — reused as the haystack for the span-scoped numeric check. */
  canonical: string;
}

/**
 * Order matters: missing → too short → not present. A span that is both short and absent is
 * reported as too short, because that is the actionable prompt fix.
 */
function checkSpan(
  evidence: string | null,
  canonicalTranscript: string,
  minSpanWords: number = MIN_SPAN_WORDS,
): SpanCheck {
  const canonical = canonicalizeSpan(evidence || '');
  if (canonical === '') return { reason: 'evidence_missing', canonical };
  if (countWords(canonical) < minSpanWords) return { reason: 'evidence_too_short', canonical };
  if (!containsPhrase(canonicalTranscript, canonical)) {
    return { reason: 'evidence_not_in_transcript', canonical };
  }
  return { reason: null, canonical };
}

interface Unwrapped<T> {
  value: T | null;
  evidence: string | null;
  /** True when the model returned the `{value, evidence}` shape and G1 applies. */
  spanned: boolean;
}

function unwrapSpan<T>(raw: Spanned<T> | undefined): Unwrapped<T> {
  if (raw !== null && typeof raw === 'object') {
    const s = raw as EvidenceSpan<T>;
    return {
      value: s.value === undefined ? null : s.value,
      evidence: s.evidence === undefined ? null : s.evidence,
      spanned: true,
    };
  }
  return { value: raw === undefined ? null : (raw as T | null), evidence: null, spanned: false };
}

/**
 * G1. Run between extraction and write-back (step 5b), in place of `validateGuardrails`
 * once the prompt emits spans — this function does G0's job too for any field that arrives
 * without one.
 *
 * Per span-carrying field, in order:
 *   1. Plausibility band (numeric fields) — a value outside it is wrong whatever quote came with it.
 *   2. Is the quote really in the transcript?
 *   3. Is it long enough for a human to review the attribution?
 *   4. Is the value grounded INSIDE the quote? (numeric fields; tighter than G0's whole-transcript search)
 *   5. Any miss → the field is set to `null` and logged. Never written, never partially written.
 *
 * Date fields (`preapproval_date`, `follow_up_date`) get steps 2–3 only. ⚠️ **That verifies the
 * sentence the date came from exists — not that `"next Friday"` was resolved to the right
 * calendar day.** A misresolved date is misattribution-class and G1 does not catch it.
 *
 * @param extraction Raw extraction output. Unknown keys are ignored, not rejected.
 * @param transcript The REDACTED transcript — the same text sent to the model (step 4b).
 */
/**
 * Validate the `qualification` array (step 5b, called from `validateExtraction`).
 *
 * Every entry is `{field, value, evidence}`. Two axes, applied in order:
 *   1. **Evidence (G1).** The quote must clear the span floor and appear in the transcript, exactly
 *      like `key_facts`. A failed quote drops the entry — a dropped qualification fact is a blank a
 *      human fills, so it does NOT flag review.
 *   2. **Value, by the field's stored type:**
 *        · enum selects (`product_fit` / `occupancy` / `exit_strategy` / `hold_period`) — coerce
 *          case/whitespace then require exact membership. A miss DROPS the value (never written, so
 *          `typecast` cannot mint a junk option) AND flags review — the fail-closed-then-flag rule
 *          the structural enums use, because `product_fit` gates downstream routing.
 *        · `loan_amount` (currency) — parse a number, plausibility-band it, and ground it inside its
 *          own quote, same as the numeric guardrails. Drop on miss; no review flag (a money blank
 *          is filled by hand).
 *        · `second_opinion` (checkbox) — an evidence-grounded entry means "yes"; set true only,
 *          never false (an absent entry leaves the box unticked).
 *        · `next_step` (text) — evidence-grounded free text, passed through.
 *
 * Duplicate fields: last valid entry wins (the model rarely repeats one; overwriting is harmless).
 * Unknown field names are reported, not silently dropped, so a prompt/schema drift is visible.
 */
function validateQualification(
  entries: QualificationEntry[],
  canonicalTranscript: string,
  minSpanWords: number,
): { values: QualificationValues; failures: ValidationFailure[]; evidence: Record<string, string>; needsReview: boolean } {
  const values: QualificationValues = {};
  const failures: ValidationFailure[] = [];
  const evidence: Record<string, string> = {};
  let needsReview = false;

  const isQualField = (f: string): f is QualificationField =>
    (QUALIFICATION_FIELDS as readonly string[]).includes(f);
  const isEnumField = (f: QualificationField): boolean =>
    (QUALIFICATION_ENUM_FIELDS as readonly string[]).includes(f);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const field = String(e.field ?? '').trim();

    if (!isQualField(field)) {
      failures.push({
        field: 'qualification',
        index: i,
        value: field || '(empty)',
        reason: 'unknown_qualification_field',
        candidates: [],
      });
      continue;
    }

    const rawValue = e.value === undefined || e.value === null ? '' : String(e.value).trim();
    if (rawValue === '') continue; // nothing to write — a blank entry is not a failure (key_facts parity)

    // --- G1: the quote must be real ---
    const span = checkSpan(e.evidence ?? null, canonicalTranscript, minSpanWords);
    if (span.reason !== null) {
      failures.push({ field: 'qualification', qualificationField: field, index: i, value: rawValue, reason: span.reason, candidates: [] });
      continue;
    }

    // --- value coercion by stored type ---
    if (isEnumField(field)) {
      const coerced = coerceEnum(rawValue, ENUM_VALUES[field as keyof typeof ENUM_VALUES]);
      if (coerced === null) {
        failures.push({ field: 'qualification', qualificationField: field, index: i, value: rawValue, reason: 'not_a_valid_enum_value', candidates: [] });
        needsReview = true; // fail-closed-then-flag: product_fit et al. drive routing
        continue;
      }
      values[field] = coerced;
    } else if (field === 'loan_amount') {
      const parsed = Number(rawValue.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(parsed) || parsed < LOAN_AMOUNT_RULE.min || parsed > LOAN_AMOUNT_RULE.max) {
        failures.push({ field: 'qualification', qualificationField: field, index: i, value: rawValue, reason: 'implausible_for_field', candidates: [] });
        continue;
      }
      if (!isGrounded(parsed, LOAN_AMOUNT_RULE, extractNumbers(span.canonical))) {
        failures.push({ field: 'qualification', qualificationField: field, index: i, value: rawValue, reason: 'not_grounded_in_transcript', candidates: candidatesFor(parsed, LOAN_AMOUNT_RULE) });
        continue;
      }
      values.loan_amount = parsed;
    } else if (field === 'second_opinion') {
      values.second_opinion = true; // checkbox, set-true-only
    } else {
      values.next_step = rawValue; // free text
    }

    evidence['qualification.' + field] = String(e.evidence);
  }

  return { values, failures, evidence, needsReview };
}

/**
 * Validate the model's `stage_signal`.
 *
 * Returns null — and records why — for anything that is not "a legal stage name with a quote that
 * is really in the transcript". Two rules, same as every span carrier:
 *   1. `stage` must coerce to a `loan_stage` member. `none` / blank is the ordinary no-signal case
 *      and is NOT a failure. An unknown name is dropped and logged (`not_a_valid_enum_value`) but
 *      does NOT flag review — a missed suggestion costs one human click, which is where the file
 *      was anyway.
 *   2. `evidence` must clear the span floor and appear in the transcript. The write-back shows this
 *      quote to the human as the reason to accept, so an ungrounded quote is worse than none.
 *
 * Forward-only and the "does the stage agree with a second detector" gate live in write-back,
 * because they need the record's current stage and the call type; this function knows only truth.
 */
function validateStageSignal(
  raw: StageSignalRaw | null | undefined,
  canonicalTranscript: string,
  minSpanWords: number,
  failures: ValidationFailure[],
  evidence: Record<string, string>,
): StageSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const stageRaw = raw.stage === null || raw.stage === undefined ? '' : String(raw.stage).trim();
  if (stageRaw === '' || stageRaw.toLowerCase() === 'none') return null;

  const stage = coerceEnum(stageRaw, ENUM_VALUES.loan_stage);
  if (stage === null) {
    failures.push({ field: 'stage_signal', value: stageRaw, reason: 'not_a_valid_enum_value', candidates: [] });
    return null;
  }
  const span = checkSpan(raw.evidence ?? null, canonicalTranscript, minSpanWords);
  if (span.reason !== null) {
    failures.push({ field: 'stage_signal', value: stage, reason: span.reason, candidates: [] });
    return null;
  }
  evidence.stage_signal = String(raw.evidence);
  return { stage, evidence: String(raw.evidence) };
}

/** Longest task title the write-back will carry. Longer actions are cut, not dropped. */
export const NEXT_ACTION_MAX_CHARS = 140;

/**
 * Validate the model's `next_action`.
 *
 *   · `kind` must coerce to `next_action_kind`; `none` / blank is the ordinary no-action case.
 *   · `action` must be non-blank (cut at NEXT_ACTION_MAX_CHARS, never dropped for length).
 *   · `evidence` must clear the span floor and appear in the transcript — the quote is what the
 *     task shows the team as "why", and a task with a fabricated why is a duplicate-task failure
 *     with better manners.
 *   · `due` is passed through RAW here; `validateForWriteback` checks it against the call date
 *     (a bad date nulls the DATE, not the task — an undated task is still real work).
 *
 * Whether it becomes a Task (only `deliverable` does) is write-back's call, not truth's.
 */
function validateNextAction(
  raw: NextActionRaw | null | undefined,
  canonicalTranscript: string,
  minSpanWords: number,
  failures: ValidationFailure[],
  evidence: Record<string, string>,
): NextAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const kindRaw = raw.kind === null || raw.kind === undefined ? '' : String(raw.kind).trim();
  if (kindRaw === '' || kindRaw.toLowerCase() === 'none') return null;

  const kind = coerceEnum(kindRaw, ENUM_VALUES.next_action_kind);
  if (kind === null) {
    failures.push({ field: 'next_action', value: kindRaw, reason: 'not_a_valid_enum_value', candidates: [] });
    return null;
  }
  const action = (raw.action === null || raw.action === undefined ? '' : String(raw.action))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NEXT_ACTION_MAX_CHARS);
  if (action === '') return null; // a kind without an action is nothing to do — not a failure

  const owner = (raw.owner === null || raw.owner === undefined ? '' : String(raw.owner)).trim().slice(0, 60);
  const dueRaw = raw.due === null || raw.due === undefined ? '' : String(raw.due).trim();
  const due = dueRaw === '' ? null : dueRaw;

  const span = checkSpan(raw.evidence ?? null, canonicalTranscript, minSpanWords);
  if (span.reason !== null) {
    // DO NOT drop the action on a quote miss. A next_action is a synthesised
    // deliverable the model paraphrases (not an extracted number), the same content already flows
    // through the evidence-exempt crm_note, and the Engine files it only as a *suggested* Task a
    // human accepts — so the risk is already contained. A silent drop would delete a real, owned,
    // dated task. Keep it, mark it unverified (write-back tags the Task `Why` and raises Needs
    // review), and still log the miss so the run record shows what happened.
    failures.push({ field: 'next_action', value: action, reason: span.reason, candidates: [] });
    return { kind, action, owner, due, evidence: String(raw.evidence ?? ''), evidenceVerified: false };
  }
  evidence.next_action = String(raw.evidence);
  return { kind, action, owner, due, evidence: String(raw.evidence), evidenceVerified: true };
}

/**
 * Remove the per-line speaker labels intake puts in front of every dialogue segment
 * (`Agent: …`, `+1XXXXXXXXXX: …`, `Speaker: …`, `Renata: …`) and join the lines with spaces.
 *
 * 🚩 A phone system can deliver a call as hundreds of short segments, and intake renders each as
 * its own labelled line. A verbatim quote that runs across two
 * consecutive segments of the SAME speaker — which is what most quotes of 8+ words are, because the
 * median segment is 3–5 words — therefore never matched the haystack: the transcript read
 * `… the appraisal agent is scheduled …` where the quote read `… the appraisal is scheduled …`.
 * Without this, most spanned facts drop as `evidence_not_in_transcript`, including follow-up dates. The model still SEES the labels (they carry who-said-what);
 * only the haystack the span check searches is label-free.
 *
 * The label pattern is deliberately loose: a leading token of letters/digits/`+`/spaces up to ~40
 * chars followed by `: `. A quote that legitimately starts mid-line is unaffected; a quote that
 * happens to contain `word: ` inside it is canonicalized identically on both sides.
 */
export const SPEAKER_BREAK = 'zzspeakerbreak';

export function stripSpeakerLabels(transcript: string): string {
  const out: string[] = [];
  let prev: string | null = null;
  for (const line of (transcript || '').split('\n')) {
    const m = /^\s*([\p{L}\p{N}+()' .-]{1,40}?):\s+/u.exec(line);
    const who = m ? m[1].trim().toLowerCase() : null;
    const text = m ? line.slice(m[0].length) : line;
    if (!text.trim()) continue;
    // A CHANGE of speaker is still a hard wall — a quote must never be stitched across two
    // people (that is the R-07 "SSN fragment grounds a payment" trap). The sentinel survives
    // canonicalization (letters only) and can never occur inside a genuine quote. Same-speaker
    // lines (the old one-line-per-segment shape, or a manual paste) just join.
    if (prev !== null && who !== null && who !== prev) out.push(SPEAKER_BREAK);
    out.push(text);
    if (who !== null) prev = who;
  }
  return out.join(' ');
}

export function validateExtraction(
  extraction: SpannedExtraction,
  transcript: string,
  minSpanWords: number = MIN_SPAN_WORDS,
): ExtractionValidationResult {
  const normalized = normalizeTranscript(transcript);
  const numbers = extractNumbers(normalized);
  const canonicalTranscript = canonicalizeSpan(stripSpeakerLabels(transcript));

  const failures: ValidationFailure[] = [];
  const evidence: Record<string, string> = {};
  const guardrailsIn: SpannedGuardrails = extraction.guardrails || {};
  const cleaned: Guardrails = {};

  // --- numeric guardrails ---------------------------------------------------
  const scalarFields: GuardrailKey[] = ['approved_price', 'max_payment', 'max_out_of_pocket'];

  for (const field of scalarFields) {
    if (!(field in guardrailsIn)) continue;

    const got = unwrapSpan<number>(guardrailsIn[field]);
    if (got.value === null) {
      cleaned[field] = null; // null + null evidence is the "not discussed" shape, not a failure
      continue;
    }

    const rule = FIELD_RULES[field];
    const value = got.value;

    const implausible = plausibilityFailure(field, value, rule);
    if (implausible) {
      cleaned[field] = null;
      failures.push(implausible);
      continue;
    }

    // No span emitted for this field → G0 fallback against the whole transcript.
    if (!got.spanned) {
      if (isGrounded(value, rule, numbers)) {
        cleaned[field] = value;
      } else {
        cleaned[field] = null;
        failures.push({ field, value, reason: 'not_grounded_in_transcript', candidates: candidatesFor(value, rule) });
      }
      continue;
    }

    const span = checkSpan(got.evidence, canonicalTranscript, minSpanWords);
    if (span.reason !== null) {
      cleaned[field] = null;
      failures.push({ field, value, reason: span.reason, candidates: candidatesFor(value, rule) });
      continue;
    }

    // The upgrade over G0: the number must appear in the quoted sentence, not merely somewhere.
    if (!isGrounded(value, rule, extractNumbers(span.canonical))) {
      cleaned[field] = null;
      failures.push({ field, value, reason: 'not_grounded_in_transcript', candidates: candidatesFor(value, rule) });
      continue;
    }

    cleaned[field] = value;
    evidence[field] = got.evidence as string;
  }

  // --- rate_range_quoted ----------------------------------------------------
  // A string carrying one or two bounds. A partially-wrong range cannot be safely repaired, so
  // if ANY bound fails the whole field drops — same rule as G0.
  if ('rate_range_quoted' in guardrailsIn) {
    const got = unwrapSpan<string>(guardrailsIn.rate_range_quoted);
    const raw = got.value === null ? '' : String(got.value);

    if (raw.trim() === '') {
      cleaned.rate_range_quoted = null;
    } else {
      const rule = FIELD_RULES.rate_range_quoted;
      const bounds = parseRateBounds(raw);

      if (bounds.length === 0) {
        cleaned.rate_range_quoted = null;
        failures.push({ field: 'rate_range_quoted', value: raw, reason: 'implausible_for_field', candidates: [] });
      } else {
        const span = got.spanned ? checkSpan(got.evidence, canonicalTranscript, minSpanWords) : null;

        if (span !== null && span.reason !== null) {
          cleaned.rate_range_quoted = null;
          failures.push({ field: 'rate_range_quoted', value: raw, reason: span.reason, candidates: bounds });
        } else {
          const haystack = span === null ? numbers : extractNumbers(span.canonical);
          let dropped = false;

          for (const bound of bounds) {
            const implausible = bound < rule.min || bound > rule.max;
            if (implausible || !isGrounded(bound, rule, haystack)) {
              cleaned.rate_range_quoted = null;
              failures.push({
                field: 'rate_range_quoted',
                value: raw,
                bound,
                reason: implausible ? 'implausible_for_field' : 'not_grounded_in_transcript',
                candidates: candidatesFor(bound, rule),
              });
              dropped = true;
              break; // one bad bound drops the field; no need to report the rest
            }
          }

          if (!dropped) {
            cleaned.rate_range_quoted = raw;
            if (got.evidence !== null) evidence.rate_range_quoted = got.evidence;
          }
        }
      }
    }
  }

  // --- text and date fields (span check only) -------------------------------
  const checkTextField = (
    field: SpanFieldKey,
    raw: Spanned<string> | undefined,
    present: boolean,
  ): string | null => {
    if (!present) return null;

    const got = unwrapSpan<string>(raw);
    if (got.value === null || String(got.value).trim() === '') return null;

    const value = String(got.value);
    if (!got.spanned) return value; // no span emitted → nothing G1 can check; pass through

    const span = checkSpan(got.evidence, canonicalTranscript, minSpanWords);
    if (span.reason !== null) {
      failures.push({ field, value, reason: span.reason, candidates: [] });
      return null;
    }

    evidence[field] = got.evidence as string;
    return value;
  };

  if ('preapproval_date' in guardrailsIn) {
    cleaned.preapproval_date = checkTextField('preapproval_date', guardrailsIn.preapproval_date, true);
  }

  const followUpDate = checkTextField(
    'follow_up_date',
    extraction.follow_up_date,
    'follow_up_date' in extraction,
  );

  // The blocker gets the same keep-and-flag treatment as next_action, and for the
  // same reason — it is synthesised across the call and paraphrased, the identical text already flows
  // through the evidence-exempt crm_note, and a silent drop empties the `Blocker` field on a genuinely
  // stuck file (a WORSE signal than an unverified one). So
  // a span miss keeps the blocker and raises `groundingNeedsReview`; numbers, dates and key_facts keep
  // strict-drop (a fabricated figure is dangerous, key_facts drops are low-stakes and high-volume).
  let groundingNeedsReview = false;
  let blocker: string | null = null;
  if ('blocker' in extraction) {
    const got = unwrapSpan<string>(extraction.blocker);
    if (got.value !== null && String(got.value).trim() !== '') {
      const value = String(got.value);
      if (!got.spanned) {
        blocker = value; // no span emitted → nothing G1 can check; pass through, unchanged behaviour
      } else {
        const span = checkSpan(got.evidence, canonicalTranscript, minSpanWords);
        if (span.reason !== null) {
          failures.push({ field: 'blocker', value, reason: span.reason, candidates: [] });
          blocker = value; // keep it
          groundingNeedsReview = true; // but flag the file for a human
        } else {
          evidence.blocker = got.evidence as string;
          blocker = value;
        }
      }
    }
  }

  // --- key_facts ------------------------------------------------------------
  // Each fact is independently sourced, so a fabricated one is dropped on its own rather than
  // voiding the list. The index goes in the failure so the run record names which fact failed.
  // The same quote rule now guards every Key facts OP. An `update` or `retire`
  // with no verbatim quote from this call changes nothing — the line it aimed at stays.
  const keyFacts: string[] = [];
  const keyFactOps: GroundedKeyFactOp[] = [];
  const factsIn = extraction.key_facts || [];

  for (let i = 0; i < factsIn.length; i++) {
    const raw = factsIn[i] as KeyFactEntryRaw | Spanned<string>;
    const opRaw = raw !== null && typeof raw === 'object' && 'op' in raw ? String((raw as KeyFactEntryRaw).op || '').trim().toLowerCase() : 'add';
    const op: GroundedKeyFactOp['op'] = opRaw === 'update' || opRaw === 'retire' ? opRaw : 'add';
    const line = raw !== null && typeof raw === 'object' && 'line' in raw ? Number((raw as KeyFactEntryRaw).line) || 0 : 0;
    const got = unwrapSpan<string>(raw as Spanned<string>);
    const value = got.value === null ? '' : String(got.value).trim();
    if (op !== 'retire' && value === '') continue;

    if (!got.spanned) {
      // No span emitted → nothing G1 can check. Adds pass through (unchanged behaviour); a change to
      // an existing line is never made on an unquoted say-so.
      if (op === 'add') { keyFacts.push(value); keyFactOps.push({ op, line: 0, value, evidence: '' }); }
      else failures.push({ field: 'key_facts', index: i, value: `${op} ${line}`, reason: 'evidence_missing', candidates: [] });
      continue;
    }

    const span = checkSpan(got.evidence, canonicalTranscript, minSpanWords);
    if (span.reason !== null) {
      failures.push({ field: 'key_facts', index: i, value: op === 'add' ? value : `${op} ${line}: ${value}`, reason: span.reason, candidates: [] });
      continue;
    }

    evidence['key_facts[' + i + ']'] = got.evidence as string;
    if (op !== 'retire') keyFacts.push(value);
    keyFactOps.push({ op, line, value, evidence: got.evidence as string });
  }

  // --- qualification --------------------------------------------------------
  // Lift the two encoded signals out first (grammar budget — see schema.ts): the
  // LAST entry of each wins, and they never reach validateQualification's free-text branch. The
  // object form (`extraction.stage_signal` / `extraction.next_action`) is still accepted for
  // callers/tests that use it; the array form wins when both are present.
  const qualIn = extraction.qualification || [];
  let stageRaw: StageSignalRaw | null | undefined = extraction.stage_signal;
  let nextRaw: NextActionRaw | null | undefined = extraction.next_action;
  const qualRest: QualificationEntry[] = [];
  for (const e of qualIn) {
    const field = String((e && e.field) ?? '').trim();
    if (field === 'stage_reached') stageRaw = { stage: e.value ?? '', evidence: e.evidence ?? '' };
    else if (field === 'next_action') nextRaw = decodeNextActionValue(String(e.value ?? ''), e.evidence);
    else qualRest.push(e);
  }
  const qual = validateQualification(qualRest, canonicalTranscript, minSpanWords);
  for (const f of qual.failures) failures.push(f);
  Object.assign(evidence, qual.evidence);

  // --- stage signal + next action --------------------------------------------
  const stageSignal = validateStageSignal(stageRaw, canonicalTranscript, minSpanWords, failures, evidence);
  const nextAction = validateNextAction(nextRaw, canonicalTranscript, minSpanWords, failures, evidence);
  // A next_action kept despite a quote miss flags the file, same as an unverified blocker.
  if (nextAction && !nextAction.evidenceVerified) groundingNeedsReview = true;

  return {
    guardrails: cleaned,
    key_facts: keyFacts,
    key_fact_ops: keyFactOps,
    follow_up_date: followUpDate,
    blocker,
    qualification: qual.values,
    qualificationNeedsReview: qual.needsReview,
    groundingNeedsReview,
    stage_signal: stageSignal,
    next_action: nextAction,
    failures,
    evidence,
    transcriptNumbers: [...new Set(numbers)].sort((a, b) => a - b),
  };
}

// ===========================================================================
// Structural validation — enum compliance and date sanity
//
// ⚠️ NAMING: this is NOT "G2". G0–G3 are the grounding ladder, and G2 already means
// "split into two API calls for native citations".
// This is a different axis and gets no tier letter — the spec already warns that two
// competing tier scales in one document is a defect waiting to happen.
//
//   Grounding  asks: was this value actually said on the call?
//   Structural asks: is this a legal value for the field it is about to be written to?
//
// A value can pass one and fail the other in both directions. `"high"` for urgency_flag is
// perfectly reasonable English that no automation can match on. `"2026-02-30"` can arrive
// with a genuine verbatim span and still not exist.
//
// WHY THIS EXISTS — THE FAILURE IT PREVENTS
// -----------------------------------------
// The spec is explicit that the enums are load-bearing, not stylistic: "automation rules fire
// on a field's type and state, never on its content." Three things hang off `urgency_flag`
// alone — the push alert to the assistant and processor, the "Urgency assessed"
// Tier-1 checklist item, and the daily-view triage. A novel string written into that
// single-select either 422s the write or, with typecast on, creates a junk select option that
// matches no rule. **Either way the rush alert silently never fires.** That is the exact
// failure mode this whole module exists to prevent, on a field G0/G1 never looked at, because
// G0/G1 only ever examined numbers and quotes.
//
// Expected fire rate is low, same as G0 — and the justification is the same asymmetry. A
// dropped urgency flag is a record someone triages by hand. A rush call that never alerts is
// the failure this system exists to stop.
//
// FAIL CLOSED, THEN FLAG — THE ONE PLACE THIS DIVERGES FROM G0/G1
// ---------------------------------------------------------------
// A dropped guardrail is a blank someone fills in, so G0/G1 null it and say nothing. A dropped
// ENUM is different: nulling `urgency_flag` also means no alert and an incomplete checklist
// item, and nulling `follow_up_date` discards a promise the client actually made — the exact
// "value is in the tail" case that is the point of the system.
//
// So structural failures null the field AND set `needsReview`, which the caller ORs with the existing
// `confidence < 0.6` rule to route the record to the **existing** "Needs review" view. No new
// surface, no new field on the contact record, no validation state for the team to reason
// about — the same routing that already exists, reached by one more path.
// ===========================================================================

/**
 * The frozen enums.
 *
 * 🚩 schema.ts imports FROM HERE — the rule is that each enum lives in exactly one place, and
 * this is the only executable copy.
 */
export const ENUM_VALUES = {
  urgency_flag: ['none', 'normal', 'rush', 'critical'],
  waiting_on: ['client', 'lender', 'realtor', 'third-party', 'nothing'],
  language: ['en', 'es'],
  /**
   * What the call was ABOUT, so write-back can stop treating an
   * underwriting manager, a peer LO or a personal friend as a borrower: no drafts, no coaching,
   * no guardrails, no qualification for anything but `client`. Also seeds the contact's type
   * when the record has none.
   * `listing_agent`: the agent on the SELLER's side of a client's deal
   * (verifying a pre-approval, chasing an approval letter or a closing date). Seeds a suggested type of
   * listing agent; otherwise treated exactly like `partner` (note, key facts, a deliverable task).
   */
  call_purpose: ['client', 'partner', 'listing_agent', 'internal', 'personal', 'other'],
  /**
   * Lets the engine CLEAR a blocker the call resolved. Before this the
   * blocker could only ever be set (skip-null), so "waiting on CPA" survived the call where the CPA
   * letter arrived. `resolved` clears the field; `new`/`unchanged` write/keep; `none` = no blocker
   * was discussed either way.
   */
  blocker_status: ['new', 'unchanged', 'resolved', 'none'],
  /**
   * Who owns the single next action from the call. Only
   * `deliverable` (a team member does a piece of non-call work: send, prepare, confirm, run numbers)
   * becomes a Task. `contact_client` (a team follow-up call/text) is the reminder surface's job and
   * must NEVER become a task — that would duplicate the reminder. `client_action` / `third_party` are
   * `Waiting on` territory. `none` = no next action was agreed.
   */
  next_action_kind: ['deliverable', 'contact_client', 'client_action', 'third_party', 'none'],
  /**
   * ⚠️ Capitalized, unlike the other enums — the canonical spelling IS the store's choice
   * spelling, preserving the boundary rule that no case mapping happens at write-back.
   * `coerceEnum` folds case, so a model emitting "call" still lands on "Call".
   * The prompt's rule: populate ONLY when the client states a preference on the call —
   * never inferred from the channel the call itself came in on.
   */
  preferred_contact_method: ['Call', 'Text', 'Email', 'WhatsApp'],
  /**
   * ⚠️ The pipeline stages, in the team's own vocabulary (Documents & Review is the internal
   * review stage). This list MUST match the store's stage options exactly, in name and spelling.
   *
   * **`loan_stage` is NOT in the step 5 output schema.** The acceptance gate demands frozen-enum
   * compliance from a field the documented schema never asks the model to emit. Validated here
   * if present, ignored if absent, so whichever way that is resolved this code is already correct.
   */
  loan_stage: [
    'Inquiry',
    'Qualified Opportunity',
    'App Completed',
    'Documents & Review',
    'Pre-Approved',
    'Under Contract',
    'Processing',
    'Closed',
  ],
  /**
   * ── Qualification single-selects ───────────────────────────────────────────────────────────
   * The four enum-typed members of the `qualification` array (§ validateQualification). Each MUST
   * match the store's single-select EXACTLY — name, spelling, and the em-dash / en-dash bytes —
   * because a store that typecasts would silently mint a junk option for a value that misses.
   */
  occupancy: ['Primary residence', 'Second home', 'Investment'],
  product_fit: [
    'Standard residential',
    'Not offered — fix & flip',
    'Not offered — hard money',
    'Not offered — bridge',
    'Not offered — commercial',
    'Not offered — other',
    'Unclear',
  ],
  exit_strategy: ['Buy & hold', 'Fix & flip', 'BRRRR', 'Short-term rental', 'Unsure'],
  hold_period: ['Under 1 year', '1–3 years', '3+ years', 'Unsure'],
} as const;

export type EnumFieldKey = keyof typeof ENUM_VALUES;

/**
 * ── Qualification array ────────────────────────────────────────────────────────────────────────
 * The seven extracted qualification fields, carried as ONE array of `{field, value, evidence}`
 * entries rather than seven top-level `{value, evidence}` fields. That shape is deliberate: the
 * structured-outputs schema has a hard ceiling of 16 union-typed parameters (see schema.ts), we
 * were at 12, and seven evidence pairs would have hit 19 and 400'd every call. An array of objects
 * is ZERO unions and scales without ever touching the ceiling again — the same trick `key_facts`
 * already uses. `validateQualification` grounds each entry's evidence and coerces its value to the
 * field's stored type; write-back plucks the surviving values by name.
 *
 * QUALIFICATION_FIELDS is the single source of truth for the `field` enum — schema.ts imports it,
 * so a field added here moves the schema, the validator and write-back together.
 */
export const QUALIFICATION_FIELDS = [
  'next_step',
  'product_fit',
  'occupancy',
  'exit_strategy',
  'hold_period',
  'loan_amount',
  'second_opinion',
  /**
   * The stage signal and the typed next action ride in this array (see schema.ts on
   * the compiled-grammar budget). `validateExtraction` LIFTS both out before `validateQualification`
   * runs, so they never reach the free-text branch. Value encodings:
   *   `stage_reached` → `"<Stage name>"`
   *   `next_action`   → `"<kind> | <owner> | <due YYYY-MM-DD or -> | <action>"`
   */
  'stage_reached',
  'next_action',
] as const;

/** The two qualification members that are lifted into `stage_signal` / `next_action` (schema.ts). */
export const LIFTED_QUALIFICATION_FIELDS = ['stage_reached', 'next_action'] as const;

/**
 * Decode the pipe-encoded `next_action` qualification value into the object shape the validator
 * expects. `"deliverable | Priya | 2026-09-15 | Send scenarios email"` →
 * `{kind, owner, due, action}`. A `-`, `none` or blank due is "not stated". Extra pipes in the
 * action are kept (only the first three separators split). Exported for tests.
 */
export function decodeNextActionValue(value: string, evidence: string | null | undefined): NextActionRaw {
  const parts = String(value ?? '').split('|');
  const kind = (parts[0] ?? '').trim();
  const owner = (parts[1] ?? '').trim();
  const dueRaw = (parts[2] ?? '').trim();
  const action = parts.slice(3).join('|').trim();
  const due = /^(-|none|n\/a|tbd)?$/i.test(dueRaw) ? '' : dueRaw;
  return { kind, owner, due, action, evidence: evidence ?? '' };
}

export type QualificationField = (typeof QUALIFICATION_FIELDS)[number];

/** The four qualification fields whose values are single-select enums (coerced + membership-checked). */
export const QUALIFICATION_ENUM_FIELDS = ['product_fit', 'occupancy', 'exit_strategy', 'hold_period'] as const;

/**
 * The enum members `validateStructure` owns — the STRUCTURAL axis. Deliberately NOT all of
 * ENUM_VALUES: the qualification selects (product_fit / occupancy / exit_strategy / hold_period) are
 * validated by `validateQualification` instead, so structural validation must not iterate them (it
 * would return them absent). Exported so the structural-enum test iterates exactly this set.
 */
export const STRUCTURAL_ENUM_FIELDS = [
  'urgency_flag',
  'waiting_on',
  'language',
  'loan_stage',
  'preferred_contact_method',
] as const;

/** One raw entry as the model emits it. All three keys are required by the schema. */
export interface QualificationEntry {
  field?: string;
  value?: string;
  evidence?: string;
}

/**
 * The validated, type-coerced qualification values, keyed by field. Only fields that SURVIVED
 * validation are present; a dropped or absent field is simply missing (the skip-null rule at
 * write-back turns that into "leave the stored field alone"). Types match the stored columns:
 * `Loan amount` currency → number, `Second opinion` checkbox → true-only, the rest strings.
 */
export interface QualificationValues {
  next_step?: string | null;
  product_fit?: string | null;
  occupancy?: string | null;
  exit_strategy?: string | null;
  hold_period?: string | null;
  loan_amount?: number | null;
  second_opinion?: boolean | null;
}

/**
 * Plausibility band for `loan_amount`. Wider than `approved_price`: this is the loan itself, which
 * runs from a small second/HELOC up to a jumbo, and — unlike a guardrail — a false drop here only
 * loses an informational figure, so the band errs generous. Grounded against its own evidence span
 * exactly like the numeric guardrails (the number must appear inside the quote, not merely somewhere).
 */
const LOAN_AMOUNT_RULE: FieldRule = { min: 10_000, max: 30_000_000, shorthandDivisors: [1000], isRate: false };

/**
 * Upper bound on how far ahead a follow-up may be scheduled.
 *
 * Generous on purpose. "Call me after the holidays" and "we'll revisit when my lease is up" are
 * both real mortgage follow-ups, and pre-approvals routinely get revisited a year out. This
 * catches century typos and misparsed years, not long horizons — a false drop here deletes a
 * captured promise, which is the dangerous direction.
 */
export const MAX_FOLLOW_UP_DAYS = 400;

/**
 * How far back a pre-approval date may plausibly sit. They expire in ~90 days, so anything
 * older is being quoted as history rather than as this file's live pre-approval.
 */
export const MAX_PREAPPROVAL_AGE_DAYS = 730;

/**
 * 🚩 DELIBERATELY NOT CHECKED: whether a follow-up date lands on a weekend.
 *
 * It was the obvious third rule and it is wrong. A team may text and call on Saturdays, and
 * an assistant's job can be chasing people who are only reachable outside working hours. Nulling a
 * valid Saturday follow-up would delete a real promise to enforce an office convention the
 * team does not keep. Same principle as MIN_SPAN_WORDS: false drops are the dangerous
 * direction, so a rule that cannot distinguish "wrong" from "unusual" does not belong here.
 */

export interface StructuralFields {
  urgency_flag?: string | null;
  waiting_on?: string | null;
  language?: string | null;
  loan_stage?: string | null;
  preferred_contact_method?: string | null;
  follow_up_date?: string | null;
  preapproval_date?: string | null;
}

export interface StructuralValidationResult {
  /** Cleaned values, failures nulled. Safe to write. Only keys present on input are returned. */
  fields: StructuralFields;
  /** Feeds the run record's `validation_failures` field, same as G0/G1. Empty on a clean run. */
  failures: ValidationFailure[];
  /**
   * True if anything failed. The caller ORs this with `confidence < 0.6` to route the record to the
   * existing "Needs review" view — see the header note on why this diverges from G0/G1.
   */
  needsReview: boolean;
}

/**
 * Case and whitespace repair, applied BEFORE the enum is judged.
 *
 * `"Rush"`, `" rush "` and `"RUSH"` are formatting, not fabrication, and coercing them is
 * deterministic — the value maps to exactly one legal member by an exact match after folding.
 * This is the same recall-over-precision call the spoken-numeral parser makes.
 *
 * ⚠️ **It stops there, and that boundary is the point.** `"high"` → `rush` would be a guess
 * about what the model meant, i.e. a probabilistic step smuggled into the validator that is
 * supposed to be the deterministic gate in front of the write. Underscores and hyphens are
 * folded together for `third-party` only because both spellings denote one member; nothing
 * here reaches across members.
 */
function coerceEnum(raw: string, allowed: readonly string[]): string | null {
  // Fold case, and treat en-dash/em-dash/hyphen and runs of space/underscore as one join char.
  // The dash-folding exists for the qualification selects, whose canonical labels
  // carry em/en dashes ("Not offered — fix & flip", "1–3 years") that a model rarely reproduces
  // byte-for-byte — and a silent enum miss there both drops the value AND flags review, the exact
  // false-drop this module treats as the dangerous direction. It cannot cross members: no two legal
  // choices differ only by a dash/space, so nothing new collides. `&` vs `and` is deliberately NOT
  // folded (too aggressive) — the prompt hands the model the label's own `&`.
  const fold = (s: string) =>
    s.trim().toLowerCase().replace(/[–—]/g, '-').replace(/[_\s-]+/g, '-');
  const target = fold(raw);
  for (const value of allowed) {
    if (fold(value) === target) return value;
  }
  return null;
}

/** Days between two UTC midnights. Whole days, so a same-day follow-up is 0, not -0.4. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Strict `YYYY-MM-DD` parse. Returns null for anything else.
 *
 * `Date.parse` is deliberately not used: it accepts `"next Friday"`-adjacent junk in some
 * runtimes, silently rolls `2026-02-30` over to March 2nd, and reads bare dates as UTC but
 * dated strings as local. Round-tripping the components back out is what rejects a rollover.
 */
function parseIsoDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null; // 2026-02-30 rolled over
  }
  return d;
}

/**
 * Structural validation. Run between extraction and write-back (step 5b), alongside
 * `validateExtraction` — see `validateForWriteback` for the combined entry point.
 *
 * Per field:
 *   - enums     → coerce case/whitespace, then require exact membership. Miss → null + review.
 *   - dates     → strict YYYY-MM-DD, then a plausibility window. Miss → null + review.
 *
 * Absent keys are ignored, not defaulted. A `null` value is "not extracted", which is a legal
 * outcome and never a failure — identical to how G0 treats a null guardrail.
 *
 * @param fields     The enum and date fields from the extraction output.
 * @param callDate   ⚠️ **The call timestamp, not "now".** A live call processes minutes after
 *                   hangup, but a batch sweep or a manual ingest can run well after the
 *                   conversation. Judging "is this follow-up in the past?" against wall-clock
 *                   time would null valid same-day follow-ups on a backfilled transcript.
 *                   Defaults to now only so a bare call in a test or a REPL still works.
 */
export function validateStructure(
  fields: StructuralFields,
  callDate: Date = new Date(),
): StructuralValidationResult {
  const cleaned: StructuralFields = {};
  const failures: ValidationFailure[] = [];

  // Compare against the call's UTC midnight so a same-day follow-up is never "in the past".
  const callDay = new Date(
    Date.UTC(callDate.getUTCFullYear(), callDate.getUTCMonth(), callDate.getUTCDate()),
  );

  // --- enums ----------------------------------------------------------------
  const enumFields: EnumFieldKey[] = [...STRUCTURAL_ENUM_FIELDS];

  for (const field of enumFields) {
    if (!(field in fields)) continue;

    const raw = fields[field];
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      cleaned[field] = null;
      continue;
    }

    const coerced = coerceEnum(String(raw), ENUM_VALUES[field]);
    if (coerced === null) {
      cleaned[field] = null;
      failures.push({ field, value: String(raw), reason: 'not_a_valid_enum_value', candidates: [] });
      continue;
    }
    cleaned[field] = coerced;
  }

  // --- dates ----------------------------------------------------------------
  const checkDate = (
    field: 'follow_up_date' | 'preapproval_date',
    raw: string | null | undefined,
  ): void => {
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      cleaned[field] = null;
      return;
    }

    const value = String(raw);
    const parsed = parseIsoDate(value);
    if (parsed === null) {
      cleaned[field] = null;
      failures.push({ field, value, reason: 'not_a_valid_date', candidates: [] });
      return;
    }

    const delta = daysBetween(callDay, parsed);

    if (field === 'follow_up_date') {
      // You cannot schedule a follow-up before the conversation that produced it.
      if (delta < 0) {
        cleaned[field] = null;
        failures.push({ field, value, reason: 'date_before_call', candidates: [] });
        return;
      }
      if (delta > MAX_FOLLOW_UP_DAYS) {
        cleaned[field] = null;
        failures.push({ field, value, reason: 'date_implausibly_far', candidates: [] });
        return;
      }
    } else {
      // A pre-approval is issued, never scheduled. A future date means the model captured an
      // intention ("we'll get you pre-approved Friday") as an accomplished fact.
      if (delta > 0) {
        cleaned[field] = null;
        failures.push({ field, value, reason: 'date_in_future', candidates: [] });
        return;
      }
      if (-delta > MAX_PREAPPROVAL_AGE_DAYS) {
        cleaned[field] = null;
        failures.push({ field, value, reason: 'date_implausibly_far', candidates: [] });
        return;
      }
    }

    cleaned[field] = value;
  };

  if ('follow_up_date' in fields) checkDate('follow_up_date', fields.follow_up_date);
  if ('preapproval_date' in fields) checkDate('preapproval_date', fields.preapproval_date);

  return { fields: cleaned, failures, needsReview: failures.length > 0 };
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

export interface WritebackValidationResult extends ExtractionValidationResult {
  /** Enum fields, coerced and validated. Failures nulled. */
  structural: StructuralFields;
  /** The realtor-safe update line, or null when absent / rejected. See validateRealtorUpdate. */
  realtor_update: string | null;
  /** True if any structural check failed. OR with `confidence < 0.6` to route to Needs review. */
  needsReview: boolean;
}

/**
 * **The single call step 5b should make.** Runs grounding (G0/G1) and structural validation
 * over one extraction and merges both failure lists into the one the run record consumes.
 *
 * Order matters, and only in one place: `follow_up_date` and `preapproval_date` are checked by
 * BOTH passes. Grounding runs first and can null a date whose quote was fabricated; structural
 * then re-checks whatever survived, so a date that is both ungrounded and malformed reports the
 * grounding failure and is not double-nulled or double-logged.
 *
 * @param extraction The extraction output. Span-carrying fields may be bare or `{value, evidence}`.
 * @param transcript The REDACTED transcript — the same text sent to the model (step 4b).
 * @param callDate   The call timestamp. See `validateStructure` on why this is not "now".
 */
// ---------------------------------------------------------------------------
// Realtor update — the one free-text field a THIRD PARTY reads
// ---------------------------------------------------------------------------

/** Longest `realtor_update` accepted. One or two sentences; anything longer is not the field's job. */
export const REALTOR_UPDATE_MAX_CHARS = 400;

/**
 * Words that never belong in a line a listing agent reads. Any digit, currency or percent sign is
 * rejected outright; these words are rejected as whole words (case-insensitive). The list is
 * deliberately broad on the credit/income side and narrow on process words: "documents are in"
 * and "pre-approved" are what a realtor legitimately hears; "credit", "income", "payment" are not.
 * Stage words (approved, contract, closing) and neutral process nouns stay allowed.
 */
export const REALTOR_UPDATE_BLOCKLIST: readonly string[] = [
  'credit', 'fico', 'score', 'income', 'salary', 'wage', 'wages', 'debt', 'debts', 'dti', 'ratio',
  'payment', 'payments', 'rate', 'rates', 'apr', 'points', 'cash', 'assets', 'savings', 'reserves',
  'down', 'bankruptcy', 'bankrupt', 'foreclosure', 'collection', 'collections', 'delinquent',
  'delinquency', 'late', 'default', 'garnishment', 'lien', 'liens', 'judgment', 'judgement',
  'ssn', 'social', 'w2', 'w-2', '1099', 'paystub', 'paystubs', 'divorce', 'child support', 'alimony',
  'immigration', 'itin', 'visa', 'pregnant', 'medical', 'disability', 'unemployed', 'fired', 'laid',
];

const REALTOR_UPDATE_BLOCK_RE = new RegExp(
  '(^|[^a-z])(' + REALTOR_UPDATE_BLOCKLIST.map((w) => w.replace(/[-]/g, '\-')).join('|') + ')(?=$|[^a-z])',
  'i',
);

/**
 * Gate the model's `realtor_update` before it can reach a realtor. Structural, deterministic, and
 * conservative in the SAFE direction: a rejected line is dropped (the partner digest says "no update
 * yet" for that client) and logged; it is never rewritten. `""` / null = not provided, no failure.
 * The same rule the partner-digest prompt enforces by instruction is enforced here by code —
 * omission beats instruction.
 */
export function validateRealtorUpdate(raw: unknown): { value: string | null; failure: ValidationFailure | null } {
  if (raw === null || raw === undefined) return { value: null, failure: null };
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return { value: null, failure: null };
  const fail = (): { value: null; failure: ValidationFailure } => ({
    value: null,
    failure: { field: 'realtor_update', value: text.slice(0, 120), reason: 'realtor_update_unsafe', candidates: [] },
  });
  if (text.length > REALTOR_UPDATE_MAX_CHARS) return fail();
  if (/[0-9$%€£]/.test(text)) return fail();
  if (REALTOR_UPDATE_BLOCK_RE.test(text)) return fail();
  if (SSN_LIKE.test(text)) return fail();
  return { value: text, failure: null };
}
/** Any spelled-out or partial identifier pattern the digit rule would miss ("four one two"). */
const SSN_LIKE = /\b(social security|account number|routing)\b/i;

export function validateForWriteback(
  extraction: SpannedExtraction & StructuralFields & { realtor_update?: unknown },
  transcript: string,
  callDate: Date = new Date(),
  minSpanWords: number = MIN_SPAN_WORDS,
): WritebackValidationResult {
  const grounded = validateExtraction(extraction, transcript, minSpanWords);

  // Feed the grounding pass's surviving dates forward — a date already nulled for a bad quote
  // must not be re-reported as a bad date.
  const structuralInput: StructuralFields = {};
  for (const field of [
    'urgency_flag',
    'waiting_on',
    'language',
    'loan_stage',
    'preferred_contact_method',
  ] as const) {
    if (field in extraction) structuralInput[field] = extraction[field];
  }
  if ('follow_up_date' in extraction) structuralInput.follow_up_date = grounded.follow_up_date;
  if ('preapproval_date' in (extraction.guardrails || {})) {
    structuralInput.preapproval_date = grounded.guardrails.preapproval_date ?? null;
  }

  const structure = validateStructure(structuralInput, callDate);

  // 🚩 `??` is wrong here and was wrong in the first draft of this function: a structurally
  // rejected date is `null`, and `null ?? grounded.value` would put the rejected value straight
  // back. Presence of the KEY decides which pass is authoritative, never the value's truthiness.
  const guardrails: Guardrails = { ...grounded.guardrails };
  if ('preapproval_date' in structure.fields) {
    guardrails.preapproval_date = structure.fields.preapproval_date ?? null;
  }

  const followUpDate =
    'follow_up_date' in structure.fields
      ? (structure.fields.follow_up_date ?? null)
      : grounded.follow_up_date;

  // Next-action due date: same rules as follow_up_date — a real date, on or after the
  // call, not absurdly far. A bad date nulls the DATE only; the action itself is still a task.
  const dueFailures: ValidationFailure[] = [];
  let nextAction = grounded.next_action;
  if (nextAction && nextAction.due !== null) {
    const parsed = parseIsoDate(nextAction.due);
    const callDay = new Date(Date.UTC(callDate.getUTCFullYear(), callDate.getUTCMonth(), callDate.getUTCDate()));
    let reason: ValidationFailure['reason'] | null = null;
    if (parsed === null) reason = 'not_a_valid_date';
    else {
      const delta = daysBetween(callDay, parsed);
      if (delta < 0) reason = 'date_before_call';
      else if (delta > MAX_FOLLOW_UP_DAYS) reason = 'date_implausibly_far';
    }
    if (reason !== null) {
      dueFailures.push({ field: 'next_action', value: nextAction.due, reason, candidates: [] });
      nextAction = { ...nextAction, due: null };
    }
  }

  // Realtor update: the only free text a third party reads. Dropped, never rewritten.
  const ru = validateRealtorUpdate(extraction.realtor_update);
  const ruFailures: ValidationFailure[] = ru.failure ? [ru.failure] : [];

  return {
    ...grounded,
    guardrails,
    follow_up_date: followUpDate,
    next_action: nextAction,
    structural: structure.fields,
    realtor_update: ru.value,
    failures: [...grounded.failures, ...structure.failures, ...dueFailures, ...ruFailures],
    // A qualification single-select that missed its enum flags review too — same reason the
    // structural enums do (a dropped product_fit changes routing). Grounding drops do not.
    needsReview: structure.needsReview || grounded.qualificationNeedsReview,
  };
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

/** Long free-text values (`blocker`, a `key_facts` entry) must not swamp the run record field. */
function summarizeValue(v: number | string): string {
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/** Compact summary for the run record's `validation_failures` field. Empty string on a clean run. */
export function summarizeFailures(failures: ValidationFailure[]): string {
  return failures
    .map((f) => {
      const base = f.qualificationField ? `qualification.${f.qualificationField}` : f.field;
      const name = f.index === undefined ? base : `${base}[${f.index}]`;
      const shown = f.bound !== undefined ? String(f.bound) : summarizeValue(f.value);
      return `${name}=${shown} (${f.reason})`;
    })
    .join('; ');
}
