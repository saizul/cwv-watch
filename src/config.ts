import { readFile } from 'node:fs/promises';
import { ConfigError } from './errors.js';
import { FORM_FACTORS, type FormFactor } from './crux.js';
import { CORE_METRIC_IDS, METRIC_IDS, isMetricId, type MetricId, type Rating } from './metrics.js';

export type BudgetValue = number | Rating;
export type Budgets = Partial<Record<MetricId, BudgetValue>>;

export interface LabBudgets extends Partial<Record<MetricId, number>> {
  /** Minimum Lighthouse performance score, 0..100. */
  performanceScore?: number;
  tbt?: number;
}

export interface TargetConfig {
  /** Display name; defaults to the URL or origin. */
  name: string;
  url?: string;
  origin?: string;
  formFactors?: FormFactor[];
  budgets?: Budgets;
  labBudgets?: LabBudgets;
  /** Skip PageSpeed Insights for this target. */
  skipLab?: boolean;
}

export type NotifyOn = 'always' | 'failure' | 'change' | 'never';

export interface WebhookConfig {
  url?: string;
  urlEnv?: string;
  headers?: Record<string, string>;
}

export interface TelegramConfig {
  botTokenEnv: string;
  chatId?: string;
  chatIdEnv?: string;
}

export interface NotifyConfig {
  on: NotifyOn;
  webhook?: WebhookConfig;
  slack?: WebhookConfig;
  telegram?: TelegramConfig;
  /** Link included in messages, for example the CI run or a hosted HTML report. */
  reportUrl?: string;
}

export interface RegressionConfig {
  /** Relative worsening of p75 that counts as a regression (0.1 = 10 %). */
  relative: number;
  /** Minimum absolute worsening per metric, to ignore noise on small values. */
  absolute: Record<MetricId, number>;
  /** Whether a rating drop (good -> needs improvement) is always a regression. */
  ratingDrop: boolean;
}

export interface Config {
  targets: TargetConfig[];
  formFactors: FormFactor[];
  metrics: MetricId[];
  sources: { crux: boolean; history: boolean; psi: boolean };
  historyPeriods: number;
  trendPeriods: number;
  /** Relative change across the trend window that counts as improving/worsening. */
  trendThreshold: number;
  budgets: Budgets;
  labBudgets: LabBudgets;
  regression: RegressionConfig;
  failOn: { budget: boolean; regression: boolean; errors: boolean };
  storage: { path: string; keepRuns: number };
  reports: { outDir: string; formats: Array<'md' | 'json' | 'html' | 'junit'> };
  concurrency: number;
  rateLimit: { cruxPerMinute: number; psiPerMinute: number };
  http: { timeoutMs: number; retries: number };
  apiKeyEnv: string;
  notify: NotifyConfig;
}

export const DEFAULT_CONFIG: Omit<Config, 'targets'> = {
  formFactors: ['PHONE', 'DESKTOP'],
  metrics: [...METRIC_IDS],
  sources: { crux: true, history: true, psi: true },
  historyPeriods: 25,
  trendPeriods: 8,
  trendThreshold: 0.05,
  budgets: Object.fromEntries(CORE_METRIC_IDS.map((id) => [id, 'good'])) as Budgets,
  labBudgets: {},
  regression: {
    relative: 0.1,
    absolute: { lcp: 100, inp: 20, cls: 0.02, fcp: 100, ttfb: 50 },
    ratingDrop: true,
  },
  failOn: { budget: true, regression: false, errors: false },
  storage: { path: '.cwv-watch/history.json', keepRuns: 30 },
  reports: { outDir: 'cwv-report', formats: ['md', 'json', 'html'] },
  concurrency: 4,
  // The CrUX API allows 150 queries per minute per project; stay below it.
  rateLimit: { cruxPerMinute: 120, psiPerMinute: 60 },
  http: { timeoutMs: 90_000, retries: 2 },
  apiKeyEnv: 'CWV_API_KEY',
  notify: { on: 'failure' },
};

const RATINGS: readonly Rating[] = ['good', 'needs-improvement', 'poor'];
const FORMATS = ['md', 'json', 'html', 'junit'] as const;
const NOTIFY_ON: readonly NotifyOn[] = ['always', 'failure', 'change', 'never'];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

class Checker {
  readonly issues: string[] = [];

  fail(path: string, message: string): void {
    this.issues.push(`${path}: ${message}`);
  }

