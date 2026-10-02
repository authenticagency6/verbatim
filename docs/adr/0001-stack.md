# ADR 0001: Stack

- **Status:** Accepted (2026-10-02)
- **Deciders:** Dan

## Context

Verbatim turns calls and texts into follow-ups, tasks and figures, each tied to the exact words it
came from, with a person approving every one. The extraction core (redaction, a structured-output
Claude call, and deterministic grounding and structural validation) already exists as
import-free TypeScript. We need a runtime that keeps that core pure, runs a slow model call
reliably, keeps each organisation's data apart, and is cheap at low volume.

## Decision

| Concern | Choice |
|---|---|
| API + pipeline | Cloudflare Workers; the per-call pipeline runs as a Cloudflare **Workflow** (durable, retried steps) |
| Scheduled / bursty work | Cron Triggers and Queues (later slices: text polling, digests) |
| Database | Cloudflare D1. Every row carries `org_id` from day one; database-per-organisation is the target and gets its own ADR before the second organisation exists |
| Auth + orgs | Clerk Organizations. Slice 1 is behind Cloudflare Access (email allow-list) instead; Clerk replaces it when the first outside user arrives |
| Front end | React SPA served from Workers static assets |
| Model | Anthropic API behind one `extract()` (structured output, explicit effort); API key as a Worker secret |
| Email | Cloudflare Email Service (later slices) |
| Phone capture | A connector interface; Quo is the first connector (later slices) |
| Core | `packages/core`: import-free TypeScript, tested with `node --test`, no knowledge of storage or transport |

## Consequences

- The core stays portable and testable without Cloudflare. Storage is an adapter around it.
- Workflows remove request-timeout risk on long extractions, at the cost of a status-polling UI.
- One D1 with `org_id` is simpler now. The move to per-organisation databases is a known migration,
  not a surprise.
- Prompts and validator internals live in a gitignored `private/` folder. The public repo builds
  against templates, and the full prompt is supplied locally / as a secret.
