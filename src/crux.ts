/**
 * Chrome UX Report API client.
 *
 *   POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY
 *   POST https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=KEY
 *
 * Request body: { origin | url, formFactor?, metrics?, collectionPeriodCount? (history only, 1-40) }.
 * queryRecord metrics carry histogram[{start,end?,density}] and percentiles.p75.
 * queryHistoryRecord metrics carry histogramTimeseries[{start,end?,densities[]}] and
 * percentilesTimeseries.p75s[]; missing periods are "NaN" (densities) or null (p75s).
 * CLS values are decimals encoded as strings. A 404 means CrUX has no data.
 */
import { ApiError } from './errors.js';
import type { HttpClient } from './http.js';
import type { Limiter } from './limiter.js';
import { METRICS, METRIC_IDS, metricByCruxName, type MetricId } from './metrics.js';

export const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records';

export type FormFactor = 'PHONE' | 'DESKTOP' | 'TABLET' | 'ALL_FORM_FACTORS';
export const FORM_FACTORS: readonly FormFactor[] = ['PHONE', 'DESKTOP', 'TABLET', 'ALL_FORM_FACTORS'];

export interface CruxDate {
  year: number;
  month: number;
  day: number;
}

export interface CollectionPeriod {
  firstDate: CruxDate;
  lastDate: CruxDate;
}

/* ----- raw API shapes ----- */

export interface RawBin {
  start: number | string;
  end?: number | string;
  density?: number | string;
}

export interface RawMetric {
  histogram?: RawBin[];
  percentiles?: { p75?: number | string | null };
}

export interface RawHistoryBin {
  start: number | string;
  end?: number | string;
  densities?: Array<number | string | null>;
}

export interface RawHistoryMetric {
  histogramTimeseries?: RawHistoryBin[];
  percentilesTimeseries?: { p75s?: Array<number | string | null> };
}

export interface RawRecordResponse {
  record?: {
    key?: Record<string, string>;
    metrics?: Record<string, RawMetric>;
    collectionPeriod?: CollectionPeriod;
  };
  urlNormalizationDetails?: { originalUrl?: string; normalizedUrl?: string };
}

export interface RawHistoryResponse {
  record?: {
    key?: Record<string, string>;
    metrics?: Record<string, RawHistoryMetric>;
    collectionPeriods?: CollectionPeriod[];
  };
  urlNormalizationDetails?: { originalUrl?: string; normalizedUrl?: string };
}

/* ----- normalised shapes ----- */

/** Share of page loads in each rating bucket (0..1). */
export interface Distribution {
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface FieldMetric {
  p75: number | null;
  distribution: Distribution | null;
}

export interface FieldData {
  key: { url?: string; origin?: string; formFactor: FormFactor };
  metrics: Partial<Record<MetricId, FieldMetric>>;
  collectionPeriod: CollectionPeriod | null;
  normalizedUrl?: string;
}

export interface HistoryData {
  key: { url?: string; origin?: string; formFactor: FormFactor };
  /** End date of each collection period, ISO yyyy-mm-dd, oldest first. */
  periods: string[];
  p75s: Partial<Record<MetricId, Array<number | null>>>;
  /** Share of "good" per period, for each metric. */
  goodShare: Partial<Record<MetricId, Array<number | null>>>;
}

export interface CruxQuery {
  /** Exactly one of url or origin. */
  url?: string;
  origin?: string;
  formFactor?: FormFactor;
  metrics?: MetricId[];
}

export interface CruxClientOptions {
  http: HttpClient;
  apiKey: string;
  limiter?: Limiter;
  endpoint?: string;
}

export class CruxClient {
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly limiter: Limiter | undefined;
  private readonly endpoint: string;

  constructor(options: CruxClientOptions) {
    if (!options.apiKey) throw new Error('A Google API key is required for the CrUX API');
    this.http = options.http;
    this.apiKey = options.apiKey;
    this.limiter = options.limiter;
    this.endpoint = options.endpoint ?? CRUX_ENDPOINT;
  }

  /** Latest 28-day record, or null when CrUX has no data (HTTP 404). */
  async queryRecord(query: CruxQuery): Promise<FieldData | null> {
    const raw = await this.post<RawRecordResponse>('queryRecord', buildBody(query));
    return raw ? parseRecord(raw, query) : null;
  }