  bool(obj: Json, key: string, path: string, fallback: boolean): boolean {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') this.fail(`${path}.${key}`, 'must be true or false');
    return typeof v === 'boolean' ? v : fallback;
  }

  num(obj: Json, key: string, path: string, fallback: number, min: number, max = Infinity, int = false): number {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
      this.fail(`${path}.${key}`, `must be ${int ? 'an integer' : 'a number'} ${range}`);
      return fallback;
    }
    return v;
  }

  str(obj: Json, key: string, path: string): string | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(`${path}.${key}`, 'must be a non-empty string');
      return undefined;
    }
    return v;
  }

  formFactors(value: unknown, path: string): FormFactor[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
      this.fail(path, `must be a non-empty array of ${FORM_FACTORS.join(', ')}`);
      return undefined;
    }
    const out: FormFactor[] = [];
    for (const item of value) {
      const upper = typeof item === 'string' ? item.toUpperCase() : item;
      if ((FORM_FACTORS as readonly unknown[]).includes(upper)) out.push(upper as FormFactor);
      else this.fail(path, `unknown form factor ${JSON.stringify(item)}`);
    }
    return [...new Set(out)];
  }

  budgets(value: unknown, path: string): Budgets | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(path, 'must be an object of metric -> number or rating');
      return undefined;
    }
    const out: Budgets = {};
    for (const [key, v] of Object.entries(value)) {
      if (!isMetricId(key)) {
        this.fail(`${path}.${key}`, `unknown metric (use ${METRIC_IDS.join(', ')})`);
      } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        out[key] = v;
      } else if (typeof v === 'string' && (RATINGS as readonly string[]).includes(v)) {
        out[key] = v as Rating;
      } else {
        this.fail(`${path}.${key}`, 'must be a non-negative number or "good" / "needs-improvement" / "poor"');
      }
    }
    return out;
  }

  labBudgets(value: unknown, path: string): LabBudgets | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    const out: LabBudgets = {};
    for (const [key, v] of Object.entries(value)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        this.fail(`${path}.${key}`, 'must be a non-negative number');
        continue;
      }
      if (key === 'performanceScore') {
        if (v > 100) this.fail(`${path}.${key}`, 'must be between 0 and 100');
        else out.performanceScore = v;
      } else if (key === 'tbt') out.tbt = v;
      else if (isMetricId(key)) out[key] = v;
      else this.fail(`${path}.${key}`, 'unknown lab budget');
    }
    return out;
  }

  webhook(value: unknown, path: string): WebhookConfig | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    const url = this.str(value, 'url', path);
    const urlEnv = this.str(value, 'urlEnv', path);
    if (!url && !urlEnv) this.fail(path, 'needs "url" or "urlEnv"');
    if (url && !isHttpUrl(url)) this.fail(`${path}.url`, 'must be an http(s) URL');
    const out: WebhookConfig = {};
    if (url) out.url = url;
    if (urlEnv) out.urlEnv = urlEnv;
    if (value.headers !== undefined) {
      if (!isObject(value.headers) || Object.values(value.headers).some((h) => typeof h !== 'string')) {
        this.fail(`${path}.headers`, 'must be an object of string values');
      } else out.headers = value.headers as Record<string, string>;
    }
    return out;
  }
}

/**
 * A bare string target is an origin when it has no path ("https://example.com")
 * and a page URL otherwise ("https://example.com/", "https://example.com/blog").
 */
