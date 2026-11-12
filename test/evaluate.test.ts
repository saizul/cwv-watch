import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBudget,
  checkFieldBudgets,
  checkLabBudgets,
  describeLimit,
  detectRegression,
  exitCodeFor,
  summarize,
} from '../src/evaluate.js';
import { config, field, lab, run, target } from './fixtures.js';

const reg = config().regression;

test('numeric budgets are inclusive ceilings', () => {
  assert.equal(checkBudget('lcp', 2500, 2500).passed, true);
  assert.equal(checkBudget('lcp', 2500, 2501).passed, false);
  assert.equal(checkBudget('cls', 0.1, 0.11).passed, false);
});

test('rating budgets allow that rating or better', () => {
  assert.equal(checkBudget('lcp', 'good', 2400).passed, true);
  assert.equal(checkBudget('lcp', 'good', 2600).passed, false);
  assert.equal(checkBudget('lcp', 'needs-improvement', 3900).passed, true);
  assert.equal(checkBudget('lcp', 'needs-improvement', 4100).passed, false);
  assert.equal(checkBudget('inp', 'poor', 9000).passed, true);
});

test('missing values skip the budget instead of failing', () => {
  const c = checkBudget('inp', 'good', null);
  assert.equal(c.passed, true);
  assert.equal(c.skipped, 'no field data');
});

test('checkFieldBudgets only checks configured metrics in the metric list', () => {
  const f = field({ lcp: 2600, inp: 150, cls: 0.3 });
  const checks = checkFieldBudgets({ lcp: 'good', cls: 0.25, ttfb: 800 }, f, ['lcp', 'cls']);
  assert.deepEqual(
    checks.map((c) => [c.metric, c.passed]),
    [
      ['lcp', false],
      ['cls', false],
    ],
  );
  assert.equal(checkFieldBudgets({ lcp: 'good' }, null, ['lcp'])[0]!.skipped, 'no field data');
});

test('checkLabBudgets: score is a floor, the rest are ceilings', () => {
  const l = lab({ score: 0.65, lcp: 3100, tbt: 250 });
  const checks = checkLabBudgets({ performanceScore: 70, lcp: 3000, tbt: 300 }, l);
  assert.deepEqual(
    checks.map((c) => [c.metric, c.passed]),
    [
      ['performanceScore', false],
      ['lcp', false],
      ['tbt', true],
    ],
  );
  assert.ok(checks.every((c) => c.source === 'lab'));
  assert.equal(checkLabBudgets({ performanceScore: 70 }, null)[0]!.skipped, 'no lab data');
  assert.equal(checkLabBudgets({ inp: 100 }, l)[0]!.skipped, 'metric not in Lighthouse result');
});

test('regression needs both relative and absolute thresholds', () => {
  assert.equal(detectRegression('lcp', 2000, 2250, reg)?.reason, 'threshold');
  assert.equal(detectRegression('lcp', 2000, 2150, reg), null, '7.5% is below 10%');
  assert.equal(detectRegression('inp', 100, 115, reg), null, '15 ms is below the 20 ms floor');
  assert.equal(detectRegression('cls', 0.02, 0.03, reg), null, '0.01 is below the 0.02 floor');
  assert.equal(detectRegression('cls', 0.05, 0.08, reg)?.reason, 'threshold');
});

test('rating drops count as regressions even below thresholds', () => {
  const r = detectRegression('lcp', 2480, 2560, reg);
  assert.equal(r?.reason, 'rating-drop');
  assert.equal(r?.previousRating, 'good');
  assert.equal(r?.currentRating, 'needs-improvement');
  assert.equal(detectRegression('lcp', 2480, 2560, { ...reg, ratingDrop: false }), null);
});

test('improvements and missing values are never regressions', () => {
  assert.equal(detectRegression('lcp', 3000, 2000, reg), null);
  assert.equal(detectRegression('lcp', null, 2000, reg), null);
  assert.equal(detectRegression('lcp', 2000, undefined, reg), null);
});

test('evaluateTarget builds metric summaries, budgets and overall rating', () => {
  const r = target();
  assert.equal(r.overall, 'good');
  const lcp = r.metrics.find((m) => m.metric === 'lcp')!;
  assert.equal(lcp.fieldP75, 2100);
  assert.equal(lcp.fieldRating, 'good');
  assert.equal(lcp.labValue, 2300);
  assert.equal(lcp.goodShare, 0.8);
  assert.equal(lcp.trend?.direction, 'worsening');
  assert.equal(r.budgets.filter((b) => !b.passed).length, 0);
  assert.equal(r.regressions.length, 0);
});

test('overall is the worst core metric rating', () => {
  const r = target({ field: field({ lcp: 2100, inp: 600, cls: 0.05, ttfb: 5000 }) });
  assert.equal(r.overall, 'poor');
  const r2 = target({ field: field({ lcp: 2100, inp: 150, cls: 0.05, ttfb: 5000 }) });
  assert.equal(r2.overall, 'good', 'TTFB is not a Core Web Vital');
});

test('evaluateTarget compares with the previous result', () => {
  const previous = target();
  const current = target({ field: field({ lcp: 2700, inp: 150, cls: 0.05 }), previous });
  const lcp = current.metrics.find((m) => m.metric === 'lcp')!;
  assert.equal(lcp.previousP75, 2100);
  assert.equal(lcp.delta, 600);
  assert.deepEqual(
    current.regressions.map((x) => x.metric),
    ['lcp'],
  );
  assert.equal(current.budgets.find((b) => b.metric === 'lcp')?.passed, false);
});

test('no field data gives null overall and skipped budgets', () => {
  const r = target({ field: null, history: null });
  assert.equal(r.overall, null);
  assert.ok(r.budgets.every((b) => b.passed));
  assert.ok(r.metrics.every((m) => m.trend === null));
});

test('summarize and exit codes follow failOn', () => {
  const failing = target({ field: field({ lcp: 5000, inp: 150, cls: 0.05 }) });
  const ok = target({ name: 'Other' });
  const cfg = config();
  const s = summarize([failing, ok], cfg.failOn);
  assert.equal(s.budgetFailures, 1);
  assert.equal(s.passed, false);
  assert.equal(exitCodeFor(run([failing, ok])), 1);
  assert.equal(exitCodeFor(run([ok])), 0);
  const lenient = summarize([failing], { budget: false, regression: false, errors: false });
  assert.equal(lenient.passed, true);
});

test('regressions and errors fail only when enabled', () => {
  const previous = target();
  const regressed = target({
    field: field({ lcp: 2400, inp: 150, cls: 0.05 }),
    previous,
    errors: [{ source: 'psi', message: 'x' }],
  });
  assert.equal(regressed.regressions.length, 1);
  assert.equal(summarize([regressed], { budget: true, regression: false, errors: false }).passed, true);
  assert.equal(summarize([regressed], { budget: true, regression: true, errors: false }).passed, false);
  assert.equal(summarize([regressed], { budget: true, regression: false, errors: true }).passed, false);
});

test('summary counts trends', () => {
  const s = summarize([target()], config().failOn);
  assert.equal(s.worsening, 1);
  assert.equal(s.withFieldData, 1);
});

test('describeLimit', () => {
  assert.equal(describeLimit('lcp', 2500), '<= 2500 ms');
  assert.equal(describeLimit('cls', 0.1), '<= 0.1');
  assert.equal(describeLimit('lcp', 'good'), 'rating good or better');
  assert.equal(describeLimit('performanceScore', 80), 'score >= 80');
  assert.equal(describeLimit('tbt', 200), '<= 200 ms');
});
