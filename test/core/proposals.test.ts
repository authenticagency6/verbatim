import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateForWriteback } from '../../src/core/validate.ts';
import { buildProposals } from '../../src/core/proposals.ts';

const CALL_DATE = new Date('2026-10-01T15:00:00Z');
const T = [
  'Renata: Good news, the lender came back and we can get you approved up to four hundred thousand on this one.',
  'Client: Wow. And monthly, where does that land for us?',
  'Renata: So we would be looking at about thirty two hundred a month all in with taxes and insurance.',
  'Client: Okay, can you call me back on Thursday after I talk to my husband about it?',
  'Renata: Absolutely, I will call you back on Thursday and Marcus will send the fee sheet over today.',
].join('\n');

const QUOTE_PRICE = 'we can get you approved up to four hundred thousand on this one';
const QUOTE_PAY = 'we would be looking at about thirty two hundred a month all in';
const QUOTE_FU = 'I will call you back on Thursday and Marcus will send';
const QUOTE_TASK = 'Marcus will send the fee sheet over today';

function run(extraction: Record<string, unknown>) {
  const v = validateForWriteback(extraction as never, T, CALL_DATE);
  return buildProposals(v, T);
}

function assertNoOverlap(s: ReturnType<typeof run>) {
  for (const d of s.dropped) {
    assert.ok(!s.proposals.some((p) => p.field === d.field), `${d.field} is in both proposals and dropped`);
  }
}

test('grounded figures and follow-up become proposals; a paraphrased task does not', () => {
  const s = run({
    guardrails: {
      approved_price: { value: 400000, evidence: QUOTE_PRICE },
      max_payment: { value: 3200, evidence: QUOTE_PAY },
    },
    follow_up_date: { value: '2026-10-08', evidence: QUOTE_FU },
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | 2026-10-01 | Send the fee sheet', evidence: QUOTE_TASK + ' as promised' }],
  });
  const kinds = s.proposals.map((p) => `${p.kind}:${p.field}`).sort();
  assert.deepEqual(kinds, ['figure:approved_price', 'figure:max_payment', 'follow_up:follow_up_date']);
  for (const p of s.proposals) {
    assert.notEqual(p.start, null, `${p.field} not located`);
    assert.ok(T.slice(p.start!, p.end!).length > 0);
  }
  const price = s.proposals.find((p) => p.field === 'approved_price')!;
  assert.equal(price.value, '400000');
  assert.equal(price.label, 'Approved up to');
  assertNoOverlap(s);
});

test('a task with a verified quote becomes a task proposal', () => {
  const s = run({
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | 2026-10-01 | Send the fee sheet', evidence: 'I will call you back on Thursday and Marcus will send the fee sheet over today' }],
  });
  const task = s.proposals.find((p) => p.kind === 'task');
  assert.ok(task, 'expected a task');
  assert.equal(task!.value, 'Send the fee sheet');
  assert.match(task!.label, /due 2026-10-01/);
  assert.notEqual(task!.start, null);
  assertNoOverlap(s);
});

test('a task whose quote is not verbatim is dropped, never proposed', () => {
  const s = run({
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | - | Send the fee sheet', evidence: 'Marcus promised to email the fee sheet to the client by the end of today' }],
  });
  assert.equal(s.proposals.filter((p) => p.kind === 'task').length, 0);
  assert.ok(s.dropped.some((d) => d.field === 'next_action'));
  assertNoOverlap(s);
});

test('a fabricated figure lands in dropped with its reason', () => {
  const s = run({ guardrails: { max_out_of_pocket: { value: 25000, evidence: QUOTE_PAY } } });
  assert.equal(s.proposals.length, 0);
  const d = s.dropped.find((x) => x.field === 'max_out_of_pocket')!;
  assert.equal(d.value, '25000');
  assert.ok(d.reason.length > 0);
  assertNoOverlap(s);
});

test('a bare value with no quote is dropped as evidence_missing, even if the number was said', () => {
  const s = run({ guardrails: { max_payment: 3200 } });
  assert.equal(s.proposals.length, 0);
  assert.deepEqual(s.dropped, [{ field: 'max_payment', value: '3200', reason: 'evidence_missing' }]);
});

test('nothing discussed gives nothing', () => {
  const s = run({ guardrails: { approved_price: null }, follow_up_date: null });
  assert.deepEqual(s, { proposals: [], dropped: [], unlocated: [] });
});
