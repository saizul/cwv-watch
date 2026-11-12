import type { BudgetValue, Config, LabBudgets, Budgets, RegressionConfig } from './config.js';
import { METRICS, compareRatings, rate, worstRating, CORE_METRIC_IDS, type MetricId } from './metrics.js';
import type { BudgetCheck, MetricSummary, Regression, RunResult, RunSummary, TargetResult } from './model.js';
import type { FieldData, HistoryData } from './crux.js';
import type { LabData } from './psi.js';
import { computeTrend } from './trend.js';

/** A budget passes when the value is at or under a numeric limit, or rated no worse than a rating limit. */
export function checkBudget(metric: MetricId, limit: BudgetValue, value: number | null): BudgetCheck {
  const check: BudgetCheck = { metric, source: 'field', limit, value, passed: true };
  if (value === null) {
    check.skipped = 'no field data';
    return check;
  }
  check.passed = typeof limit === 'number' ? value <= limit : compareRatings(limit, rate(metric, value)) <= 0;
  return check;
}

export function checkFieldBudgets(budgets: Budgets, field: FieldData | null, metrics: MetricId[]): BudgetCheck[] {
  const out: BudgetCheck[] = [];
  for (const metric of metrics) {
    const limit = budgets[metric];
    if (limit === undefined) continue;
    out.push(checkBudget(metric, limit, field?.metrics[metric]?.p75 ?? null));
  }
  return out;
}

export function checkLabBudgets(budgets: LabBudgets, lab: LabData | null): BudgetCheck[] {
  const out: BudgetCheck[] = [];
  for (const [key, limit] of Object.entries(budgets) as Array<[keyof LabBudgets, number]>) {
    let value: number | null;
    if (key === 'performanceScore') value = lab?.performanceScore ?? null;
    else if (key === 'tbt') value = lab?.extra.tbt ?? null;
    else value = lab?.metrics[key] ?? null;
    const check: BudgetCheck = { metric: key, source: 'lab', limit, value, passed: true };
    if (value === null) check.skipped = lab ? 'metric not in Lighthouse result' : 'no lab data';
    // The performance score is a floor; every other lab budget is a ceiling.
    else check.passed = key === 'performanceScore' ? value >= limit : value <= limit;
    out.push(check);
  }
  return out;
}

/**
 * A regression is a p75 that got worse than the previous run by both the
 * relative and the absolute threshold, or (optionally) one whose rating dropped.
 */
export function detectRegression(
  metric: MetricId,
  previous: number | null | undefined,
  current: number | null | undefined,
  config: RegressionConfig,
): Regression | null {
  if (previous === null || previous === undefined || current === null || current === undefined) return null;
  const delta = current - previous;
  if (delta <= 0) return null;
  const relative = previous > 0 ? delta / previous : Infinity;
  const previousRating = rate(metric, previous);
  const currentRating = rate(metric, current);
  const base = { metric, previous, current, delta, relative, previousRating, currentRating };
  if (relative >= config.relative && delta >= (config.absolute[metric] ?? 0)) {
    return { ...base, reason: 'threshold' };
  }
  if (config.ratingDrop && compareRatings(previousRating, currentRating) > 0) {
    return { ...base, reason: 'rating-drop' };
  }
  return null;
}

export interface EvaluateInput {
  config: Config;
  key: string;
  name: string;
  url?: string;
  origin?: string;
  formFactor: TargetResult['formFactor'];
  field: FieldData | null;
  history: HistoryData | null;
  lab: LabData | null;
  errors: TargetResult['errors'];
  budgets: Budgets;
  labBudgets: LabBudgets;
  previous: TargetResult | undefined;
}

export function evaluateTarget(input: EvaluateInput): TargetResult {
  const { config, field, history, lab, previous } = input;
  const metrics: MetricSummary[] = config.metrics.map((metric) => {
    const fm = field?.metrics[metric];
    const fieldP75 = fm?.p75 ?? null;
    const labValue = lab?.metrics[metric] ?? null;
    const previousP75 = previous?.field?.metrics[metric]?.p75 ?? null;
    return {
      metric,
      fieldP75,
      fieldRating: fieldP75 === null ? null : rate(metric, fieldP75),
      goodShare: fm?.distribution?.good ?? null,
      labValue,
      labRating: labValue === null ? null : rate(metric, labValue),
      previousP75,
      delta: fieldP75 !== null && previousP75 !== null ? fieldP75 - previousP75 : null,
      trend: history ? computeTrend(history, metric, config.trendPeriods, config.trendThreshold) : null,
    };
  });

  const regressions = metrics
    .map((m) => detectRegression(m.metric, m.previousP75, m.fieldP75, config.regression))
    .filter((r): r is Regression => r !== null);

  const budgets = [
    ...checkFieldBudgets(input.budgets, field, config.metrics),
    ...checkLabBudgets(input.labBudgets, lab),
  ];

  const coreRatings = metrics
    .filter((m) => CORE_METRIC_IDS.includes(m.metric) && m.fieldRating !== null)
    .map((m) => m.fieldRating!);

  const result: TargetResult = {
    key: input.key,
    name: input.name,
    formFactor: input.formFactor,
    field,
    history,
    lab,
    errors: input.errors,
    metrics,
    budgets,
    regressions,
    overall: worstRating(coreRatings),
  };
  if (input.url) result.url = input.url;
  if (input.origin) result.origin = input.origin;
  return result;
}

export function summarize(results: TargetResult[], failOn: Config['failOn']): RunSummary {
  const budgetFailures = results.reduce((n, r) => n + r.budgets.filter((b) => !b.passed).length, 0);
  const regressions = results.reduce((n, r) => n + r.regressions.length, 0);
  const errors = results.reduce((n, r) => n + r.errors.length, 0);
  const trends = results.flatMap((r) => r.metrics.map((m) => m.trend?.direction));
  const passed =
    !(failOn.budget && budgetFailures > 0) && !(failOn.regression && regressions > 0) && !(failOn.errors && errors > 0);
  return {
    targets: results.length,
    withFieldData: results.filter((r) => r.field !== null).length,
    budgetFailures,
    regressions,
    errors,
    improving: trends.filter((t) => t === 'improving').length,
    worsening: trends.filter((t) => t === 'worsening').length,
    passed,
  };
}

/** Exit code for CI: 0 pass, 1 failed a gate. */
export function exitCodeFor(run: RunResult): number {
  return run.summary.passed ? 0 : 1;
}

export function describeLimit(metric: BudgetCheck['metric'], limit: BudgetCheck['limit']): string {
  if (typeof limit === 'string') return `rating ${limit} or better`;
  if (metric === 'performanceScore') return `score >= ${limit}`;
  if (metric === 'tbt') return `<= ${limit} ms`;
  return METRICS[metric].unit === 'unitless' ? `<= ${limit}` : `<= ${limit} ms`;
}
