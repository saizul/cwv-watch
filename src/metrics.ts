/**
 * Metric catalogue: names used by each Google API, units and the
 * good / needs-improvement / poor boundaries published for Core Web Vitals.
 *
 * Boundaries (inclusive upper bound of each bucket, as documented by
 * PageSpeed Insights and web.dev):
 *
 *   LCP   good <= 2500 ms   needs improvement <= 4000 ms   poor > 4000 ms
 *   INP   good <= 200 ms    needs improvement <= 500 ms    poor > 500 ms
 *   CLS   good <= 0.1       needs improvement <= 0.25      poor > 0.25
 *   FCP   good <= 1800 ms   needs improvement <= 3000 ms   poor > 3000 ms
 *   TTFB  good <= 800 ms    needs improvement <= 1800 ms   poor > 1800 ms
 */

export type MetricId = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';
export type Rating = 'good' | 'needs-improvement' | 'poor';
export type Unit = 'ms' | 'unitless';

export interface MetricDefinition {
  id: MetricId;
  name: string;
  /** Metric name in the Chrome UX Report API. */
  cruxName: string;
  /** Key in PageSpeed Insights loadingExperience.metrics. */
  psiFieldKey: string;
  /** Lighthouse audit id that measures the same thing in the lab, if any. */
  labAudit: string | null;
  unit: Unit;
  /** Upper bound (inclusive) of "good". */
  good: number;
  /** Upper bound (inclusive) of "needs improvement". */
  poor: number;
  /** True for the three Core Web Vitals. */
  core: boolean;
}

export const METRICS: Readonly<Record<MetricId, MetricDefinition>> = Object.freeze({
  lcp: {
    id: 'lcp',
    name: 'Largest Contentful Paint',
    cruxName: 'largest_contentful_paint',
    psiFieldKey: 'LARGEST_CONTENTFUL_PAINT_MS',
    labAudit: 'largest-contentful-paint',
    unit: 'ms',
    good: 2500,
    poor: 4000,
    core: true,
  },
  inp: {
    id: 'inp',
    name: 'Interaction to Next Paint',
    cruxName: 'interaction_to_next_paint',
    psiFieldKey: 'INTERACTION_TO_NEXT_PAINT',
    labAudit: null,
    unit: 'ms',
    good: 200,
    poor: 500,
    core: true,
  },
  cls: {
    id: 'cls',
    name: 'Cumulative Layout Shift',
    cruxName: 'cumulative_layout_shift',
    psiFieldKey: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
    labAudit: 'cumulative-layout-shift',
    unit: 'unitless',
    good: 0.1,
    poor: 0.25,
    core: true,
  },
  fcp: {
    id: 'fcp',
    name: 'First Contentful Paint',
    cruxName: 'first_contentful_paint',
    psiFieldKey: 'FIRST_CONTENTFUL_PAINT_MS',
    labAudit: 'first-contentful-paint',
    unit: 'ms',
    good: 1800,
    poor: 3000,
    core: false,
  },
  ttfb: {
    id: 'ttfb',
    name: 'Time to First Byte',
    cruxName: 'experimental_time_to_first_byte',
    psiFieldKey: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE',
    labAudit: 'server-response-time',
    unit: 'ms',
    good: 800,
    poor: 1800,
    core: false,
  },
});

export const METRIC_IDS: readonly MetricId[] = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];
export const CORE_METRIC_IDS: readonly MetricId[] = ['lcp', 'inp', 'cls'];

/** Lab-only Lighthouse metrics reported alongside the field metrics. */
export const LAB_EXTRA_AUDITS = Object.freeze({
  tbt: 'total-blocking-time',
  si: 'speed-index',
  tti: 'interactive',
});

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && (METRIC_IDS as readonly string[]).includes(value);
}

export function metricByCruxName(name: string): MetricDefinition | undefined {
  return METRIC_IDS.map((id) => METRICS[id]).find((m) => m.cruxName === name);
}

/** Classify a value with the documented boundaries (bucket upper bounds are inclusive). */
export function rate(metric: MetricId, value: number): Rating {
  const def = METRICS[metric];
  if (!Number.isFinite(value)) throw new RangeError(`Cannot rate a non-finite ${metric} value`);
  if (value <= def.good) return 'good';
  if (value <= def.poor) return 'needs-improvement';
  return 'poor';
}

const RATING_ORDER: Record<Rating, number> = { good: 0, 'needs-improvement': 1, poor: 2 };

/** Positive when `b` is a worse rating than `a`. */
export function compareRatings(a: Rating, b: Rating): number {
  return RATING_ORDER[b] - RATING_ORDER[a];
}

export function worstRating(ratings: Iterable<Rating>): Rating | null {
  let worst: Rating | null = null;
  for (const r of ratings) {
    if (worst === null || RATING_ORDER[r] > RATING_ORDER[worst]) worst = r;
  }
  return worst;
}

export function ratingLabel(rating: Rating): string {
  switch (rating) {
    case 'good':
      return 'Good';
    case 'needs-improvement':
      return 'Needs improvement';
    case 'poor':
      return 'Poor';
  }
}

/** Human formatting: "2.4 s", "180 ms", "0.08". */
export function formatValue(metric: MetricId, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  if (METRICS[metric].unit === 'unitless') return value.toFixed(2);
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;
  return `${Math.round(value)} ms`;
}

/** Signed difference, formatted in the metric's unit. */
export function formatDelta(metric: MetricId, delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
  const abs = Math.abs(delta);
  if (METRICS[metric].unit === 'unitless') return `${sign}${abs.toFixed(2)}`;
  return `${sign}${Math.round(abs)} ms`;
}