function stringTarget(value: string): Json {
  const withoutScheme = value.replace(/^[a-z]+:\/\//i, '');
  return withoutScheme.includes('/') ? { url: value } : { origin: value };
}

/** Validate a parsed JSON config and fill in defaults. Throws ConfigError listing every problem. */
export function resolveConfig(input: unknown): Config {
  const c = new Checker();
  if (!isObject(input)) throw new ConfigError('Configuration must be a JSON object');
  const d = DEFAULT_CONFIG;

  const known = new Set([
    '$schema',
    'targets',
    'formFactors',
    'metrics',
    'sources',
    'historyPeriods',
    'trendPeriods',
    'trendThreshold',
    'budgets',
    'labBudgets',
    'regression',
    'failOn',
    'storage',
    'reports',
    'concurrency',
    'rateLimit',
    'http',
    'apiKeyEnv',
    'notify',
  ]);
  for (const key of Object.keys(input)) if (!known.has(key)) c.fail(key, 'unknown option');

  const targets: TargetConfig[] = [];
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    c.fail('targets', 'must be a non-empty array');
  } else {
    input.targets.forEach((raw, i) => {
      const path = `targets[${i}]`;
      const t: Json = typeof raw === 'string' ? stringTarget(raw) : (raw as Json);
      if (!isObject(t)) {
        c.fail(path, 'must be a URL string or an object');
        return;
      }
      const url = c.str(t, 'url', path);
      const origin = c.str(t, 'origin', path);
      if (Boolean(url) === Boolean(origin)) {
        c.fail(path, 'needs exactly one of "url" or "origin"');
        return;
      }
      if (url && !isHttpUrl(url)) c.fail(`${path}.url`, 'must be an absolute http(s) URL');
      if (origin) {
        if (!isHttpUrl(origin)) c.fail(`${path}.origin`, 'must be an absolute http(s) origin');
        else if (new URL(origin).origin !== origin.replace(/\/$/, '')) {
          c.fail(`${path}.origin`, 'must not contain a path, query or fragment (e.g. https://example.com)');
        }
      }
      const target: TargetConfig = { name: c.str(t, 'name', path) ?? (url ?? origin)! };
      if (url) target.url = url;
      if (origin) target.origin = origin.replace(/\/$/, '');
      const ff = c.formFactors(t.formFactors, `${path}.formFactors`);
      if (ff) target.formFactors = ff;
      const budgets = c.budgets(t.budgets, `${path}.budgets`);
      if (budgets) target.budgets = budgets;
      const lab = c.labBudgets(t.labBudgets, `${path}.labBudgets`);
      if (lab) target.labBudgets = lab;
      if (c.bool(t, 'skipLab', path, false)) target.skipLab = true;
      targets.push(target);
    });
    const names = targets.map((t) => t.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) c.fail('targets', `duplicate target name ${JSON.stringify(dup)}`);
  }

  let metrics = d.metrics;
  if (input.metrics !== undefined) {
    if (!Array.isArray(input.metrics) || input.metrics.length === 0 || !input.metrics.every(isMetricId)) {
      c.fail('metrics', `must be a non-empty array of ${METRIC_IDS.join(', ')}`);
    } else metrics = [...new Set(input.metrics as MetricId[])];
  }

  const sourcesIn = isObject(input.sources) ? input.sources : {};
  if (input.sources !== undefined && !isObject(input.sources)) c.fail('sources', 'must be an object');
  const sources = {
    crux: c.bool(sourcesIn, 'crux', 'sources', d.sources.crux),
    history: c.bool(sourcesIn, 'history', 'sources', d.sources.history),
    psi: c.bool(sourcesIn, 'psi', 'sources', d.sources.psi),
  };

  const sub = (key: string): Json => {
    const v = input[key];
    if (v === undefined) return {};
    if (!isObject(v)) {
      c.fail(key, 'must be an object');
      return {};
    }
    return v;
  };

  const reg = sub('regression');
  const absolute = { ...d.regression.absolute };
  if (reg.absolute !== undefined) {
    if (!isObject(reg.absolute)) c.fail('regression.absolute', 'must be an object');
    else {
      for (const [k, v] of Object.entries(reg.absolute)) {
        if (!isMetricId(k)) c.fail(`regression.absolute.${k}`, 'unknown metric');
        else if (typeof v !== 'number' || v < 0) c.fail(`regression.absolute.${k}`, 'must be a number >= 0');
        else absolute[k] = v;
      }
    }
  }

  const failOnIn = sub('failOn');
  const storageIn = sub('storage');
  const reportsIn = sub('reports');
  let formats = d.reports.formats;
  if (reportsIn.formats !== undefined) {
    const f = reportsIn.formats;
    if (!Array.isArray(f) || !f.every((x) => (FORMATS as readonly unknown[]).includes(x))) {
      c.fail('reports.formats', 'must be an array of "md", "json", "html", "junit"');
    } else formats = [...new Set(f)] as Config['reports']['formats'];
  }
  const rateIn = sub('rateLimit');
  const httpIn = sub('http');
  const notifyIn = sub('notify');
  const notify: NotifyConfig = { on: d.notify.on };
  if (notifyIn.on !== undefined) {
    if ((NOTIFY_ON as readonly unknown[]).includes(notifyIn.on)) notify.on = notifyIn.on as NotifyOn;
    else c.fail('notify.on', `must be one of ${NOTIFY_ON.join(', ')}`);
  }
  const webhook = c.webhook(notifyIn.webhook, 'notify.webhook');
  if (webhook) notify.webhook = webhook;
  const slack = c.webhook(notifyIn.slack, 'notify.slack');
  if (slack) notify.slack = slack;
  if (notifyIn.telegram !== undefined) {
    const tg = notifyIn.telegram;
    if (!isObject(tg)) c.fail('notify.telegram', 'must be an object');
    else {
      const botTokenEnv = c.str(tg, 'botTokenEnv', 'notify.telegram');
      const chatId = c.str(tg, 'chatId', 'notify.telegram');
      const chatIdEnv = c.str(tg, 'chatIdEnv', 'notify.telegram');
      if (!botTokenEnv) c.fail('notify.telegram.botTokenEnv', 'is required (name of the env var holding the token)');
      if (!chatId && !chatIdEnv) c.fail('notify.telegram', 'needs "chatId" or "chatIdEnv"');
      if (botTokenEnv) {
        notify.telegram = { botTokenEnv };
        if (chatId) notify.telegram.chatId = chatId;
        if (chatIdEnv) notify.telegram.chatIdEnv = chatIdEnv;
      }
    }
  }
  if (typeof notifyIn.reportUrl === 'string') notify.reportUrl = notifyIn.reportUrl;

  const config: Config = {
    targets,
    formFactors: c.formFactors(input.formFactors, 'formFactors') ?? d.formFactors,
    metrics,
    sources,
    historyPeriods: c.num(input, 'historyPeriods', '', d.historyPeriods, 1, 40, true),
    trendPeriods: c.num(input, 'trendPeriods', '', d.trendPeriods, 2, 40, true),
    trendThreshold: c.num(input, 'trendThreshold', '', d.trendThreshold, 0, 10),
    budgets: c.budgets(input.budgets, 'budgets') ?? d.budgets,
    labBudgets: c.labBudgets(input.labBudgets, 'labBudgets') ?? d.labBudgets,
    regression: {
      relative: c.num(reg, 'relative', 'regression', d.regression.relative, 0, 10),
      absolute,
      ratingDrop: c.bool(reg, 'ratingDrop', 'regression', d.regression.ratingDrop),
    },
    failOn: {
      budget: c.bool(failOnIn, 'budget', 'failOn', d.failOn.budget),
      regression: c.bool(failOnIn, 'regression', 'failOn', d.failOn.regression),
      errors: c.bool(failOnIn, 'errors', 'failOn', d.failOn.errors),
    },
    storage: {
      path: c.str(storageIn, 'path', 'storage') ?? d.storage.path,
      keepRuns: c.num(storageIn, 'keepRuns', 'storage', d.storage.keepRuns, 1, 10_000, true),
    },
    reports: { outDir: c.str(reportsIn, 'outDir', 'reports') ?? d.reports.outDir, formats },
    concurrency: c.num(input, 'concurrency', '', d.concurrency, 1, 32, true),
    rateLimit: {
      cruxPerMinute: c.num(rateIn, 'cruxPerMinute', 'rateLimit', d.rateLimit.cruxPerMinute, 0, 10_000, true),
      psiPerMinute: c.num(rateIn, 'psiPerMinute', 'rateLimit', d.rateLimit.psiPerMinute, 0, 10_000, true),
    },
    http: {
      timeoutMs: c.num(httpIn, 'timeoutMs', 'http', d.http.timeoutMs, 1000, 600_000, true),
      retries: c.num(httpIn, 'retries', 'http', d.http.retries, 0, 10, true),
    },
    apiKeyEnv: (typeof input.apiKeyEnv === 'string' && input.apiKeyEnv) || d.apiKeyEnv,
    notify,
  };
  if (c.issues.length > 0) {
    throw new ConfigError(
      'Invalid configuration',
      c.issues.map((i) => i.replace(/^\./, '')),
    );
  }
  return config;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return resolveConfig(parsed);
}

/** Read the API key: the configured env var first, then common fallbacks. */
export function resolveApiKey(
  config: Pick<Config, 'apiKeyEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of [config.apiKeyEnv, 'CWV_API_KEY', 'CRUX_API_KEY', 'GOOGLE_API_KEY']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Form factors for a target, falling back to the global list. */
export function formFactorsFor(config: Config, target: TargetConfig): FormFactor[] {
  return target.formFactors ?? config.formFactors;
}

export function budgetsFor(config: Config, target: TargetConfig): Budgets {
  return { ...config.budgets, ...target.budgets };
}

export function labBudgetsFor(config: Config, target: TargetConfig): LabBudgets {
  return { ...config.labBudgets, ...target.labBudgets };
}
