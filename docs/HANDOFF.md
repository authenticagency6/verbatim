# Handoff

Newest first. One entry per session: what shipped, what's next, open questions.

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
