import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { insertCall, getCallInput, saveResults, getCallView, decideProposal, markFailed, type RunRecord } from '../../src/worker/db.ts';

const RUN: RunRecord = {
  model: 'claude-opus-5-5', effort: 'high', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
  cacheReadTokens: 0, costUsd: null, durationMs: 10, failures: '', needsReviewReasons: '', extractionJson: '{}',
};

async function seed(id: string) {
  await insertCall(env.DB, { id, callDate: '2026-10-01', redactedTranscript: 'Renata: hello there' });
  await saveResults(env.DB, id, {
    proposals: [{ kind: 'figure', field: 'max_payment', label: 'Max monthly payment', value: '3200', quote: 'hello there', start: 8, end: 19 }],
    dropped: [{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }],
    run: RUN, needsReview: false, context: { crmNote: 'Called about payment.', urgency: 'normal' },
  });
}

describe('db', () => {
  it('a new call is processing and returns its input', async () => {
    await insertCall(env.DB, { id: 'c1', callDate: '2026-10-01', redactedTranscript: 'x' });
    expect(await getCallInput(env.DB, 'c1')).toEqual({ redactedTranscript: 'x', callDate: '2026-10-01' });
    expect((await getCallView(env.DB, 'c1'))!.status).toBe('processing');
  });

  it('saveResults makes the call ready with proposals, dropped and context', async () => {
    await seed('c2');
    const v = (await getCallView(env.DB, 'c2'))!;
    expect(v.status).toBe('ready');
    expect(v.context).toEqual({ crmNote: 'Called about payment.', urgency: 'normal' });
    expect(v.proposals).toHaveLength(1);
    expect(v.proposals[0]).toMatchObject({ field: 'max_payment', status: 'proposed', start: 8, end: 19 });
    expect(v.dropped).toEqual([{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }]);
  });

  it('approve then reject: the second decision is refused', async () => {
    await seed('c3');
    const p = (await getCallView(env.DB, 'c3'))!.proposals[0];
    expect(await decideProposal(env.DB, p.id, { status: 'approved' })).toBe('ok');
    expect(await decideProposal(env.DB, p.id, { status: 'rejected', reason: 'other' })).toBe('already_decided');
    const after = (await getCallView(env.DB, 'c3'))!.proposals[0];
    expect(after.status).toBe('approved');
    expect(after.decidedAt).not.toBeNull();
  });

  it('reject stores the optional reason', async () => {
    await seed('c4');
    const p = (await getCallView(env.DB, 'c4'))!.proposals[0];
    expect(await decideProposal(env.DB, p.id, { status: 'rejected', reason: 'wrong_person' })).toBe('ok');
    expect((await getCallView(env.DB, 'c4'))!.proposals[0].rejectReason).toBe('wrong_person');
  });

  it('unknown proposal is not_found; unknown call is null', async () => {
    expect(await decideProposal(env.DB, 'nope', { status: 'approved' })).toBe('not_found');
    expect(await getCallView(env.DB, 'nope')).toBeNull();
  });

  it('markFailed records the error', async () => {
    await insertCall(env.DB, { id: 'c5', callDate: '2026-10-01', redactedTranscript: 'x' });
    await markFailed(env.DB, 'c5', 'refused');
    expect(await getCallView(env.DB, 'c5')).toMatchObject({ status: 'failed', error: 'refused' });
  });
});
