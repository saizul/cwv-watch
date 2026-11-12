import type { FieldData, FormFactor, HistoryData } from './crux.js';
import type { MetricId, Rating } from './metrics.js';
import type { LabData } from './psi.js';

export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'insufficient-data';

export interface Trend {
  direction: TrendDirection;
  /** p75 values over the trend window, oldest first; null where CrUX had no data. */
  values: Array<number | null>;
  periods: string[];
  first: number | null;
  last: number | null;
  /** Least-squares slope per period, in the metric's unit. */
  slope: number | null;
  /** Relative change from the fitted start to the fitted end of the window. */
  change: number | null;
}

export interface BudgetCheck {
  metric: MetricId | 'performanceScore' | 'tbt';
  source: 'field' | 'lab';
  /** Numeric limit, or the worst rating allowed. */
  limit: number | Rating;
  value: number | null;
  passed: boolean;
  /** Set when there is no value to check (no CrUX data, lab skipped). */
  skipped?: string;
}

export interface Regression {
  metric: MetricId;
  previous: number;
  current: number;
  delta: number;
  relative: number;
  previousRating: Rating;
  currentRating: Rating;
  reason: 'threshold' | 'rating-drop';
}

export interface MetricSummary {
  metric: MetricId;
  fieldP75: number | null;
  fieldRating: Rating | null;
  goodShare: number | null;
  labValue: number | null;
  labRating: Rating | null;
  previousP75: number | null;
  delta: number | null;
  trend: Trend | null;
}

export interface TargetResult {
  /** Stable key used to match runs: "<name>|<formFactor>". */
  key: string;
  name: string;
  url?: string;
  origin?: string;
  formFactor: FormFactor;
  field: FieldData | null;
  history: HistoryData | null;
  lab: LabData | null;
  errors: Array<{ source: 'crux' | 'history' | 'psi'; message: string }>;
  metrics: MetricSummary[];
  budgets: BudgetCheck[];
  regressions: Regression[];
  /** Overall field rating: the worst rating among the core metrics with data. */
  overall: Rating | null;
}

export interface RunSummary {
  targets: number;
  withFieldData: number;
  budgetFailures: number;
  regressions: number;
  errors: number;
  improving: number;
  worsening: number;
  passed: boolean;
}

export interface RunResult {
  tool: 'cwv-watch';
  version: string;
  startedAt: string;
  finishedAt: string;
  previousRunAt: string | null;
  results: TargetResult[];
  summary: RunSummary;
}

export function resultKey(name: string, formFactor: FormFactor): string {
  return `${name}|${formFactor}`;
}
