import { describeLimit } from '../evaluate.js';
import { formatValue } from '../metrics.js';
import type { Gates, RunResult, TargetResult } from '../model.js';
import { budgetLine, metricShort, regressionLine } from './text.js';

/** Gates used when a report predates `summary.gates` (cwv-watch 0.1.0 JSON reports). */
export const DEFAULT_GATES: Gates = { budget: true, regression: false, errors: false };

type Outcome =
  | { kind: 'pass'; note?: string }
  | { kind: 'failure'; message: string; type: string; detail: string }
  | { kind: 'error'; message: string; type: string; detail: string }
  | { kind: 'skipped'; message: string };

interface TestCase {
  name: string;
  outcome: Outcome;
}

// XML 1.0 forbids most C0 control characters even when escaped, and lone
// surrogates are not valid either; drop them so a stray byte in an API error
// message cannot make the whole report unparseable.
const INVALID_XML =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape text for an XML attribute value or text node. */
export function escapeXml(value: unknown): string {
  return String(value)
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/** Text node content: newlines are kept as-is so failure details stay readable. */
function escapeText(value: unknown): string {
  return String(value).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function suiteName(r: TargetResult): string {
  return `${r.name} [${r.formFactor}]`;
}

/** Dotted, identifier-like class name, as most JUnit viewers group test cases by it. */
export function junitClassName(r: TargetResult): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'target';
  return `cwv-watch.${slug(r.name)}.${slug(r.formFactor)}`;
}

function budgetCases(r: TargetResult, gates: Gates): TestCase[] {
  return r.budgets.map((b) => {
    const label = b.metric === 'performanceScore' ? 'Performance score' : b.metric.toUpperCase();
    // describeLimit says "score >= 70" for the performance score; the label already names it.
    const name = `budget ${b.source} ${label} ${describeLimit(b.metric, b.limit).replace(/^score /, '')}`;
    if (b.skipped) return { name, outcome: { kind: 'skipped', message: b.skipped } };
    if (b.passed) return { name, outcome: { kind: 'pass' } };
    const line = budgetLine(b);
    if (!gates.budget) return { name, outcome: { kind: 'pass', note: `not gated: ${line}` } };
    return { name, outcome: { kind: 'failure', type: 'BudgetFailure', message: line, detail: line } };
  });
}

/**
 * One case per metric that could be compared with the previous run. Metrics
 * without a previous or current p75 are left out rather than reported as
 * skipped, so a first run does not show a wall of skipped checks.
 */
function regressionCases(r: TargetResult, gates: Gates): TestCase[] {
  const out: TestCase[] = [];
  for (const m of r.metrics) {
    if (m.fieldP75 === null || m.previousP75 === null) continue;
    const name = `regression ${metricShort(m.metric)}`;
    const found = r.regressions.find((x) => x.metric === m.metric);
    if (!found) {
      const note = `${formatValue(m.metric, m.previousP75)} -> ${formatValue(m.metric, m.fieldP75)}`;
      out.push({ name, outcome: { kind: 'pass', note } });
      continue;
    }
    const line = regressionLine(found);
    if (!gates.regression) {
      out.push({ name, outcome: { kind: 'pass', note: `not gated: ${line}` } });
      continue;
    }
    out.push({
      name,
      outcome: {
        kind: 'failure',
        type: found.reason === 'rating-drop' ? 'RatingDrop' : 'Regression',
        message: line,
        detail: line,
      },
    });
  }
  return out;
}

function errorCases(r: TargetResult, gates: Gates): TestCase[] {
  return r.errors.map((x) => {
    const name = `api ${x.source}`;
    if (!gates.errors) return { name, outcome: { kind: 'skipped', message: `${x.source} error: ${x.message}` } };
    return { name, outcome: { kind: 'error', type: 'ApiError', message: x.message, detail: x.message } };
  });
}

/** The test cases for one target and form factor, in report order. */
export function junitCases(r: TargetResult, gates: Gates = DEFAULT_GATES): TestCase[] {
  return [...budgetCases(r, gates), ...regressionCases(r, gates), ...errorCases(r, gates)];
}

function count(cases: TestCase[], kind: Outcome['kind']): number {
  return cases.filter((c) => c.outcome.kind === kind).length;
}

function seconds(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms > 0 ? (ms / 1000).toFixed(3) : '0';
}

function renderCase(r: TargetResult, c: TestCase): string {
  const open = `    <testcase name="${escapeXml(c.name)}" classname="${escapeXml(junitClassName(r))}" time="0"`;
  const o = c.outcome;
  switch (o.kind) {
    case 'pass':
      return o.note ? `${open}>\n      <system-out>${escapeText(o.note)}</system-out>\n    </testcase>` : `${open}/>`;
    case 'skipped':
      return `${open}>\n      <skipped message="${escapeXml(o.message)}"/>\n    </testcase>`;
    case 'failure':
    case 'error':
      return (
        `${open}>\n      <${o.kind} message="${escapeXml(o.message)}" type="${escapeXml(o.type)}">` +
        `${escapeText(o.detail)}</${o.kind}>\n    </testcase>`
      );
  }
}

function renderSuite(run: RunResult, r: TargetResult, gates: Gates, id: number): string {
  const cases = junitCases(r, gates);
  const props: Array<[string, string]> = [
    [r.url ? 'url' : 'origin', (r.url ?? r.origin ?? '') as string],
    ['formFactor', r.formFactor],
    ['overall', r.overall ?? 'no-data'],
  ];
  if (r.lab?.performanceScore !== null && r.lab?.performanceScore !== undefined) {
    props.push(['performanceScore', String(r.lab.performanceScore)]);
  }
  const attrs = [
    `name="${escapeXml(suiteName(r))}"`,
    `id="${id}"`,
    `tests="${cases.length}"`,
    `failures="${count(cases, 'failure')}"`,
    `errors="${count(cases, 'error')}"`,
    `skipped="${count(cases, 'skipped')}"`,
    `time="0"`,
    `timestamp="${escapeXml(run.startedAt.replace(/\.\d+Z$|Z$/, ''))}"`,
  ].join(' ');
  const properties = props.map(([k, v]) => `      <property name="${escapeXml(k)}" value="${escapeXml(v)}"/>`);
  return [
    `  <testsuite ${attrs}>`,
    '    <properties>',
    ...properties,
    '    </properties>',
    ...cases.map((c) => renderCase(r, c)),
    '  </testsuite>',
  ].join('\n');
}

/**
 * JUnit XML report: one test suite per target and form factor, one test case
 * per budget, per metric compared with the previous run and per API error.
 * Failures follow the run's gates, so the report and the exit code agree:
 * an ungated problem is a passing case with a note in `system-out`.
 */
export function renderJunit(run: RunResult, gates: Gates = run.summary.gates ?? DEFAULT_GATES): string {
  const suites = run.results.map((r, i) => renderSuite(run, r, gates, i));
  const all = run.results.flatMap((r) => junitCases(r, gates));
  const attrs = [
    `name="cwv-watch"`,
    `tests="${all.length}"`,
    `failures="${count(all, 'failure')}"`,
    `errors="${count(all, 'error')}"`,
    `skipped="${count(all, 'skipped')}"`,
    `time="${seconds(run.startedAt, run.finishedAt)}"`,
  ].join(' ');
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites ${attrs}>`, ...suites, '</testsuites>', ''].join('\n');
}
