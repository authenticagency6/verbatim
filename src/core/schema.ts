/**
 * schema.ts — the structured-output JSON Schema for the extraction step.
 *
 * Sent as `output_config.format` on the Messages API call (built in extract.ts), so the model's
 * response is CONSTRAINED to this shape — no fence-stripping, no "here is the JSON", no missing
 * keys. The prompt explains the fields; this schema enforces the syntax.
 *
 * 🔑 **The enums are imported from validate.ts, never restated.** The rule is that each
 * enum lives in exactly one place; ENUM_VALUES is the executable copy, and this schema and the
 * validator both read it. Add a choice there and every layer
 * moves together.
 *
 * ⚠️ **Structured-output schema limitations** (per API docs): every object
 * must carry `additionalProperties: false`; numeric constraints (minimum/maximum) and string
 * constraints (minLength/maxLength) are NOT supported — which is fine, because range and
 * plausibility checking is validate.ts's job, not the schema's. The schema guarantees SHAPE;
 * grounding and structural validation guarantee TRUTH and LEGALITY. Do not try to move the
 * latter two in here.
 *
 * 🚩 **AT MOST 16 union-typed parameters** (fields whose type is an array like `['string','null']`
 * or an `anyOf`). Beyond that the API rejects the whole request with a 400 at request time —
 * "too many parameters with union types … exponential compilation cost". This is why the evidence
 * pairs are whole-pair-nullable (1 union each) rather than value-and-evidence-each-nullable (2
 * union each): the latter put the schema at 19 and every call 400'd. A test in
 * extract.test.ts counts the unions and fails under 16, so this cannot silently regress again.
 *
 * ⚠️ **`loan_stage` is deliberately absent.** The acceptance gate names it, but the output
 * schema never asked the model for it, and write-back never writes Stage from it. Resolution: the model is
 * NOT asked to emit it. validateStructure still checks it if some future schema adds it.
 *
 * Every field is REQUIRED, with null expressed in the type — the strict-outputs pattern. An
 * optional key and a required-but-null key carry the same information, and requiring everything
 * means a missing field is a schema violation the API catches instead of a silent undefined
 * flowing into write-back.
 */

import { ENUM_VALUES, QUALIFICATION_FIELDS } from './validate.ts';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * A `{value, evidence}` pair — the shape every span-carrying field takes (G1 contract).
 *
 * 🚩 **The WHOLE PAIR is nullable, not the value inside it.** A field not discussed on the call
 * is `null`; a field that was discussed is `{value, evidence}` with BOTH present. This is the
 * honest representation — a value always carries its quote — and it is also what keeps the schema
 * under the structured-outputs union limit (see the header note). `unwrapSpan` in validate.ts
 * already treats a bare `null` as "not discussed", so this needs no validator change. `valueSchema`
 * is therefore the NON-null type: `{type:'number'}` / `{type:'string'}`, never `['number','null']`.
 */
function evidencePair(valueSchema: JsonSchema): JsonSchema {
  return {
    anyOf: [
      {
        type: 'object',
        properties: {
          value: valueSchema,
          evidence: { type: 'string' },
        },
        required: ['value', 'evidence'],
        additionalProperties: false,
      },
      { type: 'null' },
    ],
  };
}

function nullableEnum(values: readonly string[]): JsonSchema {
  return { anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] };
}

