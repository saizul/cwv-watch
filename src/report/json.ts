import type { RunResult } from '../model.js';

/** Machine-readable report; the full run including raw normalised API data. */
export function renderJson(run: RunResult): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}
