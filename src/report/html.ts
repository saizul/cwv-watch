import { describeLimit } from '../evaluate.js';
import { METRICS, formatDelta, formatValue, ratingLabel, type MetricId, type Rating } from '../metrics.js';
import type { MetricSummary, RunResult, TargetResult } from '../model.js';
import { escapeHtml as e } from './escape.js';
import { svgSparkline } from './sparkline.js';
import { formatBudgetValue, regressionLine, trendLabel } from './text.js';

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2330;--muted:#5f6878;--line:#e3e6ec;--card:#f7f8fa;
--good:#0a8f5c;--ni:#c26a00;--poor:#c7302b;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e8ebf1;--muted:#9aa3b2;--line:#2a303b;--card:#1a1e26;
--good:#3ccf8e;--ni:#f2a43a;--poor:#ff6b62;--accent:#7b9bff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 8px}
.muted{color:var(--muted)}.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600}
.status.pass{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}
.status.fail{background:color-mix(in srgb,var(--poor) 15%,transparent);color:var(--poor)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;margin:8px 0 12px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
.r-good{color:var(--good)}.r-needs-improvement{color:var(--ni)}.r-poor{color:var(--poor)}
.pill{display:inline-block;min-width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px;background:currentColor}
.dist{display:flex;height:8px;width:110px;border-radius:4px;overflow:hidden;background:var(--line)}
.dist span:nth-child(1){background:var(--good)}.dist span:nth-child(2){background:var(--ni)}.dist span:nth-child(3){background:var(--poor)}
.spark-line{stroke:var(--accent);stroke-width:1.5}.spark-last,.spark-dot{fill:var(--accent)}
.spark-good{stroke:var(--good);stroke-dasharray:2 2;opacity:.6}.spark-poor{stroke:var(--poor);stroke-dasharray:2 2;opacity:.6}
.spark-empty{fill:var(--muted);font-size:10px}ul.issues{margin:6px 0 0;padding-left:18px}.issues li{margin:2px 0}
.fail{color:var(--poor)}.warn{color:var(--ni)}footer{margin-top:48px;font-size:12px}a{color:var(--accent)}
`;

function ratingCell(rating: Rating | null, text: string): string {
  if (!rating) return `<span class="muted">${e(text)}</span>`;
  return `<span class="r-${rating}" title="${e(ratingLabel(rating))}"><span class="pill"></span>${e(text)}</span>`;
}

function distribution(m: MetricSummary, r: TargetResult): string {
  const d = r.field?.metrics[m.metric]?.distribution;
  if (!d) return '<span class="muted">—</span>';
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const label = `good ${pct(d.good)}, needs improvement ${pct(d.needsImprovement)}, poor ${pct(d.poor)}`;
  return `<div class="dist" title="${e(label)}"><span style="width:${pct(d.good)}"></span><span style="width:${pct(d.needsImprovement)}"></span><span style="width:${pct(d.poor)}"></span></div>`;
}

function spark(metric: MetricId, m: MetricSummary): string {
  if (!m.trend) return '<span class="muted">—</span>';
  const def = METRICS[metric];
  const periods = m.trend.periods;
  return svgSparkline(m.trend.values, {
    title: `${def.name} p75, ${periods[0] ?? ''} to ${periods[periods.length - 1] ?? ''}`,
    references: [
      { value: def.good, className: 'spark-good' },
      { value: def.poor, className: 'spark-poor' },
    ],
    format: (v) => formatValue(metric, v),
  });
}

function targetSection(r: TargetResult): string {
  const rows = r.metrics
    .map((m) => {
      const delta = m.delta === null ? '—' : formatDelta(m.metric, m.delta);
      const deltaClass = m.delta !== null && m.delta > 0 ? 'warn' : '';
      return `<tr><th scope="row">${e(METRICS[m.metric].name)} <span class="muted">${m.metric.toUpperCase()}</span></th>
<td class="num">${ratingCell(m.fieldRating, formatValue(m.metric, m.fieldP75))}</td>
<td>${distribution(m, r)}</td><td class="num ${deltaClass}">${e(delta)}</td>
<td>${spark(m.metric, m)}<div class="muted">${e(trendLabel(m.trend))}</div></td>
<td class="num">${ratingCell(m.labRating, formatValue(m.metric, m.labValue))}</td></tr>`;
    })
    .join('\n');

  const issues: string[] = [];
  for (const b of r.budgets.filter((x) => !x.passed)) {
    const name = b.metric === 'performanceScore' ? 'Performance score' : b.metric.toUpperCase();
    issues.push(
      `<li class="fail">Budget: ${e(name)} (${b.source}) ${e(formatBudgetValue(b))}, limit ${e(describeLimit(b.metric, b.limit))}</li>`,
    );
  }
  for (const x of r.regressions) issues.push(`<li class="warn">Regression: ${e(regressionLine(x))}</li>`);
  for (const x of r.errors) issues.push(`<li class="muted">${e(x.source)} error: ${e(x.message)}</li>`);

  const where = r.url
    ? `<a href="${e(r.url)}" rel="noopener noreferrer">${e(r.url)}</a>`
    : `origin <a href="${e(r.origin)}" rel="noopener noreferrer">${e(r.origin)}</a>`;
  const lab = r.lab
    ? ` · Lighthouse ${e(r.lab.lighthouseVersion ?? '')} score <b>${e(r.lab.performanceScore ?? 'n/a')}</b>`
    : '';
  const noField = r.field ? '' : ' · <span class="muted">no CrUX field data</span>';
  return `<section id="${e(r.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase())}">
<h2>${e(r.name)} <span class="muted">· ${e(r.formFactor.toLowerCase())}</span></h2>
<div class="muted">${where}${lab}${noField}</div>
<table><thead><tr><th>Metric</th><th>Field p75</th><th>Distribution</th><th>Change</th><th>Trend</th><th>Lab</th></tr></thead>
<tbody>${rows}</tbody></table>
${issues.length > 0 ? `<ul class="issues">${issues.join('')}</ul>` : ''}
</section>`;
}

/** Self-contained HTML report: no scripts, no external requests, light and dark mode. */
export function renderHtml(run: RunResult): string {
  const s = run.summary;
  const card = (label: string, value: number | string, cls = '') =>
    `<div class="card"><span class="muted">${e(label)}</span><b class="${cls}">${e(value)}</b></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Core Web Vitals report</title><style>${CSS}</style></head>
<body><main>
<h1>Core Web Vitals report</h1>
<div><span class="status ${s.passed ? 'pass' : 'fail'}">${s.passed ? 'Passed' : 'Failed'}</span>
<span class="muted"> ${e(run.finishedAt.replace('T', ' ').slice(0, 16))} UTC${run.previousRunAt ? ` · compared with ${e(run.previousRunAt.slice(0, 10))}` : ''}</span></div>
<div class="cards">${card('Targets', s.targets)}${card('With field data', s.withFieldData)}${card('Budget failures', s.budgetFailures, s.budgetFailures ? 'fail' : '')}${card('Regressions', s.regressions, s.regressions ? 'warn' : '')}${card('Worsening trends', s.worsening, s.worsening ? 'warn' : '')}${card('Errors', s.errors)}</div>
${run.results.map(targetSection).join('\n')}
<footer class="muted">cwv-watch ${e(run.version)}. Field data from the Chrome UX Report (75th percentile over 28 days, weekly history).
Lab data from PageSpeed Insights (single Lighthouse run). Dashed lines in the sparklines mark the good and poor boundaries.</footer>
</main></body></html>
`;
}
