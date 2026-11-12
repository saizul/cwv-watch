import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS,
  METRIC_IDS,
  compareRatings,
  formatDelta,
  formatValue,
  isMetricId,
  metricByCruxName,
  rate,
  worstRating,
} from '../src/metrics.js';

const cases: Array<[Parameters<typeof rate>[0], number, ReturnType<typeof rate>]> = [
  ['lcp', 0, 'good'],
  ['lcp', 2500, 'good'],
  ['lcp', 2501, 'needs-improvement'],
  ['lcp', 4000, 'needs-improvement'],
  ['lcp', 4001, 'poor'],
  ['inp', 200, 'good'],
  ['inp', 201, 'needs-improvement'],
  ['inp', 500, 'needs-improvement'],
  ['inp', 501, 'poor'],
  ['cls', 0.1, 'good'],
  ['cls', 0.11, 'needs-improvement'],
  ['cls', 0.25, 'needs-improvement'],
  ['cls', 0.26, 'poor'],
  ['fcp', 1800, 'good'],
  ['fcp', 1801, 'needs-improvement'],
  ['fcp', 3000, 'needs-improvement'],
  ['fcp', 3001, 'poor'],
  ['ttfb', 800, 'good'],
  ['ttfb', 801, 'needs-improvement'],
  ['ttfb', 1800, 'needs-improvement'],
  ['ttfb', 1801, 'poor'],
];

for (const [metric, value, expected] of cases) {
  test(`rate(${metric}, ${value}) is ${expected}`, () => {
    assert.equal(rate(metric, value), expected);
  });
}

test('rate rejects non-finite values', () => {
  assert.throws(() => rate('lcp', Number.NaN), RangeError);
});

test('every metric has a CrUX name, a PSI key and ordered boundaries', () => {
  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    assert.equal(m.id, id);
    assert.ok(m.cruxName.length > 0);
    assert.ok(m.psiFieldKey.length > 0);
    assert.ok(m.good < m.poor);
    assert.equal(metricByCruxName(m.cruxName)?.id, id);
  }
  assert.equal(metricByCruxName('round_trip_time'), undefined);
});

test('core web vitals are LCP, INP and CLS', () => {
  assert.deepEqual(
    METRIC_IDS.filter((id) => METRICS[id].core),
    ['lcp', 'inp', 'cls'],
  );
});

test('isMetricId', () => {
  assert.ok(isMetricId('inp'));
  assert.ok(!isMetricId('fid'));
  assert.ok(!isMetricId(3));
});

test('compareRatings and worstRating', () => {
  assert.ok(compareRatings('good', 'poor') > 0);
  assert.ok(compareRatings('poor', 'good') < 0);
  assert.equal(compareRatings('needs-improvement', 'needs-improvement'), 0);
  assert.equal(worstRating(['good', 'poor', 'needs-improvement']), 'poor');
  assert.equal(worstRating([]), null);
});

test('formatValue', () => {
  assert.equal(formatValue('lcp', 2450), '2.45 s');
  assert.equal(formatValue('lcp', 2000), '2 s');
  assert.equal(formatValue('inp', 180.4), '180 ms');
  assert.equal(formatValue('cls', 0.051), '0.05');
  assert.equal(formatValue('cls', null), 'n/a');
  assert.equal(formatValue('ttfb', Number.NaN), 'n/a');
});

test('formatDelta', () => {
  assert.equal(formatDelta('lcp', 120), '+120 ms');
  assert.equal(formatDelta('inp', -30), '-30 ms');
  assert.equal(formatDelta('cls', 0.03), '+0.03');
  assert.equal(formatDelta('lcp', 0), '±0 ms');
});
