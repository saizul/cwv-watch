import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend, linearFit } from '../src/trend.js';
import type { HistoryData } from '../src/crux.js';

const history = (lcp: Array<number | null>): HistoryData => ({
  key: { origin: 'https://a.test', formFactor: 'PHONE' },
  periods: lcp.map((_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
  p75s: { lcp },
  goodShare: {},
});

test('linearFit on a perfect line', () => {
  const fit = linearFit([1, 3, 5, 7]);
  assert.ok(fit);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
});

test('linearFit skips nulls and needs two points', () => {
  assert.equal(linearFit([null, 5, null]), null);
  const fit = linearFit([2, null, 6]);
  assert.equal(fit?.slope, 2);
  assert.equal(fit?.n, 2);
});

test('rising p75 is worsening', () => {
  const t = computeTrend(history([2000, 2100, 2200, 2300, 2400]), 'lcp', 8, 0.05);
  assert.equal(t?.direction, 'worsening');
  assert.equal(t?.first, 2000);
  assert.equal(t?.last, 2400);
  assert.ok((t?.change ?? 0) > 0.19 && (t?.change ?? 0) < 0.21);
});

test('falling p75 is improving', () => {
  assert.equal(computeTrend(history([3000, 2800, 2600, 2400]), 'lcp', 8, 0.05)?.direction, 'improving');
});

test('small changes are stable', () => {
  assert.equal(computeTrend(history([2000, 2010, 1995, 2005, 2002]), 'lcp', 8, 0.05)?.direction, 'stable');
});

test('only the last window periods are used', () => {
  const t = computeTrend(history([5000, 4000, 3000, 2000, 2000, 2000, 2000]), 'lcp', 4, 0.05);
  assert.equal(t?.values.length, 4);
  assert.equal(t?.direction, 'stable');
  assert.deepEqual(t?.periods, ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07']);
});

test('too few points is insufficient data', () => {
  const t = computeTrend(history([null, 2000, null, 2100]), 'lcp', 8, 0.05);
  assert.equal(t?.direction, 'insufficient-data');
  assert.equal(t?.slope, null);
});

test('missing metric returns null', () => {
  assert.equal(computeTrend(history([1, 2, 3]), 'inp', 8, 0.05), null);
});

test('one noisy week does not flip the trend', () => {
  const t = computeTrend(history([2000, 2000, 2000, 2600, 2000, 2000, 2000, 2000]), 'lcp', 8, 0.05);
  assert.equal(t?.direction, 'stable');
});
