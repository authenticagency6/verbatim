import { redactTranscript } from '../core/redact.ts';
import { assertRedacted, UnredactedTranscriptError } from '../core/guard.ts';
import { MIN_TRANSCRIPT_WORDS } from '../core/config.ts';
import { insertCall, getCallView, decideProposal, markProcessing, type RejectReason } from './db.ts';
import { SAMPLES } from './samples.ts';

const REJECT_REASONS: readonly RejectReason[] = ['wrong_value', 'wrong_person', 'not_agreed', 'other'];

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; } catch { return {}; }
}

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = (re: RegExp) => re.exec(path);

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true });
  if (req.method === 'GET' && path === '/api/samples') return json(SAMPLES);

  // Redaction runs here, not in the Workflow: Workflow params are persisted, so the raw
  // transcript must never reach them. Only the redacted text is stored or passed on.
  if (req.method === 'POST' && path === '/api/calls') {
    const b = await body(req);
    const transcript = typeof b.transcript === 'string' ? b.transcript : '';
    if (transcript.trim().split(/\s+/).filter(Boolean).length < MIN_TRANSCRIPT_WORDS) {
      return json({ error: `Paste a transcript of at least ${MIN_TRANSCRIPT_WORDS} words.` }, 400);
    }
    if (!validDate(b.callDate)) return json({ error: 'callDate must be YYYY-MM-DD.' }, 400);
    const redacted = redactTranscript(transcript).redacted;
    try {
      assertRedacted(redacted);
    } catch (e) {
      if (e instanceof UnredactedTranscriptError) return json({ error: 'Redaction check failed; nothing was processed.' }, 422);
      throw e;
    }
    const id = crypto.randomUUID();
    await insertCall(env.DB, { id, callDate: b.callDate, redactedTranscript: redacted });
    await env.PROCESS_CALL.create({ id, params: { callId: id } });
    return json({ id }, 202);
  }

  let r = m(/^\/api\/calls\/([\w-]+)$/);
  if (req.method === 'GET' && r) {
    const v = await getCallView(env.DB, r[1]);
    return v ? json(v) : json({ error: 'not found' }, 404);
  }

  r = m(/^\/api\/calls\/([\w-]+)\/retry$/);
  if (req.method === 'POST' && r) {
    const v = await getCallView(env.DB, r[1]);
    if (!v) return json({ error: 'not found' }, 404);
    if (v.status !== 'failed') return json({ error: 'only a failed call can be retried' }, 409);
    await markProcessing(env.DB, v.id);
    await env.PROCESS_CALL.create({ id: `${v.id}-retry-${Date.now()}`, params: { callId: v.id } });
    return json({ id: v.id }, 202);
  }

  r = m(/^\/api\/proposals\/([\w-]+)\/(approve|reject)$/);
  if (req.method === 'POST' && r) {
    let decision: { status: 'approved' } | { status: 'rejected'; reason: RejectReason | null };
    if (r[2] === 'approve') decision = { status: 'approved' };
    else {
      const reason = (await body(req)).reason ?? null;
      if (reason !== null && !REJECT_REASONS.includes(reason as RejectReason)) return json({ error: 'unknown reason' }, 400);
      decision = { status: 'rejected', reason: reason as RejectReason | null };
    }
    const out = await decideProposal(env.DB, r[1], decision);
    if (out === 'not_found') return json({ error: 'not found' }, 404);
    if (out === 'already_decided') return json({ error: 'already decided' }, 409);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
