// Run the whole pipeline against canned API responses, without an API key or
// network access, and write sample reports to examples/sample-report/.
//
//   npm run build && node examples/offline-demo.mjs
import { resolveConfig, runWatch, writeReports } from '../dist/src/index.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pages = {
  'https://www.example.com/': { lcp: 2140, inp: 160, cls: '0.04', fcp: 1350, ttfb: 620 },
  'https://www.example.com/products/blue-widget': { lcp: 3320, inp: 240, cls: '0.18', fcp: 2100, ttfb: 910 },
};

function record(id, p) {
  const metric = (p75, edges) => ({
    histogram: [
      { start: 0, end: edges[0], density: 0.71 },
      { start: edges[0], end: edges[1], density: 0.19 },
      { start: edges[1], density: 0.1 },
    ],
    percentiles: { p75 },
  });
  return {
    record: {
      key: { url: id },
      metrics: {
        largest_contentful_paint: metric(p.lcp, [2500, 4000]),
        interaction_to_next_paint: metric(p.inp, [200, 500]),
        cumulative_layout_shift: metric(p.cls, ['0.10', '0.25']),
        first_contentful_paint: metric(p.fcp, [1800, 3000]),
        experimental_time_to_first_byte: metric(p.ttfb, [800, 1800]),
      },
      collectionPeriod: { firstDate: { year: 2026, month: 10, day: 12 }, lastDate: { year: 2026, month: 11, day: 8 } },
    },
  };
}

function history(p) {
  const n = 12;
  const wave = (base, step) => Array.from({ length: n }, (_, i) => (i === 4 ? null : Math.round(base + step * i)));
  const periods = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 16 + 7 * i));
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    return { firstDate: day, lastDate: day };
  });
  return {
    record: {
      metrics: {
        largest_contentful_paint: { percentilesTimeseries: { p75s: wave(p.lcp - 300, 30) } },
        interaction_to_next_paint: { percentilesTimeseries: { p75s: wave(p.inp + 40, -4) } },
        cumulative_layout_shift: {
          percentilesTimeseries: {
            p75s: wave(Number(p.cls) * 100, 0).map((v) => (v === null ? null : (v / 100).toFixed(2))),
          },
        },
      },
      collectionPeriods: periods,
    },
  };
}

const fakeFetch = async (url, init) => {
  if (url.includes('chromeuxreport')) {
    const body = JSON.parse(init.body);
    const p = pages[body.url];
    if (!p) return json({ error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } }, 404);
    return json(url.includes('History') ? history(p) : record(body.url, p));
  }
  const strategy = new URL(url).searchParams.get('strategy');
  return json({
    analysisUTCTimestamp: '2026-11-12T06:00:00.000Z',
    lighthouseResult: {
      lighthouseVersion: '12.8.2',
      categories: { performance: { score: strategy === 'mobile' ? 0.68 : 0.93 } },
      audits: {
        'largest-contentful-paint': { numericValue: strategy === 'mobile' ? 3900 : 1500 },
        'cumulative-layout-shift': { numericValue: 0.06 },
        'first-contentful-paint': { numericValue: 1800 },
        'server-response-time': { numericValue: 240 },
        'total-blocking-time': { numericValue: 420 },
      },
    },
  });
};

const config = resolveConfig({
  targets: [
    { name: 'Home', url: 'https://www.example.com/' },
    { name: 'Product page', url: 'https://www.example.com/products/blue-widget' },
    { name: 'New landing page', url: 'https://www.example.com/landing/new' },
  ],
  labBudgets: { performanceScore: 70 },
});

const now = () => Date.parse('2026-11-12T06:00:00Z');
const run = await runWatch({ config, apiKey: 'offline-demo', fetch: fakeFetch, sleep: async () => {}, now });
const files = await writeReports(run, 'examples/sample-report', ['md', 'html', 'junit']);
console.log(`Wrote ${files.join(', ')} (${run.summary.passed ? 'passed' : 'failed'})`);
