# Verbatim

A pipeline for mortgage teams who live on their phones: every call and text becomes follow-ups,
tasks and figures, and each value shows the exact words it came from. Quote it or drop it.
Nothing is sent or moved without a person. Built in public over a 30-day hackathon.

@private/PRIVATE-CONTEXT.md

## Public repo rules

This repo is public. Before anything is committed:

- **No real customer data, ever.** No names, phone numbers, transcripts, texts, loan figures,
  screenshots of real systems, secrets or IDs. All demo and test data is the invented synthetic
  branch.
- **Held back in `private/` (gitignored):** full prompts, industry-pack files, validator internals,
  the edge-case catalogue and the trap corpus. The repo shows the app, the principles, the eval
  scores and the architecture.
- **No invented numbers** in the README, changelog or posts. Eval scores and cost per call come
  from real runs.
- Run `git diff --cached` and scan for names and secrets before every commit.

## How work happens here

1. One slice per session, picked from the plan.
2. **Superpowers** runs the slice: writing-plans → subagent-driven-development with TDD →
   verification-before-completion → finishing-a-development-branch.
3. **Matt Pocock skills** when needed: `/grill-with-docs` when a slice adds domain terms (keeps
   `docs/CONTEXT.md` and ADRs current), `/diagnosing-bugs` when stuck,
   `/improve-codebase-architecture` weekly, `/handoff` at session end.
4. **oh-my-claudecode** (enabled in this repo only): `/autopilot` or `ralph` only on a slice with
   a finished spec and tests to aim at.
5. Every slice ships a visible result (clip, GIF or screenshot of synthetic data) and a line in
   the changelog.

## Stack (to confirm in the first ADR)

Cloudflare Workers (API + engine + Cron + Queues + Workflows) · D1 database per organisation ·
Clerk Organizations · React SPA on Workers static assets · Anthropic API behind one `extract()` ·
Cloudflare Email Service. Phone capture sits behind a connector interface; Quo is the first
connector.
