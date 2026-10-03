import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateSpan } from '../../src/core/locate.ts';

const T = [
  'Renata: Thanks for jumping on. So we’d be looking at about thirty two hundred a month, all in.',
  'Client: Okay. And the rate?',
  'Renata: Between six and a half and six and seven eighths — that’s 6.875%.',
].join('\n');

test('finds an exact quote and returns the raw range', () => {
  const q = 'looking at about thirty two hundred a month';
  const r = locateSpan(T, q)!;
  assert.equal(T.slice(r.start, r.end), 'looking at about thirty two hundred a month,');
});

test('curly vs straight apostrophes still match', () => {
  const r = locateSpan(T, "So we'd be looking at about thirty two hundred")!;
  assert.equal(T.slice(r.start, r.end), 'So we’d be looking at about thirty two hundred');
});

test('a quote missing the trailing % still matches', () => {
  const r = locateSpan(T, 'six and seven eighths that\'s 6.875')!;
  assert.ok(T.slice(r.start, r.end).startsWith('six and seven eighths'));
  assert.ok(T.slice(r.start, r.end).endsWith('6.875%.'));
});

test('speaker labels are never part of a match', () => {
  assert.equal(locateSpan(T, 'Renata Thanks for jumping on'), null);
  const r = locateSpan(T, 'Thanks for jumping on')!;
  assert.equal(r.start, T.indexOf('Thanks'));
});

test('returns null when the quote is not there', () => {
  assert.equal(locateSpan(T, 'approved up to four hundred thousand'), null);
});

test('empty quote returns null', () => {
  assert.equal(locateSpan(T, '   '), null);
});

test('word boundaries: "in rent" does not match "in rental"', () => {
  assert.equal(locateSpan('Renata: it is in rental condition', 'in rent'), null);
});

test('accents fold on both sides', () => {
  const t = 'Marcus: El pago está en dos mil cuatrocientos al mes.';
  const r = locateSpan(t, 'el pago esta en dos mil cuatrocientos')!;
  assert.equal(t.slice(r.start, r.end), 'El pago está en dos mil cuatrocientos');
});

test('CRLF transcripts: offsets still point at the right characters', () => {
  const crlf = T.replace(/\n/g, '\r\n');
  const r = locateSpan(crlf, 'And the rate')!;
  assert.equal(crlf.slice(r.start, r.end), 'And the rate?');
});

test('a phrase said twice returns the first occurrence, and it is a real match', () => {
  const t = 'Client: we pay thirty two hundred a month now.\nRenata: keep it at thirty two hundred a month.';
  const r = locateSpan(t, 'thirty two hundred a month')!;
  assert.equal(r.start, t.indexOf('thirty'));
  assert.equal(t.slice(r.start, r.end), 'thirty two hundred a month');
});

test('hyphenated number words split into canonical words', () => {
  const t = 'Renata: about thirty-two hundred a month';
  const r = locateSpan(t, 'about thirty two hundred a month')!;
  assert.equal(t.slice(r.start, r.end), 'about thirty-two hundred a month');
});
