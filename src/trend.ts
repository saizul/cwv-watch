import type { HistoryData } from './crux.js';
import type { MetricId } from './metrics.js';
import type { Trend } from './model.js';

/** Least-squares fit over the non-null points; x is the period index. */
export function linearFit(values: Array<number | null>): { slope: number; intercept: number; n: number } | null {
  const pts: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) pts.push([i, v]);
  });
  if (pts.length < 2) return null;
  const n = pts.length;
  const sx = pts.reduce((s, [x]) => s + x, 0);
  const sy = pts.reduce((s, [, y]) => s + y, 0);
  const sxx = pts.reduce((s, [x]) => s + x * x, 0);
  const sxy = pts.reduce((s, [x, y]) => s + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, n };
}

/**
 * Trend of a metric's p75 over the last `window` collection periods.
 * Lower is better for every Web Vital, so a rising line is "worsening".
 * The relative change is measured between the fitted values at the start and
 * end of the window, which is less sensitive to one noisy week than first/last.
 */
export function computeTrend(
  history: HistoryData,
  metric: MetricId,
  window: number,
  threshold: number,
  minPoints = 3,
): Trend | null {
  const all = history.p75s[metric];
  if (!all || all.length === 0) return null;
  const values = all.slice(-window);
  const periods = history.periods.slice(-window);
  const present = values.filter((v): v is number => v !== null);
  const base: Trend = {
    direction: 'insufficient-data',
    values,
    periods,
    first: present[0] ?? null,
    last: present[present.length - 1] ?? null,
    slope: null,
    change: null,
  };
  const fit = linearFit(values);
  if (!fit || fit.n < minPoints) return base;
  const start = fit.intercept;
  const end = fit.intercept + fit.slope * (values.length - 1);
  const change = start > 0 ? (end - start) / start : end > 0 ? Infinity : 0;
  let direction: Trend['direction'] = 'stable';
  if (change > threshold) direction = 'worsening';
  else if (change < -threshold) direction = 'improving';
  return { ...base, slope: fit.slope, change: Number.isFinite(change) ? change : null, direction };
}
