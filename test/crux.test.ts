import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRUX_ENDPOINT,
  CruxClient,
  buildBody,
  distributionFromBins,
  isoDate,
  parseHistory,
  parseRecord,
  toNumber,
} from '../src/crux.js';
import { HttpClient } from '../src/http.js';
import { ApiError } from '../src/errors.js';
import { Limiter } from '../src/limiter.js';
import { cruxHistory, cruxRecord, mockFetch, noSleep } from './helpers.js';

const client = (fetch: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(fetch);
  return {
    ...m,
    crux: new CruxClient({ http: new HttpClient({ fetch: m.fetch, sleep: noSleep, retries: 0 }), apiKey: 'TESTKEY' }),
  };
};

test('buildBody for a URL with a form factor', () => {
  assert.deepEqual(buildBody({ url: 'https://www.example.com/a', formFactor: 'PHONE', metrics: ['lcp', 'cls'] }), {
    url: 'https://www.example.com/a',
    formFactor: 'PHONE',
    metrics: ['largest_contentful_paint', 'cumulative_layout_shift'],
  });
});

test('buildBody omits formFactor for ALL_FORM_FACTORS and requests all metrics by default', () => {
  const body = buildBody({ origin: 'https://www.example.com', formFactor: 'ALL_FORM_FACTORS' });
  assert.equal(body.formFactor, undefined);
  assert.deepEqual(body.metrics, [
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift',
    'first_contentful_paint',
    'experimental_time_to_first_byte',
  ]);
});

test('buildBody needs exactly one of url and origin', () => {
  assert.throws(() => buildBody({}));
  assert.throws(() => buildBody({ url: 'https://a.test/', origin: 'https://a.test' }));
});

test('toNumber handles strings, NaN and null', () => {
  assert.equal(toNumber('0.05'), 0.05);
  assert.equal(toNumber(12), 12);
  assert.equal(toNumber('NaN'), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
});

test('distributionFromBins needs three complete bins', () => {
  assert.deepEqual(distributionFromBins([0.7, 0.2, 0.1]), { good: 0.7, needsImprovement: 0.2, poor: 0.1 });
  assert.equal(distributionFromBins([0.7, 0.3]), null);
  assert.equal(distributionFromBins([0.7, null, 0.1]), null);
});

test('queryRecord posts to the documented endpoint with the key as a query parameter', async () => {
  const { crux, calls } = client([
    [
      ':queryRecord',
      () => ({ body: cruxRecord({ url: 'https://www.example.com/', formFactor: 'PHONE' }, { lcp: 2100 }) }),
    ],
  ]);
  await crux.queryRecord({ url: 'https://www.example.com/', formFactor: 'PHONE' });
  assert.equal(calls[0]!.url, `${CRUX_ENDPOINT}:queryRecord?key=TESTKEY`);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal((calls[0]!.body as { url: string }).url, 'https://www.example.com/');
});

test('parseRecord normalises p75 values, CLS strings and distributions', () => {
  const raw = cruxRecord(
    { origin: 'https://www.example.com', formFactor: 'DESKTOP' },
    { lcp: 2300, inp: 150, cls: 0.07, fcp: 1500, ttfb: 600 },
  );
  const data = parseRecord(raw as never, { origin: 'https://www.example.com', formFactor: 'DESKTOP' });
  assert.equal(data.metrics.lcp?.p75, 2300);
  assert.equal(data.metrics.cls?.p75, 0.07);
  assert.equal(typeof data.metrics.cls?.p75, 'number');
  assert.equal(data.metrics.ttfb?.p75, 600);
  assert.deepEqual(data.metrics.inp?.distribution, { good: 0.8, needsImprovement: 0.15, poor: 0.05 });
  assert.deepEqual(data.key, { origin: 'https://www.example.com', formFactor: 'DESKTOP' });
  assert.equal(data.collectionPeriod?.lastDate.day, 8);
});

test('parseRecord ignores metrics it does not know and keeps normalizedUrl', () => {
  const raw = {
    record: {
      key: { url: 'https://www.example.com/' },
      metrics: {
        round_trip_time: { percentiles: { p75: 120 } },
        navigation_types: { fractions: { navigate: 0.5 } },
        largest_contentful_paint: { histogram: [], percentiles: { p75: 1900 } },
      },
    },
    urlNormalizationDetails: {
      originalUrl: 'https://www.example.com/?utm=x',
      normalizedUrl: 'https://www.example.com/',
    },
  };
  const data = parseRecord(raw as never, { url: 'https://www.example.com/?utm=x' });
  assert.deepEqual(Object.keys(data.metrics), ['lcp']);
  assert.equal(data.metrics.lcp?.distribution, null);
  assert.equal(data.normalizedUrl, 'https://www.example.com/');
  assert.equal(data.key.formFactor, 'ALL_FORM_FACTORS');
});

test('queryRecord returns null on 404 (no CrUX data)', async () => {
  const { crux } = client([
    [
      ':queryRecord',
      () => ({
        status: 404,
        body: { error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } },
      }),
    ],
  ]);
  assert.equal(await crux.queryRecord({ url: 'https://tiny.example.com/' }), null);
});

