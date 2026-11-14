import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  budgetsFor,
  formFactorsFor,
  labBudgetsFor,
  loadConfig,
  resolveApiKey,
  resolveConfig,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const minimal = { targets: [{ url: 'https://www.example.com/' }] };

function issues(input: unknown): string[] {
  try {
    resolveConfig(input);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.issues;
  }
  return [];
}

test('minimal config gets defaults', () => {
  const c = resolveConfig(minimal);
  assert.equal(c.targets[0]!.name, 'https://www.example.com/');
  assert.deepEqual(c.formFactors, ['PHONE', 'DESKTOP']);
  assert.deepEqual(c.budgets, { lcp: 'good', inp: 'good', cls: 'good' });
  assert.equal(c.rateLimit.cruxPerMinute, 120);
  assert.equal(c.storage.path, DEFAULT_CONFIG.storage.path);
  assert.equal(c.failOn.budget, true);
  assert.equal(c.failOn.regression, false);
});

test('string targets: origins vs URLs', () => {
  const c = resolveConfig({ targets: ['https://www.example.com', 'https://www.example.com/blog/'] });
  assert.equal(c.targets[0]!.origin, 'https://www.example.com');
  assert.equal(c.targets[1]!.url, 'https://www.example.com/blog/');
});

test('origin trailing slash is removed and paths are rejected', () => {
  assert.equal(
    resolveConfig({ targets: [{ origin: 'https://www.example.com/' }] }).targets[0]!.origin,
    'https://www.example.com',
  );
  assert.ok(
    issues({ targets: [{ origin: 'https://www.example.com/blog' }] }).some((i) =>
      i.includes('must not contain a path'),
    ),
  );
});

test('rejects empty or missing targets', () => {
  assert.ok(issues({}).some((i) => i.startsWith('targets')));
  assert.ok(issues({ targets: [] }).length > 0);
});

test('rejects a target with both url and origin, or neither', () => {
  assert.ok(issues({ targets: [{ url: 'https://a.test/', origin: 'https://a.test' }] }).length > 0);
  assert.ok(issues({ targets: [{ name: 'x' }] }).length > 0);
});

test('rejects non-http URLs', () => {
  assert.ok(issues({ targets: [{ url: 'ftp://a.test/' }] }).some((i) => i.includes('http(s)')));
  assert.ok(issues({ targets: [{ url: 'not a url' }] }).length > 0);
});

test('rejects duplicate target names', () => {
  const got = issues({
    targets: [
      { name: 'A', url: 'https://a.test/' },
      { name: 'A', url: 'https://a.test/b' },
    ],
  });
  assert.ok(got.some((i) => i.includes('duplicate')));
});

test('form factors are upper-cased and validated', () => {
  const c = resolveConfig({ ...minimal, formFactors: ['phone', 'tablet', 'PHONE'] });
  assert.deepEqual(c.formFactors, ['PHONE', 'TABLET']);
  assert.ok(issues({ ...minimal, formFactors: ['watch'] }).length > 0);
  assert.ok(issues({ ...minimal, formFactors: [] }).length > 0);
});

test('budgets accept numbers and ratings only for known metrics', () => {
  const c = resolveConfig({ ...minimal, budgets: { lcp: 3000, cls: 'needs-improvement' } });
  assert.deepEqual(c.budgets, { lcp: 3000, cls: 'needs-improvement' });
  assert.ok(issues({ ...minimal, budgets: { fid: 100 } }).some((i) => i.includes('unknown metric')));
  assert.ok(issues({ ...minimal, budgets: { lcp: 'fast' } }).length > 0);
  assert.ok(issues({ ...minimal, budgets: { lcp: -1 } }).length > 0);
});

test('lab budgets', () => {
  const c = resolveConfig({ ...minimal, labBudgets: { performanceScore: 80, tbt: 300, lcp: 3000 } });
  assert.deepEqual(c.labBudgets, { performanceScore: 80, tbt: 300, lcp: 3000 });
  assert.ok(issues({ ...minimal, labBudgets: { performanceScore: 120 } }).length > 0);
  assert.ok(issues({ ...minimal, labBudgets: { speed: 1 } }).length > 0);
});