  /** Weekly history (up to 40 periods), or null when CrUX has no data. */
  async queryHistoryRecord(query: CruxQuery, collectionPeriodCount = 25): Promise<HistoryData | null> {
    if (!Number.isInteger(collectionPeriodCount) || collectionPeriodCount < 1 || collectionPeriodCount > 40) {
      throw new RangeError('collectionPeriodCount must be an integer from 1 to 40');
    }
    const body = { ...buildBody(query), collectionPeriodCount };
    const raw = await this.post<RawHistoryResponse>('queryHistoryRecord', body);
    return raw ? parseHistory(raw, query) : null;
  }

  private async post<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const url = `${this.endpoint}:${method}?key=${encodeURIComponent(this.apiKey)}`;
    const call = () => this.http.json<T>(url, { method: 'POST', body });
    try {
      return await (this.limiter ? this.limiter.run(call) : call());
    } catch (err) {
      if (err instanceof ApiError && err.isNotFound) return null;
      throw err;
    }
  }
}

export function buildBody(query: CruxQuery): Record<string, unknown> {
  if (Boolean(query.url) === Boolean(query.origin)) {
    throw new Error('A CrUX query needs exactly one of "url" or "origin"');
  }
  const body: Record<string, unknown> = query.url ? { url: query.url } : { origin: query.origin };
  if (query.formFactor && query.formFactor !== 'ALL_FORM_FACTORS') body.formFactor = query.formFactor;
  const metrics = query.metrics ?? [...METRIC_IDS];
  body.metrics = metrics.map((id) => METRICS[id].cruxName);
  return body;
}

/** CrUX encodes CLS as strings and missing history values as "NaN" or null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function keyOf(query: CruxQuery, raw?: Record<string, string>): FieldData['key'] {
  const formFactor = (raw?.formFactor as FormFactor | undefined) ?? query.formFactor ?? 'ALL_FORM_FACTORS';
  const key: FieldData['key'] = { formFactor };
  const url = raw?.url ?? query.url;
  const origin = raw?.origin ?? query.origin;
  if (url) key.url = url;
  else if (origin) key.origin = origin;
  return key;
}

/**
 * CrUX histograms use three bins whose edges match the rating boundaries,
 * so bin 0 is "good", bin 1 "needs improvement" and bin 2 "poor".
 */
export function distributionFromBins(densities: Array<number | null>): Distribution | null {
  if (densities.length !== 3 || densities.some((d) => d === null)) return null;
  const [good, needsImprovement, poor] = densities as number[];
  return { good: good!, needsImprovement: needsImprovement!, poor: poor! };
}

export function parseRecord(raw: RawRecordResponse, query: CruxQuery): FieldData {
  const record = raw.record ?? {};
  const metrics: FieldData['metrics'] = {};
  for (const [name, value] of Object.entries(record.metrics ?? {})) {
    const def = metricByCruxName(name);
    if (!def) continue;
    const densities = (value.histogram ?? []).map((bin) => toNumber(bin.density ?? 0));
    metrics[def.id] = {
      p75: toNumber(value.percentiles?.p75),
      distribution: distributionFromBins(densities),
    };
  }
  const data: FieldData = {
    key: keyOf(query, record.key),
    metrics,
    collectionPeriod: record.collectionPeriod ?? null,
  };
  const normalized = raw.urlNormalizationDetails?.normalizedUrl;
  if (normalized) data.normalizedUrl = normalized;
  return data;
}

export function parseHistory(raw: RawHistoryResponse, query: CruxQuery): HistoryData {
  const record = raw.record ?? {};
  const periods = (record.collectionPeriods ?? []).map((p) => isoDate(p.lastDate));
  const p75s: HistoryData['p75s'] = {};
  const goodShare: HistoryData['goodShare'] = {};
  for (const [name, value] of Object.entries(record.metrics ?? {})) {
    const def = metricByCruxName(name);
    if (!def) continue;
    p75s[def.id] = (value.percentilesTimeseries?.p75s ?? []).map(toNumber);
    const firstBin = value.histogramTimeseries?.[0];
    if (firstBin?.densities) goodShare[def.id] = firstBin.densities.map(toNumber);
  }
  return { key: keyOf(query, record.key), periods, p75s, goodShare };
}

export function isoDate(date: CruxDate): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}
