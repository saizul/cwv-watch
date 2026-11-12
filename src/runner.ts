import { budgetsFor, formFactorsFor, labBudgetsFor, type Config, type TargetConfig } from './config.js';
import { CruxClient, type FieldData, type FormFactor, type HistoryData } from './crux.js';
import { evaluateTarget, summarize } from './evaluate.js';
import { HttpClient, type FetchLike } from './http.js';
import { Limiter, mapLimit, type Clock, type Sleep } from './limiter.js';
import { resultKey, type RunResult, type TargetResult } from './model.js';
import { PsiClient, type LabData, type Strategy } from './psi.js';
import { redact } from './redact.js';
import { indexResults } from './store.js';
import { VERSION } from './version.js';

export interface RunOptions {
  config: Config;
  apiKey: string | undefined;
  previous?: RunResult | undefined;
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: Clock;
  /** Progress messages (to stderr in the CLI). */
  log?: (message: string) => void;
}

interface Job {
  target: TargetConfig;
  formFactor: FormFactor;
}

export function psiStrategy(formFactor: FormFactor): Strategy {
  return formFactor === 'DESKTOP' ? 'desktop' : 'mobile';
}

/** PSI needs a page URL; for an origin target the home page is tested. */
export function labUrl(target: TargetConfig): string {
  return target.url ?? `${target.origin}/`;
}

export function planJobs(config: Config): Job[] {
  return config.targets.flatMap((target) =>
    formFactorsFor(config, target).map((formFactor) => ({ target, formFactor })),
  );
}

export async function runWatch(options: RunOptions): Promise<RunResult> {
  const { config, apiKey } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const secrets = apiKey ? [apiKey] : [];
  const http = new HttpClient({
    fetch: options.fetch,
    timeoutMs: config.http.timeoutMs,
    retries: config.http.retries,
    sleep: options.sleep,
    secrets,
    onRetry: ({ attempt, delayMs, reason }) => log(`retry ${attempt} in ${delayMs} ms (${reason})`),
  });
  const limiterOpts = { concurrency: config.concurrency, now, sleep: options.sleep };
  const cruxLimiter = new Limiter({ ...limiterOpts, maxPerInterval: config.rateLimit.cruxPerMinute });
  const psiLimiter = new Limiter({ ...limiterOpts, maxPerInterval: config.rateLimit.psiPerMinute });

  const needCrux = config.sources.crux || config.sources.history;
  if (needCrux && !apiKey) {
    throw new Error(`The CrUX API needs an API key: set the ${config.apiKeyEnv} environment variable`);
  }
  const crux = needCrux ? new CruxClient({ http, apiKey: apiKey!, limiter: cruxLimiter }) : null;
  const psi = config.sources.psi ? new PsiClient({ http, apiKey, limiter: psiLimiter }) : null;
  const previous = indexResults(options.previous);

  const startedAt = new Date(now()).toISOString();
  const jobs = planJobs(config);
  log(`checking ${jobs.length} target/form-factor combination(s)`);

  // Each job issues up to three requests; the shared limiters cap the total.
  const results = await mapLimit(jobs, config.concurrency, async ({ target, formFactor }): Promise<TargetResult> => {
    const errors: TargetResult['errors'] = [];
    const query = {
      ...(target.url ? { url: target.url } : { origin: target.origin! }),
      formFactor,
      metrics: config.metrics,
    };
    const capture = async <T>(source: 'crux' | 'history' | 'psi', fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        errors.push({ source, message: redact((err as Error).message, secrets) });
        return null;
      }
    };
    const [field, history, lab] = await Promise.all([
      crux && config.sources.crux
        ? capture<FieldData | null>('crux', () => crux.queryRecord(query))
        : Promise.resolve(null),
      crux && config.sources.history
        ? capture<HistoryData | null>('history', () => crux.queryHistoryRecord(query, config.historyPeriods))
        : Promise.resolve(null),
      // PSI has no tablet or "all" strategy; run it once per target on phone/desktop only.
      psi && !target.skipLab && (formFactor === 'PHONE' || formFactor === 'DESKTOP')
        ? capture<LabData>('psi', () => psi.run(labUrl(target), psiStrategy(formFactor)))
        : Promise.resolve(null),
    ]);
    const label = `${target.name} [${formFactor}]`;
    log(`${label}: field ${field ? 'ok' : 'none'}, history ${history ? 'ok' : 'none'}, lab ${lab ? 'ok' : 'none'}`);
    const key = resultKey(target.name, formFactor);
    return evaluateTarget({
      config,
      key,
      name: target.name,
      ...(target.url ? { url: target.url } : {}),
      ...(target.origin ? { origin: target.origin } : {}),
      formFactor,
      field: field ?? null,
      history: history ?? null,
      lab: lab ?? null,
      errors,
      budgets: budgetsFor(config, target),
      labBudgets: labBudgetsFor(config, target),
      previous: previous.get(key),
    });
  });

  return {
    tool: 'cwv-watch',
    version: VERSION,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    previousRunAt: options.previous?.finishedAt ?? null,
    results,
    summary: summarize(results, config.failOn),
  };
}
