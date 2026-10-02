# Slice 1: one call in, approved proposals out

- **Date:** 2026-10-02 · **Status:** design signed off, spec awaiting review
- **Stack:** [ADR 0001](../../adr/0001-stack.md)

## Who it's for and why

Mortgage broker-shop owners deciding whether Verbatim is worth a design-partner slot. The slice has
to show the core promise in under a minute: a call becomes follow-ups, tasks and figures, every
one of them shows the exact words it came from, anything the AI can't quote gets dropped where you
can see it, and nothing counts until a person approves it.

## The flow

1. A user pastes a transcript or loads a sample call, with a call date, and submits.
2. The Worker stores the call (`status: processing`) and starts the `ProcessCall` Workflow.
3. The Workflow steps (each a retried `step.do`):
   1. **Redact.** Sensitive identifiers become placeholders. Only the redacted text is stored. The
      redaction guard failing marks the call `failed`.
   2. **Extract.** One structured-output Claude call with the full call prompt (held privately).
      Context the slice doesn't have yet (stage, partner, last note, key facts) is passed as
      empty defaults. Refusal or truncation marks the call `failed`, with a retry button.
   3. **Validate.** The existing grounding and structural checks, unchanged in behaviour.
   4. **Propose.** Build `Proposal` and `Dropped` rows and locate each quote in the transcript.
   5. **Persist.** Write rows plus the run record. The call becomes `ready`.
4. The page polls `GET /api/calls/:id` until `ready` or `failed`.
5. The user approves or rejects each proposal. A rejection can carry one optional reason.

A slow model call never ties up a request: the extraction regularly takes longer than a user
should hold a connection open, which is why this is a Workflow.

## Domain

**Proposal**: something the AI thinks happened on the call, waiting for a person.

| Field | Notes |
|---|---|
| `kind` | `follow_up` · `task` · `figure` |
| `label` | e.g. "Max payment", "Follow up" |
| `value` | number, `YYYY-MM-DD`, or task title |
| `quote`, `start`, `end` | the verbatim words and their char range in the redacted transcript; `start`/`end` null if the quote could not be located (see Errors) |
| `status` | `proposed` → `approved` or `rejected` |
| `reject_reason` | null · `wrong_value` · `wrong_person` · `not_agreed` · `other` |
| `decided_at` | set on approve or reject |

Mapping from the validated extraction: numeric guardrails and pre-approval date → `figure`;
follow-up date → `follow_up`; next action → `task`. A value with no surviving quote never becomes
a Proposal. The engine yields at most one task and one follow-up per call; more per call is a
later prompt change.

**Dropped**: a value the model returned that failed grounding or structural validation. It carries
`field`, `value` and `reason`, and is shown, never approvable.

**Approved means done.** Nothing is sent or written anywhere else. There is no editing in slice 1:
a wrong value is rejected.

## Data (D1)

Every table has `org_id` (one synthetic org in slice 1).

- `calls`: id, org_id, created_at, call_date, redacted_transcript, status (`processing` · `ready` ·
  `failed`), error, needs_review
- `proposals`: as above, plus call_id
- `dropped`: call_id, field, value, reason
- `runs`: call_id, model, effort, input/output/cache tokens, cost, duration_ms, failures,
  needs_review_reasons, extraction_json (the whole validated extraction, so later slices can
  surface fields without re-running calls)

The raw transcript is never stored.

## Screen

One page:

- Paste box, call date, and a sample-call picker.
- Processing state, until ready.
- **Context strip** at the top: the CRM note and urgency, read-only.
- **Left pane:** cards grouped Follow-ups / Tasks / Figures, each with Approve and Reject (Reject
  opens the optional reason chips).
- **Right pane:** the transcript, with each proposal's quote highlighted. Clicking a card scrolls
  to and pulses its words.
- **Dropped tray** at the bottom: "Couldn't quote it", listing each dropped value and why.

Drafts, coaching, key facts and qualification are stored in `runs.extraction_json` and not shown.

## Units

```
packages/core/            import-free TypeScript, node --test
  redact, validate (+ split modules), schema, types, extract   ported from the existing core
  locate.ts               NEW: quote → {start, end} in the redacted transcript
  proposals.ts            NEW: validated extraction → { proposals, dropped }
apps/worker/              Worker: routes, ProcessCall Workflow, D1 access
apps/web/                 React SPA on Workers static assets
private/                  full prompts, script criteria, regression calls (gitignored)
```

`core` knows nothing about storage, HTTP or Cloudflare. `extract` takes `fetch` as an argument.

## Errors

| Case | Behaviour |
|---|---|
| Redaction guard trips | call `failed` with reason; nothing sent to the model again |
| Model refusal / truncation / API error after retries | call `failed`; retry button re-runs the Workflow |
| A validated quote can't be located in the raw text | proposal still shown, quote unhighlighted, `span_unlocated` logged on the run. A valid value is never dropped for a UI reason |
| Low confidence or structural failure | `needs_review` badge on the call |

## Data and privacy

- All demo data belongs to the synthetic branch **Tallbrook Home Loans**, held as one config value
  (`org_name`) pending a manual NMLS Consumer Access check.
- **Public demo calls:** 3 new calls written for Tallbrook, one English/Spanish code-switched, and
  one containing a figure the model is likely to state that the call never says, so the Dropped
  tray is exercised.
- **Private regression set:** the existing fabricated calls, people renamed into Tallbrook, kept
  in `private/` with their expected extractions.
- Every ported file is grepped for real names, IDs and team lines before it leaves `private/`;
  prompts and validator internals stay private.

## Testing

- **Core:** the existing validation, span, redaction, structure and extraction suites are ported
  (scrubbed) and must pass unchanged, which proves the port. New tests cover `locate.ts` (curly
  quotes, apostrophes, `%`, speaker labels, accents, repeated phrases) and `proposals.ts`.
- **Regression:** the private Tallbrook regression calls stay green.
- **Worker:** vitest with the Workers pool. Anthropic is stubbed with a recorded response for one
  synthetic call, covering the Workflow happy path, failure paths, and the approve/reject
  endpoints.
- **One real API run** on the deployed URL before the clip. Its cost and duration come from
  `runs`, never estimated.

## Access

Deployed to workers.dev behind Cloudflare Access (email allow-list). No login in the app; Clerk
arrives in a later slice.

## Out of scope

Editing, Clerk, phone connectors (Quo), texts, email sending, contacts and multi-call history,
key-facts merge, task de-duplication, Queues, database-per-organisation, mobile layout.

## Done when

1. Scrubbed core tests and the private regression set pass.
2. A fresh Tallbrook call runs end to end on the deployed URL.
3. Every proposal highlights its words in the transcript (or is logged `span_unlocated`).
4. At least one fabricated figure lands in the Dropped tray.
5. Approve and reject persist across a reload.
6. One real run's cost and duration are recorded in `runs`.
7. A 30–60 s clip exists.
8. A changelog line is written and `docs/HANDOFF.md` is updated.
