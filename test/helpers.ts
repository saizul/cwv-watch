import type { FetchLike } from '../src/http.js';

export interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export type Handler = (
  call: Call,
) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Promise<never>;

/** A fetch double that routes on URL substrings and records every call. */
export function mockFetch(routes: Array<[RegExp | string, Handler]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    };
    calls.push(call);
    const route = routes.find(([pattern]) =>
      typeof pattern === 'string' ? input.includes(pattern) : pattern.test(input),
    );
    if (!route)
      return new Response(JSON.stringify({ error: { code: 500, message: `no route for ${input}` } }), { status: 500 });
    const out = await route[1](call);
    const text = out.text ?? JSON.stringify(out.body ?? {});
    return new Response(text, {
      status: out.status ?? 200,
      headers: out.headers ?? { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

export const noSleep = async (): Promise<void> => undefined;

/** CrUX queryRecord response with the given p75s (CLS as a string, as the API does). */
export function cruxRecord(
  key: Record<string, string>,
  p75: { lcp?: number; inp?: number; cls?: number; fcp?: number; ttfb?: number },
): unknown {
  const metrics: Record<string, unknown> = {};
  const add = (name: string, value: number | undefined, edges: [number | string, number | string], cls = false) => {
    if (value === undefined) return;
    metrics[name] = {
      histogram: [
        { start: cls ? '0.00' : 0, end: edges[0], density: 0.8 },
        { start: edges[0], end: edges[1], density: 0.15 },
        { start: edges[1], density: 0.05 },
      ],
      percentiles: { p75: cls ? value.toFixed(2) : value },
    };
  };
  add('largest_contentful_paint', p75.lcp, [2500, 4000]);
  add('interaction_to_next_paint', p75.inp, [200, 500]);
  add('cumulative_layout_shift', p75.cls, ['0.10', '0.25'], true);
  add('first_contentful_paint', p75.fcp, [1800, 3000]);
  add('experimental_time_to_first_byte', p75.ttfb, [800, 1800]);
  return {
    record: {
      key,
      metrics,
      collectionPeriod: {
        firstDate: { year: 2026, month: 10, day: 12 },
        lastDate: { year: 2026, month: 11, day: 8 },
      },
    },
  };
}

export function cruxHistory(
  key: Record<string, string>,
  lcp: Array<number | null>,
  cls?: Array<string | null>,
): unknown {
  const periods = lcp.map((_, i) => ({
    firstDate: { year: 2026, month: 1, day: 1 + i },
    lastDate: { year: 2026, month: 2, day: 1 + i },
  }));
  const metrics: Record<string, unknown> = {
    largest_contentful_paint: {
      histogramTimeseries: [
        { start: 0, end: 2500, densities: lcp.map((v) => (v === null ? 'NaN' : 0.8)) },
        { start: 2500, end: 4000, densities: lcp.map((v) => (v === null ? 'NaN' : 0.15)) },
        { start: 4000, densities: lcp.map((v) => (v === null ? 'NaN' : 0.05)) },
      ],
      percentilesTimeseries: { p75s: lcp },
    },
  };
  if (cls) metrics.cumulative_layout_shift = { percentilesTimeseries: { p75s: cls } };
  return { record: { key, metrics, collectionPeriods: periods } };
}

export function psiResponse(
  opts: {
    score?: number;
    lcp?: number;
    cls?: number;
    fcp?: number;
    tbt?: number;
    fieldLcp?: number;
    fieldCls?: number;
  } = {},
): unknown {
  return {
    id: 'https://www.example.com/',
    analysisUTCTimestamp: '2026-11-10T06:00:00.000Z',
    loadingExperience: {
      id: 'https://www.example.com/',
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: opts.fieldLcp ?? 2100, category: 'FAST' },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: opts.fieldCls ?? 5, category: 'FAST' },
      },
      overall_category: 'FAST',
    },
    lighthouseResult: {
      requestedUrl: 'https://www.example.com/',
      finalUrl: 'https://www.example.com/',
      lighthouseVersion: '12.8.2',
      categories: { performance: { score: opts.score ?? 0.91 } },
      audits: {
        'largest-contentful-paint': { id: 'largest-contentful-paint', numericValue: opts.lcp ?? 2300 },
        'cumulative-layout-shift': { id: 'cumulative-layout-shift', numericValue: opts.cls ?? 0.02 },
        'first-contentful-paint': { id: 'first-contentful-paint', numericValue: opts.fcp ?? 1200 },
        'server-response-time': { id: 'server-response-time', numericValue: 180 },
        'total-blocking-time': { id: 'total-blocking-time', numericValue: opts.tbt ?? 150 },
        'speed-index': { id: 'speed-index', numericValue: 2400 },
        interactive: { id: 'interactive', numericValue: 3500 },
      },
    },
  };
}
