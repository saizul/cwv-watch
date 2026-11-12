// Use cwv-watch as a library: query CrUX and PageSpeed Insights directly.
//
//   npm run build
//   CWV_API_KEY=your-key node examples/library.mjs https://www.example.com/
import { CruxClient, HttpClient, Limiter, PsiClient, formatValue, rate } from '../dist/src/index.js';

const url = process.argv[2] ?? 'https://www.example.com/';
const apiKey = process.env.CWV_API_KEY;
if (!apiKey) {
  console.error('Set CWV_API_KEY first.');
  process.exit(2);
}

const http = new HttpClient({ secrets: [apiKey] });
const limiter = new Limiter({ concurrency: 2, maxPerInterval: 120 });
const crux = new CruxClient({ http, apiKey, limiter });
const psi = new PsiClient({ http, apiKey, limiter });

const field = await crux.queryRecord({ url, formFactor: 'PHONE' });
if (!field) {
  console.log(`CrUX has no page-level data for ${url}; trying the origin.`);
}
const data = field ?? (await crux.queryRecord({ origin: new URL(url).origin, formFactor: 'PHONE' }));
for (const [metric, value] of Object.entries(data?.metrics ?? {})) {
  if (value.p75 !== null)
    console.log(`${metric.toUpperCase()} p75 ${formatValue(metric, value.p75)} (${rate(metric, value.p75)})`);
}

const history = await crux.queryHistoryRecord({ origin: new URL(url).origin, formFactor: 'PHONE' }, 10);
console.log('LCP p75 by week:', history?.p75s.lcp);

const lab = await psi.run(url, 'mobile');
console.log(`Lighthouse performance score: ${lab.performanceScore}`);
