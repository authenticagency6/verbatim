# Handoff

Newest first. One entry per session: what shipped, what's next, open questions.

## 2026-10-03: Days 2–3 (slice 1, Tasks 1–9 built)

**Shipped** (branch `slice-1`, each task reviewed for spec and quality)
- `docs/CONTEXT.md`: domain glossary (Call, Proposal, Quote, Highlight, Dropped, Run, …).
- Tasks 1–8: scaffold and staged-diff name scan; the extraction core ported with its tests
  (code unchanged apart from three deliberate edits); `locateSpan`; `buildProposals`; the D1 schema and data access; the
  `ProcessCall` Workflow and call API; transcript highlight segments; the review screen.
- Task 9: three Tallbrook demo calls (pre-approval, an English/Spanish results call, and a bait
  call that never states a closing figure). Committed, not yet pushed.
- Checked in a browser on synthetic data: highlights, card/highlight focus, approve and reject
  persisting across reload, the Dropped tray, 375 px layout, the failed-call Retry path.

**Fixed along the way (found in review)**
- A public clone couldn't build without the private prompt; it now falls back to the example.
- A Workflow that fails to start now marks the call failed instead of leaving it processing.
- Dropped rows carry the validator's real reason and the model's full value; a bad task due
  date drops only the date, not the task.
- The default call date used UTC and showed tomorrow in the evening; it now uses local time.

**Numbers:** none yet. No real model run has happened; cost and duration come in Task 10.

**Next**
- Task 10: verify pricing, first real run locally, remote D1, deploy behind Access, the clip.
- Whole-branch review, then merge `slice-1` into `main`.

**Open questions**
- NMLS Consumer Access check for "Tallbrook" (manual).
- Show figures formatted ($425,000) instead of raw (425000) before the clip?

## 2026-10-02: Day 1 (design and plan, no code yet)

**Shipped**
- `docs/adr/0001-stack.md`: stack accepted (Workers + Workflows, D1 with `org_id`, Cloudflare Access
  for slice 1, Clerk later, React SPA, Anthropic behind one `extract()`).
- `docs/superpowers/specs/2026-10-02-slice-1-call-to-approval-design.md`: slice 1 design, signed off.
- `docs/superpowers/plans/2026-10-02-slice-1-call-to-approval.md`: 10-task TDD plan, reviewed.
- Branch `slice-1` created and pushed. `main` holds the ADR and spec.

**Decided while planning**
- Validator and redaction code are public, with comments scrubbed. Prompts, the regression and
  trap corpus, and the edge-case catalogue stay in `private/`.
- Redaction runs on submit, before anything is stored or handed to a Workflow, so no raw
  transcript is ever persisted.
- `validate.ts` is ported as one file in slice 1; the split is queued for slice 2.

**Next**
- Execute the plan from Task 1 with superpowers:subagent-driven-development, on `slice-1`.
- Dan reviews the diff at the end of each task. The staged-diff name scan runs before every
  commit.

**Open questions**
- NMLS Consumer Access check for "Tallbrook" (manual; the site refuses automated searches).
- Model pricing in `src/core/config.ts` must be checked against Anthropic's published prices
  before the first real run (plan Task 10).
