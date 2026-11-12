import { formatDelta, formatValue, ratingLabel, type Rating } from '../metrics.js';
import type { RunResult, TargetResult } from '../model.js';
import { escapeMd } from './escape.js';
import { textSparkline } from './sparkline.js';
import { budgetLine, metricShort, regressionLine, trendLabel } from './text.js';

const BADGE: Record<Rating, string> = { good: '🟢', 'needs-improvement': '🟠', poor: '🔴' };

function badge(rating: Rating | null): string {
  return rating ? `${BADGE[rating]} ${ratingLabel(rating)}` : '—';
}

function targetTitle(r: TargetResult): string {
  return `${r.name} · ${r.formFactor.toLowerCase()}`;
}

export function renderMarkdown(run: RunResult): string {
  const s = run.summary;
  const out: string[] = [];
  out.push('# Core Web Vitals report', '');
  out.push(
    `${s.passed ? '✅ **Passed**' : '❌ **Failed**'} · ${run.finishedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
  );
  out.push(
    `| Targets | With field data | Budget failures | Regressions | Worsening trends | Errors |`,
    `|---:|---:|---:|---:|---:|---:|`,
    `| ${s.targets} | ${s.withFieldData} | ${s.budgetFailures} | ${s.regressions} | ${s.worsening} | ${s.errors} |`,
    '',
  );
  if (run.previousRunAt) out.push(`Compared with the run of ${run.previousRunAt.slice(0, 10)}.`, '');

  out.push(
    '## Overview',
    '',
    '| Target | Form factor | Overall | LCP | INP | CLS | Lab score |',
    '|---|---|---|---:|---:|---:|---:|',
  );
  for (const r of run.results) {
    const cell = (id: 'lcp' | 'inp' | 'cls') => {
      const m = r.metrics.find((x) => x.metric === id);
      return m ? formatValue(id, m.fieldP75) : '—';
    };
    out.push(
      `| ${escapeMd(r.name)} | ${r.formFactor} | ${badge(r.overall)} | ${cell('lcp')} | ${cell('inp')} | ${cell('cls')} | ${r.lab?.performanceScore ?? '—'} |`,
    );
  }
  out.push('');

  for (const r of run.results) {
    out.push(`## ${escapeMd(targetTitle(r))}`, '');
    out.push(`${r.url ? `URL: ${r.url}` : `Origin: ${r.origin}`}`);
    const period = r.field?.collectionPeriod;
    if (period) {
      const d = (x: typeof period.firstDate) =>
        `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`;
      out.push(`CrUX collection period: ${d(period.firstDate)} to ${d(period.lastDate)}`);
    }
    if (!r.field && !r.errors.some((e) => e.source === 'crux')) out.push('No CrUX field data for this target.');
    out.push('');
    out.push(
      '| Metric | Field p75 | Rating | Good share | Change | Trend | History | Lab |',
      '|---|---:|---|---:|---:|---|---|---:|',
    );
    for (const m of r.metrics) {
      const share = m.goodShare === null ? '—' : `${(m.goodShare * 100).toFixed(0)}%`;
      const change = m.delta === null ? '—' : formatDelta(m.metric, m.delta);
      const spark = m.trend ? `\`${textSparkline(m.trend.values)}\`` : '—';
      out.push(
        `| ${metricShort(m.metric)} | ${formatValue(m.metric, m.fieldP75)} | ${badge(m.fieldRating)} | ${share} | ${change} | ${trendLabel(m.trend) || '—'} | ${spark} | ${formatValue(m.metric, m.labValue)} |`,
      );
    }
    out.push('');
    const failed = r.budgets.filter((b) => !b.passed);
    if (failed.length > 0) {
      out.push('**Budget failures**', '', ...failed.map((b) => `- ${escapeMd(budgetLine(b))}`), '');
    }
    if (r.regressions.length > 0) {
      out.push('**Regressions since the previous run**', '', ...r.regressions.map((x) => `- ${regressionLine(x)}`), '');
    }
    if (r.errors.length > 0) {
      out.push('**Errors**', '', ...r.errors.map((e) => `- ${e.source}: ${escapeMd(e.message)}`), '');
    }
  }
  out.push(
    '---',
    '',
    `Report created with cwv-watch ${run.version}. Field data: Chrome UX Report (p75, 28 days). Lab data: PageSpeed Insights.`,
    '',
  );
  return out.join('\n');
}
