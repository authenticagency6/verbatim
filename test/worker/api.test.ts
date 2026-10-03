import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { introspectWorkflow } from 'cloudflare:test';
import { insertCall, saveResults, getCallView } from '../../src/worker/db.ts';

const BASE = 'https://verbatim.test';
const LONG = 'Renata: we can get you approved up to four hundred thousand on this one and the payment would be about thirty two hundred a month all in with taxes.';

const post = (path: string, body?: unknown) =>
  exports.default.fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const MOCK_RESULT = {
  proposals: [{ kind: 'figure', field: 'approved_price', label: 'Approved up to', value: '400000', quote: 'approved up to four hundred thousand', start: 23, end: 59 }],
  dropped: [{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }],
  unlocated: [], needsReview: false, context: { crmNote: 'Note.', urgency: 'normal' },
  run: { model: 'claude-opus-5-5', effort: 'high', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: null, durationMs: 5, failures: '', needsReviewReasons: '', extractionJson: '{}' },
};

describe('POST /api/calls', () => {
  it('400 on an empty or tiny transcript, before any model spend', async () => {
    expect((await post('/api/calls', { transcript: '', callDate: '2026-10-01' })).status).toBe(400);
    expect((await post('/api/calls', { transcript: 'hi there you', callDate: '2026-10-01' })).status).toBe(400);
  });

  it('400 on a bad call date', async () => {
    expect((await post('/api/calls', { transcript: LONG, callDate: '10/01/2026' })).status).toBe(400);
  });

  it('stores only the redacted transcript and runs the workflow to ready', async () => {
    await using wf = await introspectWorkflow(env.PROCESS_CALL);
    await wf.modifyAll(async (m) => { await m.mockStepResult({ name: 'extract' }, MOCK_RESULT); });

    const withSsn = LONG + ' My social is 123-45-6789 by the way, if you need it for anything.';
    const res = await post('/api/calls', { transcript: withSsn, callDate: '2026-10-01' });
    expect(res.status).toBe(202);
    const { id } = await res.json<{ id: string }>();

    const [instance] = await wf.get();
    await instance.waitForStatus('complete');

    const view = (await getCallView(env.DB, id))!;
    expect(view.status).toBe('ready');
    expect(view.transcript).not.toContain('123-45-6789');
    expect(view.proposals).toHaveLength(1);
    expect(view.dropped).toHaveLength(1);
  });

  it('a failing extract marks the call failed', async () => {
    await using wf = await introspectWorkflow(env.PROCESS_CALL);
    await wf.modifyAll(async (m) => { await m.disableRetryDelays(); await m.mockStepError({ name: 'extract' }, new Error('boom'), 3); });
    const { id } = await (await post('/api/calls', { transcript: LONG, callDate: '2026-10-01' })).json<{ id: string }>();
    const [instance] = await wf.get();
    await instance.waitForStatus('errored');
    expect((await getCallView(env.DB, id))!.status).toBe('failed');
  });
});

describe('GET /api/calls/:id and decisions', () => {
  async function seeded(id: string) {
    await insertCall(env.DB, { id, callDate: '2026-10-01', redactedTranscript: LONG });
    await saveResults(env.DB, id, MOCK_RESULT as never);
    return (await getCallView(env.DB, id))!.proposals[0].id;
  }

  it('404 for an unknown call', async () => {
    expect((await exports.default.fetch(`${BASE}/api/calls/nope`)).status).toBe(404);
  });

  it('returns the call view', async () => {
    await seeded('g1');
    const v = await (await exports.default.fetch(`${BASE}/api/calls/g1`)).json<{ status: string; proposals: unknown[] }>();
    expect(v.status).toBe('ready');
    expect(v.proposals).toHaveLength(1);
  });

  it('approve is 200, then a second approve is 409', async () => {
    const pid = await seeded('g2');
    expect((await post(`/api/proposals/${pid}/approve`)).status).toBe(200);
    expect((await post(`/api/proposals/${pid}/approve`)).status).toBe(409);
  });

  it('reject accepts a known reason, refuses an unknown one', async () => {
    const pid = await seeded('g3');
    expect((await post(`/api/proposals/${pid}/reject`, { reason: 'made_up' })).status).toBe(400);
    expect((await post(`/api/proposals/${pid}/reject`, { reason: 'wrong_person' })).status).toBe(200);
  });

  it('reject without a reason is fine', async () => {
    const pid = await seeded('g4');
    expect((await post(`/api/proposals/${pid}/reject`, {})).status).toBe(200);
  });

  it('retry is 409 unless the call failed', async () => {
    await seeded('g5');
    expect((await post('/api/calls/g5/retry')).status).toBe(409);
  });
});
