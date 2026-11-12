import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LighthouseRuntimeError, PSI_ENDPOINT, PsiClient, parsePsi } from '../src/psi.js';
import { HttpClient } from '../src/http.js';
import { mockFetch, psiResponse } from './helpers.js';

test('buildUrl uses the v5 endpoint with url, strategy, category and key', () => {
  const psi = new PsiClient({
    http: new HttpClient({ fetch: async () => new Response('{}') }),
    apiKey: 'K1',
    locale: 'en',
  });
  const u = new URL(psi.buildUrl('https://www.example.com/a?b=1', 'desktop'));
  assert.equal(`${u.origin}${u.pathname}`, PSI_ENDPOINT);
  assert.equal(u.searchParams.get('url'), 'https://www.example.com/a?b=1');
  assert.equal(u.searchParams.get('strategy'), 'desktop');
  assert.equal(u.searchParams.get('category'), 'performance');
  assert.equal(u.searchParams.get('key'), 'K1');
  assert.equal(u.searchParams.get('locale'), 'en');
});

test('buildUrl without a key leaves it out', () => {
  const psi = new PsiClient({ http: new HttpClient({ fetch: async () => new Response('{}') }) });
  assert.equal(new URL(psi.buildUrl('https://a.test/', 'mobile')).searchParams.has('key'), false);
});

test('parsePsi extracts score, lab metrics and extras', () => {
  const lab = parsePsi(
    psiResponse({ score: 0.874, lcp: 2789.5, cls: 0.031, tbt: 410 }) as never,
    'https://www.example.com/',
    'mobile',
  );
  assert.equal(lab.performanceScore, 87);
  assert.equal(lab.metrics.lcp, 2789.5);
  assert.equal(lab.metrics.cls, 0.031);
  assert.equal(lab.metrics.ttfb, 180);
  assert.equal(lab.metrics.inp, undefined, 'INP has no lab equivalent');
  assert.equal(lab.extra.tbt, 410);
  assert.equal(lab.extra.si, 2400);
  assert.equal(lab.lighthouseVersion, '12.8.2');
  assert.equal(lab.fetchedAt, '2026-11-10T06:00:00.000Z');
});

test('parsePsi de-scales the CLS percentile from loadingExperience', () => {
  const lab = parsePsi(psiResponse({ fieldCls: 12, fieldLcp: 2600 }) as never, 'u', 'mobile');
  assert.equal(lab.field.cls, 0.12);
  assert.equal(lab.field.lcp, 2600);
});

test('parsePsi tolerates a missing performance score', () => {
  const raw = psiResponse() as { lighthouseResult: { categories: { performance: { score: number | null } } } };
  raw.lighthouseResult.categories.performance.score = null;
  assert.equal(parsePsi(raw as never, 'u', 'mobile').performanceScore, null);
});

test('parsePsi raises on Lighthouse runtime errors', () => {
  const raw = {
    lighthouseResult: { runtimeError: { code: 'FAILED_DOCUMENT_REQUEST', message: 'Could not load the page' } },
  };
  assert.throws(() => parsePsi(raw, 'u', 'mobile'), LighthouseRuntimeError);
  const ok = { lighthouseResult: { runtimeError: { code: 'NO_ERROR', message: '' }, audits: {} } };
  assert.doesNotThrow(() => parsePsi(ok, 'u', 'mobile'));
});

test('run issues a GET and returns lab data', async () => {
  const { fetch, calls } = mockFetch([['runPagespeed', () => ({ body: psiResponse() })]]);
  const lab = await new PsiClient({ http: new HttpClient({ fetch }), apiKey: 'K' }).run(
    'https://www.example.com/',
    'mobile',
  );
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(lab.strategy, 'mobile');
  assert.equal(lab.performanceScore, 91);
});

test('origin fallback flag is surfaced', () => {
  const raw = psiResponse() as { loadingExperience: { origin_fallback?: boolean } };
  raw.loadingExperience.origin_fallback = true;
  assert.equal(parsePsi(raw as never, 'u', 'mobile').fieldIsOriginFallback, true);
});
