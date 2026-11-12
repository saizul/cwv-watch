import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult } from './model.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';

export type ReportFormat = 'md' | 'json' | 'html';

export const REPORT_FILES: Record<ReportFormat, string> = {
  md: 'cwv-report.md',
  json: 'cwv-report.json',
  html: 'cwv-report.html',
};

export function render(run: RunResult, format: ReportFormat): string {
  switch (format) {
    case 'md':
      return renderMarkdown(run);
    case 'json':
      return renderJson(run);
    case 'html':
      return renderHtml(run);
  }
}

export async function writeReports(
  run: RunResult,
  outDir: string,
  formats: readonly ReportFormat[],
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const format of formats) {
    const path = join(outDir, REPORT_FILES[format]);
    await writeFile(path, render(run, format), 'utf8');
    written.push(path);
  }
  return written;
}
