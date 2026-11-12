import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CwvWatchError } from './errors.js';
import type { RunResult, TargetResult } from './model.js';

export const STORE_VERSION = 1;

export interface StoreFile {
  storeVersion: number;
  runs: RunResult[];
}

export function emptyStore(): StoreFile {
  return { storeVersion: STORE_VERSION, runs: [] };
}

/** Load the run history. A missing file is an empty history; a corrupt file is an error. */
export async function loadStore(path: string): Promise<StoreFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CwvWatchError(`History file ${path} is not valid JSON; fix or delete it`);
  }
  return validateStore(data, path);
}

export function validateStore(data: unknown, path = 'history'): StoreFile {
  const obj = data as Partial<StoreFile> | null;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.runs)) {
    throw new CwvWatchError(`History file ${path} has an unexpected shape`);
  }
  if (typeof obj.storeVersion === 'number' && obj.storeVersion > STORE_VERSION) {
    throw new CwvWatchError(
      `History file ${path} was written by a newer cwv-watch (store version ${obj.storeVersion})`,
    );
  }
  return { storeVersion: STORE_VERSION, runs: obj.runs.filter((r) => r && Array.isArray(r.results)) };
}

/**
 * Drop the bulky CrUX history time series before persisting; trends are
 * recomputed from the API on every run, so only the latest p75s are needed.
 */
export function compactRun(run: RunResult): RunResult {
  return {
    ...run,
    results: run.results.map((r) => ({
      ...r,
      history: null,
      metrics: r.metrics.map((m) => ({ ...m, trend: m.trend ? { ...m.trend, values: [], periods: [] } : null })),
    })),
  };
}

export function appendRun(store: StoreFile, run: RunResult, keepRuns: number): StoreFile {
  const runs = [...store.runs, compactRun(run)];
  return { storeVersion: STORE_VERSION, runs: runs.slice(Math.max(0, runs.length - keepRuns)) };
}

/** Atomic write: temp file then rename, so an interrupted CI job never leaves half a file. */
export async function saveStore(path: string, store: StoreFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export function latestRun(store: StoreFile): RunResult | undefined {
  return store.runs[store.runs.length - 1];
}

/** Previous results indexed by target key. */
export function indexResults(run: RunResult | undefined): Map<string, TargetResult> {
  return new Map((run?.results ?? []).map((r) => [r.key, r]));
}
