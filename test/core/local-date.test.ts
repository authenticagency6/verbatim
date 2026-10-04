import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateString } from '../../src/web/localDate.ts';

test('late evening local time keeps the local date', () => {
  // Built from local components, so this holds in any timezone. In UTC-4 the ISO date would be the next day.
  assert.equal(localDateString(new Date(2026, 9, 3, 21, 33)), '2026-10-03');
});

test('pads month and day, handles year start', () => {
  assert.equal(localDateString(new Date(2026, 0, 5, 0, 5)), '2026-01-05');
});
