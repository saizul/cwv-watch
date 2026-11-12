/**
 * PageSpeed Insights API v5 client (Lighthouse lab data).
 *
 *   GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed
 *       ?url=URL&strategy=mobile|desktop&category=performance&key=KEY
 *
 * Read from the response:
 *   lighthouseResult.categories.performance.score   0..1
 *   lighthouseResult.audits[<id>].numericValue       ms, or unitless for CLS
 *   lighthouseResult.runtimeError                    Lighthouse failure, if any
 *   loadingExperience.metrics[<KEY>].percentile      CrUX p75 (CLS multiplied by 100)
 *   analysisUTCTimestamp
 */
import type { HttpClient } from './http.js';
import type { Limiter } from './limiter.js';
import { LAB_EXTRA_AUDITS, METRICS, METRIC_IDS, type MetricId } from './metrics.js';
import { CwvWatchError } from './errors.js';

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export type Strategy = 'mobile' | 'desktop';

export interface RawAudit {
  id?: string;
  score?: number | null;
  numericValue?: number;
  numericUnit?: string;
  displayValue?: string;
}

export interface RawLoadingExperience {
  id?: string;
  metrics?: Record<string, { percentile?: number; category?: string }>;
  overall_category?: string;
  origin_fallback?: boolean;
}

export interface RawPsiResponse {
  id?: string;
  analysisUTCTimestamp?: string;
  loadingExperience?: RawLoadingExperience;
  originLoadingExperience?: RawLoadingExperience;
  lighthouseResult?: {
    requestedUrl?: string;
    finalUrl?: string;
    lighthouseVersion?: string;
    fetchTime?: string;
    runWarnings?: string[];
    runtimeError?: { code?: string; message?: string };
    categories?: Record<string, { score?: number | null }>;
    audits?: Record<string, RawAudit>;
  };
}

export interface LabData {
  url: string;
  finalUrl: string | null;
  strategy: Strategy;
  /** Lighthouse performance score, 0..100. */
  performanceScore: number | null;
  metrics: Partial<Record<MetricId, number>>;
  /** Total Blocking Time, Speed Index and Time to Interactive in ms. */
  extra: { tbt?: number; si?: number; tti?: number };
  /** CrUX p75 values embedded in the PSI response (page level), already de-scaled. */
  field: Partial<Record<MetricId, number>>;
  fieldIsOriginFallback: boolean;
  lighthouseVersion: string | null;
  fetchedAt: string | null;
  warnings: string[];
}

export interface PsiClientOptions {
  http: HttpClient;
  /** Optional for PSI (anonymous use is heavily rate limited), but recommended. */
  apiKey?: string;
  limiter?: Limiter;
  endpoint?: string;
  locale?: string;
}

export class LighthouseRuntimeError extends CwvWatchError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Lighthouse failed (${code}): ${message}`);
  }
}

export class PsiClient {
  private readonly http: HttpClient;
  private readonly apiKey: string | undefined;
  private readonly limiter: Limiter | undefined;
  private readonly endpoint: string;
  private readonly locale: string | undefined;

  constructor(options: PsiClientOptions) {
    this.http = options.http;
    this.apiKey = options.apiKey;
    this.limiter = options.limiter;
    this.endpoint = options.endpoint ?? PSI_ENDPOINT;
    this.locale = options.locale;
  }

  buildUrl(url: string, strategy: Strategy): string {
    const params = new URLSearchParams({ url, strategy, category: 'performance' });
    if (this.locale) params.set('locale', this.locale);
    if (this.apiKey) params.set('key', this.apiKey);
    return `${this.endpoint}?${params.toString()}`;
  }

  async run(url: string, strategy: Strategy = 'mobile'): Promise<LabData> {
    const call = () => this.http.json<RawPsiResponse>(this.buildUrl(url, strategy));
    const raw = await (this.limiter ? this.limiter.run(call) : call());
    return parsePsi(raw, url, strategy);
  }
}

export function parsePsi(raw: RawPsiResponse, url: string, strategy: Strategy): LabData {
  const lh = raw.lighthouseResult ?? {};
  if (lh.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR') {
    throw new LighthouseRuntimeError(lh.runtimeError.code, lh.runtimeError.message ?? 'unknown error');
  }
  const audits = lh.audits ?? {};
  const numeric = (id: string): number | undefined => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };

  const metrics: LabData['metrics'] = {};
  for (const id of METRIC_IDS) {
    const audit = METRICS[id].labAudit;
    const value = audit ? numeric(audit) : undefined;
    if (value !== undefined) metrics[id] = value;
  }
  const extra: LabData['extra'] = {};
  for (const [key, audit] of Object.entries(LAB_EXTRA_AUDITS) as Array<[keyof LabData['extra'], string]>) {
    const value = numeric(audit);
    if (value !== undefined) extra[key] = value;
  }

  const field: LabData['field'] = {};
  const le = raw.loadingExperience;
  for (const id of METRIC_IDS) {
    const p = le?.metrics?.[METRICS[id].psiFieldKey]?.percentile;
    if (typeof p === 'number') field[id] = id === 'cls' ? p / 100 : p;
  }

  const score = lh.categories?.performance?.score;
  return {
    url,
    finalUrl: lh.finalUrl ?? null,
    strategy,
    performanceScore: typeof score === 'number' ? Math.round(score * 100) : null,
    metrics,
    extra,
    field,
    fieldIsOriginFallback: Boolean(le?.origin_fallback),
    lighthouseVersion: lh.lighthouseVersion ?? null,
    fetchedAt: raw.analysisUTCTimestamp ?? lh.fetchTime ?? null,
    warnings: lh.runWarnings ?? [],
  };
}
