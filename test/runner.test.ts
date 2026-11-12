import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labUrl, planJobs, psiStrategy, runWatch } from '../src/runner.js';
import { resolveConfig } from '../src/config.js';
import { cruxHistory, cruxRecord, mockFetch, noSleep, psiResponse, type Call } from './helpers.js';

function api(lcpByTarget: Record<string, number> = {}) {
  return mockFetch([
    [
      ':queryRecord',
      (c: Call) => {
        const body = c.body as { url?: string; origin?: string; formFactor?: string };
        const id = body.url ?? body.origin!;
        if (id.includes('nodata'))
          return {
            status: 404,
            body: { error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } },
          };
        return {
          body: cruxRecord(
            { ...(body.url ? { url: id } : { origin: id }), formFactor: body.formFactor ?? 'ALL' },
            { lcp: lcpByTarget[id] ?? 2100, inp: 150, cls: 0.05, fcp: 1500, ttfb: 500 },
          ),
        };
      },
    ],
    [':queryHistoryRecord', () => ({ body: cruxHistory({ origin: 'x' }, [2000, 2000, 2010, 2000, 2005]) })],
    ['runPagespeed', () => ({ body: psiResponse() })],
  ]);
}

test('psiStrategy and labUrl', () => {
  assert.equal(psiStrategy('DESKTOP'), 'desktop');
  assert.equal(psiStrategy('PHONE'), 'mobile');
  assert.equal(labUrl({ name: 'o', origin: 'https://a.test' }), 'https://a.test/');
  assert.equal(labUrl({ name: 'u', url: 'https://a.test/x' }), 'https://a.test/x');
});

test('planJobs expands targets by form factor', () => {
  const c = resolveConfig({
    targets: [{ url: 'https://a.test/' }, { origin: 'https://a.test', formFactors: ['TABLET'] }],
  });
  assert.deepEqual(
    planJobs(c).map((j) => `${j.target.name}:${j.formFactor}`),
    ['https://a.test/:PHONE', 'https://a.test/:DESKTOP', 'https://a.test:TABLET'],
  );
});

test('full run calls CrUX record, CrUX history and PSI for each job', async () => {
  const { fetch, calls } = api();
  const config = resolveConfig({ targets: [{ name: 'Home', url: 'https://www.example.com/' }] });
  const result = await runWatch({ config, apiKey: 'K', fetch, sleep: noSleep });
  assert.equal(result.results.length, 2);
  assert.equal(calls.filter((c) => c.url.includes(':queryRecord')).length, 2);
  assert.equal(calls.filter((c) => c.url.includes(':queryHistoryRecord')).length, 2);
  const psi = calls
    .filter((c) => c.url.includes('runPagespeed'))
    .map((c) => new URL(c.url).searchParams.get('strategy'));
  assert.deepEqual(psi.sort(), ['desktop', 'mobile']);
  assert.equal(result.summary.passed, true);
  assert.equal(result.results[0]!.metrics[0]!.trend?.direction, 'stable');
  assert.equal(result.tool, 'cwv-watch');
});

test('no PSI for tablet or skipLab targets, and sources can be disabled', async () => {
  const { fetch, calls } = api();
  const config = resolveConfig({
    targets: [
      { name: 'A', url: 'https://a.test/', formFactors: ['TABLET'] },
      { name: 'B', url: 'https://b.test/', skipLab: true },
    ],
    formFactors: ['PHONE'],
    sources: { history: false },
  });
  await runWatch({ config, apiKey: 'K', fetch, sleep: noSleep });
  assert.equal(calls.filter((c) => c.url.includes('runPagespeed')).length, 0);
  assert.equal(calls.filter((c) => c.url.includes('History')).length, 0);
});

test('404 from CrUX is "no data", not an error', async () => {
  const { fetch } = api();
  const config = resolveConfig({
    targets: [{ name: 'Tiny', url: 'https://nodata.example.com/' }],
    formFactors: ['PHONE'],
    sources: { psi: false, history: false },
  });
  const r = await runWatch({ config, apiKey: 'K', fetch, sleep: noSleep });
  assert.equal(r.results[0]!.field, null);
  assert.equal(r.results[0]!.errors.length, 0);
  assert.equal(r.summary.passed, true);
});

test('API failures are recorded per source without aborting the run', async () => {
  const { fetch } = mockFetch([
    [
      ':queryRecord',
      () => ({
        status: 403,
        body: { error: { code: 403, message: 'Requests to this API are blocked', status: 'PERMISSION_DENIED' } },
      }),
    ],
    [':queryHistoryRecord', () => ({ body: cruxHistory({ origin: 'x' }, [1, 2, 3]) })],
    ['runPagespeed', () => ({ body: { lighthouseResult: { runtimeError: { code: 'NO_FCP', message: 'no paint' } } } })],
  ]);
  const config = resolveConfig({ targets: [{ name: 'A', url: 'https://a.test/' }], formFactors: ['PHONE'] });
  const r = await runWatch({ config, apiKey: 'SECRET-KEY-1', fetch, sleep: noSleep });
  const errs = r.results[0]!.errors;
  assert.deepEqual(errs.map((e) => e.source).sort(), ['crux', 'psi']);
  assert.ok(errs.every((e) => !e.message.includes('SECRET-KEY-1')));
  assert.equal(r.summary.errors, 2);
});

test('regressions against the previous run', async () => {
  const config = resolveConfig({
    targets: [{ name: 'Home', url: 'https://www.example.com/' }],
    formFactors: ['PHONE'],
    sources: { psi: false, history: false },
  });
  const first = await runWatch({ config, apiKey: 'K', fetch: api().fetch, sleep: noSleep });
  const second = await runWatch({
    config,
    apiKey: 'K',
    previous: first,
    fetch: api({ 'https://www.example.com/': 2450 }).fetch,
    sleep: noSleep,
  });
  assert.equal(second.results[0]!.regressions[0]?.metric, 'lcp');
  assert.equal(second.summary.regressions, 1);
  assert.equal(second.previousRunAt, first.finishedAt);
});

test('a CrUX key is required unless CrUX sources are off', async () => {
  const config = resolveConfig({ targets: ['https://a.test'] });
  await assert.rejects(runWatch({ config, apiKey: undefined, fetch: api().fetch }), /CWV_API_KEY/);
  const labOnly = resolveConfig({
    targets: ['https://a.test'],
    formFactors: ['PHONE'],
    sources: { crux: false, history: false },
  });
  const r = await runWatch({ config: labOnly, apiKey: undefined, fetch: api().fetch, sleep: noSleep });
  assert.equal(r.results[0]!.lab?.performanceScore, 91);
});

test('concurrency limit applies to each API separately', async () => {
  const active = { crux: 0, psi: 0 };
  const peak = { crux: 0, psi: 0 };
  const base = api();
  const fetch = async (url: string, init?: RequestInit) => {
    const api = url.includes('chromeuxreport') ? 'crux' : 'psi';
    active[api]++;
    peak[api] = Math.max(peak[api], active[api]);
    await new Promise((r) => setTimeout(r, 3));
    try {
      return await base.fetch(url, init);
    } finally {
      active[api]--;
    }
  };
  const config = resolveConfig({
    targets: Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, url: `https://a.test/${i}` })),
    concurrency: 2,
  });
  await runWatch({ config, apiKey: 'K', fetch, sleep: noSleep });
  assert.ok(peak.crux <= 2, `crux peak ${peak.crux}`);
  assert.ok(peak.psi <= 2, `psi peak ${peak.psi}`);
  assert.ok(peak.crux >= 1 && peak.psi >= 1);
});
