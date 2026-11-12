import { describeLimit } from '../evaluate.js';
import { METRICS, formatValue, ratingLabel, type MetricId } from '../metrics.js';
import type { BudgetCheck, Regression, Trend } from '../model.js';

export function formatBudgetValue(check: BudgetCheck): string {
  if (check.value === null) return 'n/a';
  if (check.metric === 'performanceScore') return String(check.value);
  if (check.metric === 'tbt') return `${Math.round(check.value)} ms`;
  return formatValue(check.metric, check.value);
}

export function budgetLine(check: BudgetCheck): string {
  const name = check.metric === 'performanceScore' ? 'Performance score' : check.metric.toUpperCase();
  const status = check.skipped ? `skipped (${check.skipped})` : check.passed ? 'pass' : 'FAIL';
  return `${name} (${check.source}) ${formatBudgetValue(check)} vs ${describeLimit(check.metric, check.limit)}: ${status}`;
}

export function regressionLine(r: Regression): string {
  const pct = Number.isFinite(r.relative) ? `${(r.relative * 100).toFixed(1)}%` : 'new';
  const why =
    r.reason === 'rating-drop'
      ? `rating ${ratingLabel(r.previousRating)} -> ${ratingLabel(r.currentRating)}`
      : `+${pct}`;
  return `${r.metric.toUpperCase()} ${formatValue(r.metric, r.previous)} -> ${formatValue(r.metric, r.current)} (${why})`;
}

export function trendLabel(trend: Trend | null): string {
  if (!trend) return '';
  switch (trend.direction) {
    case 'improving':
      return `improving${trend.change !== null ? ` (${(trend.change * 100).toFixed(1)}%)` : ''}`;
    case 'worsening':
      return `worsening${trend.change !== null ? ` (+${(trend.change * 100).toFixed(1)}%)` : ''}`;
    case 'stable':
      return 'stable';
    case 'insufficient-data':
      return 'not enough data';
  }
}

export function metricShort(metric: MetricId): string {
  return METRICS[metric].id.toUpperCase();
}
