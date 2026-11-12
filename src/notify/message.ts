import { formatValue, ratingLabel } from '../metrics.js';
import type { RunResult } from '../model.js';
import { budgetLine, regressionLine } from '../report/text.js';

export interface MessageOptions {
  reportUrl?: string;
  /** Cap the number of detail lines so chat messages stay readable. */
  maxLines?: number;
}

export function headline(run: RunResult): string {
  const s = run.summary;
  const state = s.passed ? 'PASSED' : 'FAILED';
  return `Core Web Vitals ${state}: ${s.targets} target(s), ${s.budgetFailures} budget failure(s), ${s.regressions} regression(s), ${s.errors} error(s)`;
}

/** Plain-text detail lines shared by every notifier. */
export function detailLines(run: RunResult): string[] {
  const lines: string[] = [];
  for (const r of run.results) {
    const label = `${r.name} [${r.formFactor.toLowerCase()}]`;
    const failed = r.budgets.filter((b) => !b.passed);
    if (failed.length === 0 && r.regressions.length === 0 && r.errors.length === 0) {
      const lcp = r.metrics.find((m) => m.metric === 'lcp');
      const overall = r.overall ? ratingLabel(r.overall) : 'no field data';
      lines.push(`${label}: ok (${overall}${lcp ? `, LCP ${formatValue('lcp', lcp.fieldP75)}` : ''})`);
      continue;
    }
    for (const b of failed) lines.push(`${label}: budget ${budgetLine(b)}`);
    for (const x of r.regressions) lines.push(`${label}: regression ${regressionLine(x)}`);
    for (const x of r.errors) lines.push(`${label}: ${x.source} error: ${x.message}`);
  }
  return lines;
}

export function plainMessage(run: RunResult, options: MessageOptions = {}): string {
  const max = options.maxLines ?? 25;
  const details = detailLines(run);
  const shown = details.slice(0, max);
  if (details.length > max) shown.push(`... and ${details.length - max} more`);
  const parts = [headline(run), '', ...shown];
  if (options.reportUrl) parts.push('', `Report: ${options.reportUrl}`);
  return parts.join('\n');
}
