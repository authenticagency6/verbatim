import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments } from '../../src/web/segments.ts';

const T = 'abc def ghi jkl';

test('no spans: one plain segment', () => {
  assert.deepEqual(segments(T, []), [{ text: T, proposalIds: [] }]);
});

test('one span splits into three', () => {
  assert.deepEqual(segments(T, [{ id: 'a', start: 4, end: 7 }]), [
    { text: 'abc ', proposalIds: [] },
    { text: 'def', proposalIds: ['a'] },
    { text: ' ghi jkl', proposalIds: [] },
  ]);
});

test('overlapping spans carry both ids on the overlap', () => {
  const s = segments(T, [{ id: 'a', start: 0, end: 7 }, { id: 'b', start: 4, end: 11 }]);
  assert.equal(s.map((x) => x.text).join(''), T);
  assert.deepEqual(s.find((x) => x.text === 'def')!.proposalIds.sort(), ['a', 'b']);
});

test('unlocated spans (null) are ignored', () => {
  assert.deepEqual(segments(T, [{ id: 'a', start: null, end: null }]), [{ text: T, proposalIds: [] }]);
});

test('out-of-range offsets are clamped, never thrown', () => {
  const s = segments(T, [{ id: 'a', start: 12, end: 999 }]);
  assert.equal(s.map((x) => x.text).join(''), T);
  assert.deepEqual(s.at(-1), { text: 'jkl', proposalIds: ['a'] });
});
