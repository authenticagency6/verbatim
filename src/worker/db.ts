import type { DroppedDraft, ProposalDraft } from '../core/proposals.ts';

export const ORG_ID = 'org_tallbrook';
export type CallStatus = 'processing' | 'ready' | 'failed';
export type RejectReason = 'wrong_value' | 'wrong_person' | 'not_agreed' | 'other';

export interface RunRecord {
  model: string; effort: string; inputTokens: number; outputTokens: number;
  cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null; durationMs: number;
  failures: string; needsReviewReasons: string; extractionJson: string;
}
export interface CallContext { crmNote: string | null; urgency: string | null }
export interface ProposalRow extends ProposalDraft {
  id: string; status: 'proposed' | 'approved' | 'rejected'; rejectReason: string | null; decidedAt: string | null;
}
export interface CallView {
  id: string; status: CallStatus; error: string | null; callDate: string; transcript: string;
  needsReview: boolean; context: CallContext; proposals: ProposalRow[]; dropped: DroppedDraft[];
}

export async function insertCall(db: D1Database, c: { id: string; callDate: string; redactedTranscript: string }) {
  await db.prepare(
    `INSERT INTO calls (id, org_id, call_date, redacted_transcript, status) VALUES (?, ?, ?, ?, 'processing')`,
  ).bind(c.id, ORG_ID, c.callDate, c.redactedTranscript).run();
}

export async function getCallInput(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT redacted_transcript, call_date FROM calls WHERE id = ? AND org_id = ?`)
    .bind(id, ORG_ID).first<{ redacted_transcript: string; call_date: string }>();
  return r ? { redactedTranscript: r.redacted_transcript, callDate: r.call_date } : null;
}

export async function markProcessing(db: D1Database, id: string) {
  await db.prepare(`UPDATE calls SET status = 'processing', error = NULL WHERE id = ? AND org_id = ?`).bind(id, ORG_ID).run();
}

export async function markFailed(db: D1Database, id: string, error: string) {
  await db.prepare(`UPDATE calls SET status = 'failed', error = ? WHERE id = ? AND org_id = ?`).bind(error, id, ORG_ID).run();
}

export async function saveResults(
  db: D1Database,
  callId: string,
  r: { proposals: ProposalDraft[]; dropped: DroppedDraft[]; run: RunRecord; needsReview: boolean; context: CallContext },
) {
  const stmts: D1PreparedStatement[] = [
    // Idempotent on Workflow retry: clear any rows a previous attempt wrote.
    db.prepare(`DELETE FROM proposals WHERE call_id = ? AND status = 'proposed'`).bind(callId),
    db.prepare(`DELETE FROM dropped WHERE call_id = ?`).bind(callId),
  ];
  for (const p of r.proposals) {
    stmts.push(db.prepare(
      `INSERT INTO proposals (id, org_id, call_id, kind, field, label, value, quote, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), ORG_ID, callId, p.kind, p.field, p.label, p.value, p.quote, p.start, p.end));
  }
  for (const d of r.dropped) {
    stmts.push(db.prepare(`INSERT INTO dropped (id, org_id, call_id, field, value, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ORG_ID, callId, d.field, d.value, d.reason));
  }
  const u = r.run;
  stmts.push(db.prepare(
    `INSERT INTO runs (id, org_id, call_id, model, effort, input_tokens, output_tokens, cache_write_tokens,
       cache_read_tokens, cost_usd, duration_ms, failures, needs_review_reasons, extraction_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), ORG_ID, callId, u.model, u.effort, u.inputTokens, u.outputTokens, u.cacheWriteTokens,
    u.cacheReadTokens, u.costUsd, u.durationMs, u.failures, u.needsReviewReasons, u.extractionJson));
  stmts.push(db.prepare(
    `UPDATE calls SET status = 'ready', error = NULL, needs_review = ?, crm_note = ?, urgency = ? WHERE id = ? AND org_id = ?`,
  ).bind(r.needsReview ? 1 : 0, r.context.crmNote, r.context.urgency, callId, ORG_ID));
  await db.batch(stmts);
}

export async function getCallView(db: D1Database, id: string): Promise<CallView | null> {
  const c = await db.prepare(`SELECT * FROM calls WHERE id = ? AND org_id = ?`).bind(id, ORG_ID).first<Record<string, unknown>>();
  if (!c) return null;
  const ps = await db.prepare(`SELECT * FROM proposals WHERE call_id = ? ORDER BY kind, field`).bind(id).all<Record<string, unknown>>();
  const ds = await db.prepare(`SELECT field, value, reason FROM dropped WHERE call_id = ? ORDER BY field`).bind(id).all<DroppedDraft>();
  return {
    id,
    status: c.status as CallStatus,
    error: (c.error as string) ?? null,
    callDate: c.call_date as string,
    transcript: c.redacted_transcript as string,
    needsReview: c.needs_review === 1,
    context: { crmNote: (c.crm_note as string) ?? null, urgency: (c.urgency as string) ?? null },
    proposals: ps.results.map((p) => ({
      id: p.id as string, kind: p.kind as ProposalRow['kind'], field: p.field as string, label: p.label as string,
      value: p.value as string, quote: p.quote as string,
      start: (p.start_offset as number | null) ?? null, end: (p.end_offset as number | null) ?? null,
      status: p.status as ProposalRow['status'], rejectReason: (p.reject_reason as string) ?? null,
      decidedAt: (p.decided_at as string) ?? null,
    })),
    dropped: ds.results,
  };
}

export async function decideProposal(
  db: D1Database,
  proposalId: string,
  d: { status: 'approved' } | { status: 'rejected'; reason: RejectReason | null },
): Promise<'ok' | 'not_found' | 'already_decided'> {
  const reason = d.status === 'rejected' ? d.reason : null;
  const res = await db.prepare(
    `UPDATE proposals SET status = ?, reject_reason = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND org_id = ? AND status = 'proposed'`,
  ).bind(d.status, reason, proposalId, ORG_ID).run();
  if (res.meta.changes === 1) return 'ok';
  const exists = await db.prepare(`SELECT 1 AS x FROM proposals WHERE id = ? AND org_id = ?`).bind(proposalId, ORG_ID).first();
  return exists ? 'already_decided' : 'not_found';
}
