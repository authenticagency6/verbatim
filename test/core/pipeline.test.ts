import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processTranscript } from '../../src/core/pipeline.ts';

const T = [
  'Renata: Good news, the lender came back and we can get you approved up to four hundred thousand on this one.',
  'Client: Wow. And monthly, where does that land for us, roughly speaking, all in?',
  'Renata: So we would be looking at about thirty two hundred a month all in with taxes and insurance.',
].join('\n');

function fakeFetch(extraction: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return (async () => new Response(JSON.stringify({
    stop_reason: 'end_turn', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(extraction) }], usage,
  }), { status: 200 })) as unknown as typeof fetch;
}

test('processTranscript runs extract → validate → proposals and builds the run record', async () => {
  let t = 0;
  const r = await processTranscript({
    redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k',
    now: () => (t += 1500),
    fetchFn: fakeFetch({
      crm_note: 'Pre-approval discussed.', urgency_flag: 'normal', confidence: 0.9,
      guardrails: {
        approved_price: { value: 400000, evidence: 'we can get you approved up to four hundred thousand on this one' },
        max_out_of_pocket: { value: 25000, evidence: 'we would be looking at about thirty two hundred a month all in' },
      },
    }),
  });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].field, 'approved_price');
  assert.ok(r.dropped.some((d) => d.field === 'max_out_of_pocket'));
  assert.deepEqual(r.context, { crmNote: 'Pre-approval discussed.', urgency: 'normal' });
  assert.equal(r.run.model, 'claude-opus-5-5');
  assert.equal(r.run.inputTokens, 1000);
  assert.equal(r.run.durationMs, 1500);
  assert.equal(r.run.costUsd, (1000 * 4 + 500 * 20) / 1e6);
  assert.match(r.run.failures, /max_out_of_pocket/);
  assert.equal(r.needsReview, false);
});

test('low confidence sets needsReview with a reason', async () => {
  const r = await processTranscript({
    redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k',
    fetchFn: fakeFetch({ crm_note: 'x', confidence: 0.3 }),
  });
  assert.equal(r.needsReview, true);
  assert.match(r.run.needsReviewReasons, /confidence/);
});

test('a refusal throws a named error', async () => {
  const refuse = (async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    processTranscript({ redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k', fetchFn: refuse }),
    { name: 'ExtractionRefusedError' },
  );
});
