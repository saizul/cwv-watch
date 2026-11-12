import { resolveConfig, type Config } from '../src/config.js';
import { parseHistory, parseRecord, type FieldData, type HistoryData } from '../src/crux.js';
import { evaluateTarget, summarize } from '../src/evaluate.js';
import type { RunResult, TargetResult } from '../src/model.js';
import { parsePsi, type LabData } from '../src/psi.js';
import { cruxHistory, cruxRecord, psiResponse } from './helpers.js';

export function config(overrides: Record<string, unknown> = {}): Config {
  return resolveConfig({ targets: [{ name: 'Home', url: 'https://www.example.com/' }], ...overrides });
}

export function field(p75: Parameters<typeof cruxRecord>[1]): FieldData {
  return parseRecord(cruxRecord({ url: 'https://www.example.com/', formFactor: 'PHONE' }, p75) as never, {
    url: 'https://www.example.com/',
    formFactor: 'PHONE',
  });
}

export function history(lcp: Array<number | null>): HistoryData {
  return parseHistory(cruxHistory({ url: 'https://www.example.com/', formFactor: 'PHONE' }, lcp) as never, {
    url: 'https://www.example.com/',
    formFactor: 'PHONE',
  });
}

export function lab(opts: Parameters<typeof psiResponse>[0] = {}): LabData {
  return parsePsi(psiResponse(opts) as never, 'https://www.example.com/', 'mobile');
}

export function target(
  opts: {
    cfg?: Config;
    field?: FieldData | null;
    history?: HistoryData | null;
    lab?: LabData | null;
    previous?: TargetResult;
    errors?: TargetResult['errors'];
    name?: string;
  } = {},
): TargetResult {
  const cfg = opts.cfg ?? config();
  const name = opts.name ?? 'Home';
  return evaluateTarget({
    config: cfg,
    key: `${name}|PHONE`,
    name,
    url: 'https://www.example.com/',
    formFactor: 'PHONE',
    field: opts.field === undefined ? field({ lcp: 2100, inp: 150, cls: 0.05, fcp: 1500, ttfb: 600 }) : opts.field,
    history: opts.history === undefined ? history([2000, 2050, 2100, 2150]) : opts.history,
    lab: opts.lab === undefined ? lab() : opts.lab,
    errors: opts.errors ?? [],
    budgets: cfg.budgets,
    labBudgets: cfg.labBudgets,
    previous: opts.previous,
  });
}

export function run(results: TargetResult[], cfg: Config = config(), previousRunAt: string | null = null): RunResult {
  return {
    tool: 'cwv-watch',
    version: '0.1.0',
    startedAt: '2026-11-12T06:00:00.000Z',
    finishedAt: '2026-11-12T06:01:00.000Z',
    previousRunAt,
    results,
    summary: summarize(results, cfg.failOn),
  };
}