test('target overrides merge with global budgets and form factors', () => {
  const c = resolveConfig({
    targets: [
      {
        name: 'Blog',
        url: 'https://a.test/blog/',
        budgets: { lcp: 3000 },
        labBudgets: { tbt: 200 },
        formFactors: ['DESKTOP'],
      },
    ],
    labBudgets: { performanceScore: 70 },
  });
  const t = c.targets[0]!;
  assert.deepEqual(budgetsFor(c, t), { lcp: 3000, inp: 'good', cls: 'good' });
  assert.deepEqual(labBudgetsFor(c, t), { performanceScore: 70, tbt: 200 });
  assert.deepEqual(formFactorsFor(c, t), ['DESKTOP']);
});

test('numeric ranges are enforced', () => {
  assert.ok(issues({ ...minimal, historyPeriods: 41 }).length > 0);
  assert.ok(issues({ ...minimal, concurrency: 0 }).length > 0);
  assert.ok(issues({ ...minimal, concurrency: 2.5 }).length > 0);
  assert.ok(issues({ ...minimal, http: { timeoutMs: 10 } }).length > 0);
  assert.equal(resolveConfig({ ...minimal, historyPeriods: 40 }).historyPeriods, 40);
});

test('unknown top-level options are reported', () => {
  assert.ok(issues({ ...minimal, budget: {} }).some((i) => i.includes('unknown option')));
});

test('all problems are reported at once', () => {
  const got = issues({ targets: [{ url: 'x' }], concurrency: -1, formFactors: ['x'] });
  assert.ok(got.length >= 3);
});

test('report formats and regression settings', () => {
  const c = resolveConfig({
    ...minimal,
    reports: { formats: ['json'] },
    regression: { relative: 0.2, absolute: { lcp: 250 }, ratingDrop: false },
  });
  assert.deepEqual(c.reports.formats, ['json']);
  assert.equal(c.regression.relative, 0.2);
  assert.equal(c.regression.absolute.lcp, 250);
  assert.equal(c.regression.absolute.inp, 20);
  assert.equal(c.regression.ratingDrop, false);
  assert.ok(issues({ ...minimal, reports: { formats: ['pdf'] } }).length > 0);
  assert.deepEqual(resolveConfig({ ...minimal, reports: { formats: ['junit', 'md'] } }).reports.formats, [
    'junit',
    'md',
  ]);
});

test('notify configuration', () => {
  const c = resolveConfig({
    ...minimal,
    notify: {
      on: 'change',
      webhook: { url: 'https://hooks.example.com/cwv', headers: { authorization: 'Bearer x' } },
      slack: { urlEnv: 'SLACK_WEBHOOK_URL' },
      telegram: { botTokenEnv: 'TG_TOKEN', chatIdEnv: 'TG_CHAT' },
    },
  });
  assert.equal(c.notify.on, 'change');
  assert.equal(c.notify.slack?.urlEnv, 'SLACK_WEBHOOK_URL');
  assert.equal(c.notify.telegram?.chatIdEnv, 'TG_CHAT');
  assert.ok(issues({ ...minimal, notify: { on: 'sometimes' } }).length > 0);
  assert.ok(issues({ ...minimal, notify: { slack: {} } }).length > 0);
  assert.ok(issues({ ...minimal, notify: { telegram: { botTokenEnv: 'T' } } }).length > 0);
});

test('resolveApiKey prefers the configured variable then falls back', () => {
  assert.equal(resolveApiKey({ apiKeyEnv: 'MY_KEY' }, { MY_KEY: ' abc ', CWV_API_KEY: 'zzz' }), 'abc');
  assert.equal(resolveApiKey({ apiKeyEnv: 'MY_KEY' }, { CRUX_API_KEY: 'c' }), 'c');
  assert.equal(resolveApiKey({ apiKeyEnv: 'MY_KEY' }, {}), undefined);
});

test('loadConfig reads JSON files and reports parse errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-config-'));
  const good = join(dir, 'good.json');
  await writeFile(good, JSON.stringify(minimal));
  assert.equal((await loadConfig(good)).targets.length, 1);
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ nope');
  await assert.rejects(loadConfig(bad), /not valid JSON/);
  await assert.rejects(loadConfig(join(dir, 'missing.json')), /Cannot read/);
});

test('non-object config is rejected', () => {
  assert.throws(() => resolveConfig([]), ConfigError);
  assert.throws(() => resolveConfig(null), ConfigError);
});