test('queryRecord rethrows other API errors', async () => {
  const { crux } = client([
    [':queryRecord', () => ({ status: 400, body: { error: { code: 400, message: 'API key not valid' } } })],
  ]);
  await assert.rejects(
    crux.queryRecord({ origin: 'https://www.example.com' }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test('queryHistoryRecord sends collectionPeriodCount and parses time series', async () => {
  const { crux, calls } = client([
    [
      ':queryHistoryRecord',
      () => ({
        body: cruxHistory(
          { origin: 'https://www.example.com' },
          [2000, null, 2100, 2200],
          ['0.05', null, '0.06', '0.07'],
        ),
      }),
    ],
  ]);
  const h = await crux.queryHistoryRecord({ origin: 'https://www.example.com' }, 4);
  assert.equal((calls[0]!.body as { collectionPeriodCount: number }).collectionPeriodCount, 4);
  assert.ok(calls[0]!.url.includes(':queryHistoryRecord?key='));
  assert.deepEqual(h?.p75s.lcp, [2000, null, 2100, 2200]);
  assert.deepEqual(h?.p75s.cls, [0.05, null, 0.06, 0.07]);
  assert.deepEqual(h?.goodShare.lcp, [0.8, null, 0.8, 0.8]);
  assert.deepEqual(h?.periods, ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04']);
});

test('queryHistoryRecord validates collectionPeriodCount (1-40)', async () => {
  const { crux } = client([]);
  await assert.rejects(crux.queryHistoryRecord({ origin: 'https://a.test' }, 0), RangeError);
  await assert.rejects(crux.queryHistoryRecord({ origin: 'https://a.test' }, 41), RangeError);
});

test('queryHistoryRecord returns null on 404', async () => {
  const { crux } = client([[':queryHistoryRecord', () => ({ status: 404, body: {} })]]);
  assert.equal(await crux.queryHistoryRecord({ origin: 'https://a.test' }), null);
});

test('parseHistory with an empty record', () => {
  const h = parseHistory({}, { origin: 'https://a.test', formFactor: 'PHONE' });
  assert.deepEqual(h.periods, []);
  assert.deepEqual(h.p75s, {});
  assert.equal(h.key.formFactor, 'PHONE');
});

test('requests go through the limiter', async () => {
  const { fetch } = mockFetch([
    [':queryRecord', () => ({ body: cruxRecord({ origin: 'https://a.test' }, { lcp: 1 }) })],
  ]);
  const limiter = new Limiter({ concurrency: 1, maxPerInterval: 0 });
  let wrapped = 0;
  const run = limiter.run.bind(limiter);
  limiter.run = (task) => {
    wrapped++;
    return run(task);
  };
  const crux = new CruxClient({ http: new HttpClient({ fetch }), apiKey: 'K', limiter });
  await crux.queryRecord({ origin: 'https://a.test' });
  assert.equal(wrapped, 1);
});

test('the client requires an API key', () => {
  assert.throws(() => new CruxClient({ http: new HttpClient({ fetch: async () => new Response('{}') }), apiKey: '' }));
});

test('isoDate pads month and day', () => {
  assert.equal(isoDate({ year: 2026, month: 3, day: 7 }), '2026-03-07');
});