const draftSchema: JsonSchema = {
  anyOf: [
    {
      type: 'object',
      properties: { subject: { type: 'string' }, body: { type: 'string' } },
      required: ['subject', 'body'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

// ---------------------------------------------------------------------------
// The extraction schema
// ---------------------------------------------------------------------------

export const EXTRACTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    crm_note: { type: 'string' },

    /**
     * The caller's name AS SPOKEN on the call. Plain string, `""` when never
     * said — deliberately NOT nullable, so it costs zero unions against the 16-union ceiling. Only
     * consumed when the contact was auto-created and is still phone-named;
     * a real name on the record is never overwritten. No evidence pair: the write-back grounds it
     * by checking the name actually occurs in the transcript.
     */
    caller_name: { type: 'string' },

    /**
     * OPERATIONS on the contact's current list, not a list. `op` add | update |
     * retire, `line` = the number of the current line an update/retire changes (0 for add), `value` =
     * "Topic: sentence" ("" for retire). Zero unions (`op` is a non-null enum, `line` a number):
     * +93 bytes, probed on Opus 5.5 and 4.8 at 3,666 B and a padded 3,935 B (both compile).
     */
    key_facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'retire'] },
          line: { type: 'number' },
          value: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['op', 'line', 'value', 'evidence'],
        additionalProperties: false,
      },
    },

    /**
     * The seven qualification fields, carried as ONE array to stay under
     * the 16-union ceiling — seven individual evidence pairs would be seven unions and 400 the call.
     * An array of objects is zero unions (same trick as `key_facts`). `field` is an enum so the model
     * cannot invent a target; `value` is always a string (write-back coerces it to the store's type —
     * `loan_amount`→number, `second_opinion`→checkbox, the four selects→their single-select options).
     * Emit an entry ONLY when the field was actually discussed; omit it otherwise (empty array is fine).
     */
    qualification: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: [...QUALIFICATION_FIELDS] },
          value: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['field', 'value', 'evidence'],
        additionalProperties: false,
      },
    },

    urgency_flag: { type: 'string', enum: [...ENUM_VALUES.urgency_flag] },
    urgency_reason: { type: ['string', 'null'] },

    client_email_draft: draftSchema,
    /**
     * `realtor_email_draft` {subject, body} is GONE. In its place two
     * plain strings, ZERO unions between them (the schema was at 3,690 of the 3,700-byte grammar
     * budget; the draft object cost ~150 B, these two cost ~50 B):
     *   `realtor_update` — one or two realtor-safe sentences about where the client's file stands,
     *     third person, NO figures (validate.ts rejects digits / currency / credit-income words).
     *     Stored as the contact's realtor update; the per-contact realtor email draft is assembled
     *     DETERMINISTICALLY around it (salutation from the partner RECORD, next-touch date, fixed
     *     sign-off), and a partner digest reads it as the per-client line. `""` = no realtor involved.
     *   `realtor_name` — the referring agent's name AS SPOKEN on the call, `""` if none / not said.
     *     Only used for the salutation when NO partner is linked (tagged "(spelling from call — verify)").
     */
    realtor_update: { type: 'string' },
    realtor_name: { type: 'string' },

    coaching: {
      anyOf: [
        {
          type: 'object',
          properties: {
            score: { type: 'number' },
            notes: { type: 'string' },
            carry_forward: { type: 'string' },
          },
          required: ['score', 'notes', 'carry_forward'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },

    guardrails: {
      type: 'object',
      properties: {
        approved_price: evidencePair({ type: 'number' }),
        max_payment: evidencePair({ type: 'number' }),
        max_out_of_pocket: evidencePair({ type: 'number' }),
        rate_range_quoted: evidencePair({ type: 'string' }),
        preapproval_date: evidencePair({ type: 'string' }),
      },
      required: [
        'approved_price',
        'max_payment',
        'max_out_of_pocket',
        'rate_range_quoted',
        'preapproval_date',
      ],
      additionalProperties: false,
    },

    follow_up_date: evidencePair({ type: 'string' }),

    blocker: evidencePair({ type: 'string' }),

    waiting_on: { type: 'string', enum: [...ENUM_VALUES.waiting_on] },
    preferred_contact_method: nullableEnum(ENUM_VALUES.preferred_contact_method),
    language: { type: 'string', enum: [...ENUM_VALUES.language] },
    /**
     * Both are plain enums — zero unions. `call_purpose` gates
     * the client-only outputs at write-back; `blocker_status` lets a resolved blocker be cleared.
     */
    call_purpose: { type: 'string', enum: [...ENUM_VALUES.call_purpose] },
    blocker_status: { type: 'string', enum: [...ENUM_VALUES.blocker_status] },
    /**
     * Two NON-nullable objects — zero unions each, so the
     * schema stays at its current count under the 16-union ceiling. "Nothing" is expressed as
     * `stage: "none"` / `kind: "none"` with empty strings, never as null.
     *
     * `stage_signal`: the stage this call ESTABLISHED (application taken on the call, approval
     * terms delivered, offer accepted, closing stated) with the verbatim quote. The write-back
     * proposes it to a human (forward-only, corroborated) — it never writes Stage from this
     * directly until a transition is promoted. `loan_stage` itself stays absent (see header).
     *
     * `next_action`: the single agreed next action, typed by who owns it. Only `deliverable`
     * becomes a Task; `due` is a stated date or "", never a default interval.
     */
    /**
     * 🚩 **`stage_signal` and `next_action` are NOT top-level objects — they ride inside the
     * `qualification` array as the `stage_reached` and `next_action` members of its `field` enum.**
     * They were built as two required objects (2 + 5 strings, zero unions) and the API answered
     * 400 "The compiled grammar is too large, which would cause performance issues" on EVERY call.
     * A live probe showed each object alone
     * passes and both together fail, and that the same signals as two extra enum members cost
     * +30 bytes of schema and pass. The grammar budget is a second hard limit beside the 16-union
     * ceiling, and it is CUMULATIVE — a test pins the schema's byte size so the next addition
     * triggers a probe, not an outage. Encoding: `{field:"stage_reached", value:"<Stage>",
     * evidence}` and `{field:"next_action", value:"<kind> | <owner> | <due or ->| <action>",
     * evidence}`; validate.ts lifts both out of the array before qualification validation.
     */
    confidence: { type: 'number' },
  },
  required: [
    'crm_note',
    'caller_name',
    'key_facts',
    'qualification',
    'urgency_flag',
    'urgency_reason',
    'client_email_draft',
    'realtor_update',
    'realtor_name',
    'coaching',
    'guardrails',
    'follow_up_date',
    'blocker',
    'waiting_on',
    'preferred_contact_method',
    'language',
    'call_purpose',
    'blocker_status',
    'confidence',
  ],
  additionalProperties: false,
};

/** The `output_config.format` value, ready to drop into the request body. */
export const OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: EXTRACTION_SCHEMA,
} as const;
