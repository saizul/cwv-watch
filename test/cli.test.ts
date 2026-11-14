import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, HELP, main, type CliIo } from '../src/cli.js';
import { cruxHistory, cruxRecord, mockFetch, noSleep, psiResponse } from './helpers.js';

function io(env: Record<string, string> = {}, lcp = 2100) {
  const out: string[] = [];
  const err: string[] = [];
  const m = mockFetch([
    [
      ':queryRecord',
      (c) => ({ body: cruxRecord({ url: (c.body as { url: string }).url }, { lcp, inp: 150, cls: 0.05 }) }),
    ],
    [':queryHistoryRecord', () => ({ body: cruxHistory({ origin: 'x' }, [2000, 2100, 2000, 2050]) })],
    ['runPagespeed', () => ({ body: psiResponse() })],
    ['hooks.example.com', () => ({ body: {} })],
  ]);
  const value: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
    fetch: m.fetch,
    sleep: noSleep,
  };
  return { io: value, out, err, calls: m.calls };
}

async function setup(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-cli-'));
  const config = {
    targets: [{ name: 'Home', url: 'https://www.example.com/' }],
    formFactors: ['PHONE'],
    storage: { path: join(dir, 'state', 'history.json') },
    reports: { outDir: join(dir, 'report') },
    ...extra,
  };
  const path = join(dir, 'cwv-watch.config.json');
  await writeFile(path, JSON.stringify(config));
  return { dir, path };
}

test('--help and --version', async () => {
  const a = io();
  assert.equal(await main(['--help'], a.io), EXIT.ok);
  assert.equal(a.out.join(''), HELP);
  const b = io();
  assert.equal(await main(['-v'], b.io), EXIT.ok);
  assert.match(b.out.join(''), /^\d+\.\d+\.\d+\n$/);
});

test('unknown commands and flags are usage errors', async () => {
  assert.equal(await main(['frobnicate'], io().io), EXIT.usage);
  assert.equal(await main(['run', '--bogus'], io().io), EXIT.usage);
});

test('run writes reports, updates history and passes', async () => {
  const { dir, path } = await setup();
  const t = io({ CWV_API_KEY: 'K' });
  const code = await main(['run', '-c', path], t.io);
  assert.equal(code, EXIT.ok, t.err.join(''));
  for (const f of ['cwv-report.md', 'cwv-report.json', 'cwv-report.html'])
    assert.ok(existsSync(join(dir, 'report', f)), f);
  const store = JSON.parse(await readFile(join(dir, 'state', 'history.json'), 'utf8'));
  assert.equal(store.runs.length, 1);
  assert.match(t.err.join(''), /PASSED/);
});

test('budget failure exits 1, --no-fail exits 0', async () => {
  const { path } = await setup();
  assert.equal(await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K' }, 5000).io), EXIT.failed);
  assert.equal(await main(['run', '-c', path, '-q', '--no-fail'], io({ CWV_API_KEY: 'K' }, 5000).io), EXIT.ok);
});

test('--fail-on-regression fails on a regression that is still within budget', async () => {
  const { path } = await setup({ budgets: { lcp: 4000 } });
  assert.equal(await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K' }, 2000).io), EXIT.ok);
  assert.equal(await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K' }, 2400).io), EXIT.ok);
  assert.equal(
    await main(['run', '-c', path, '-q', '--fail-on-regression'], io({ CWV_API_KEY: 'K' }, 2900).io),
    EXIT.failed,
  );
});

test('--stdout prints a report and --format limits files', async () => {
  const { dir, path } = await setup();
  const t = io({ CWV_API_KEY: 'K' });
  await main(['run', '-c', path, '-q', '--format', 'json', '--stdout', 'md', '--no-store'], t.io);
  assert.match(t.out.join(''), /^# Core Web Vitals report/);
  assert.ok(existsSync(join(dir, 'report', 'cwv-report.json')));
  assert.ok(!existsSync(join(dir, 'report', 'cwv-report.html')));
  assert.ok(!existsSync(join(dir, 'state', 'history.json')), '--no-store skips history');
});

test('bad --format is a usage error', async () => {
  const { path } = await setup();
  assert.equal(await main(['run', '-c', path, '--format', 'pdf'], io({ CWV_API_KEY: 'K' }).io), EXIT.usage);
});

test('missing API key is a runtime error with a helpful message', async () => {
  const { path } = await setup();
  const t = io({});
  assert.equal(await main(['run', '-c', path], t.io), EXIT.error);
  assert.match(t.err.join(''), /CWV_API_KEY/);
});

test('--no-psi skips PageSpeed Insights', async () => {
  const { path } = await setup();
  const t = io({ CWV_API_KEY: 'K' });
  await main(['run', '-c', path, '-q', '--no-psi', '--no-history'], t.io);
  assert.ok(!t.calls.some((c) => c.url.includes('runPagespeed') || c.url.includes('History')));
});

test('GITHUB_STEP_SUMMARY receives the Markdown report', async () => {
  const { dir, path } = await setup();
  const summary = join(dir, 'summary.md');
  await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K', GITHUB_STEP_SUMMARY: summary }).io);
  assert.match(await readFile(summary, 'utf8'), /Core Web Vitals report/);
});

test('notifications are sent on failure and skipped with --no-notify', async () => {
  const { path } = await setup({ notify: { on: 'failure', webhook: { url: 'https://hooks.example.com/cwv' } } });
  const a = io({ CWV_API_KEY: 'K' }, 5000);
  await main(['run', '-c', path, '-q'], a.io);
  assert.equal(a.calls.filter((c) => c.url.includes('hooks.example.com')).length, 1);
  const b = io({ CWV_API_KEY: 'K' }, 5000);
  await main(['run', '-c', path, '-q', '--no-notify'], b.io);
  assert.equal(b.calls.filter((c) => c.url.includes('hooks.example.com')).length, 0);
});

test('validate reports problems with exit 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-cli-'));
  const path = join(dir, 'c.json');
  await writeFile(path, JSON.stringify({ targets: [{ url: 'nope' }] }));
  const t = io();
  assert.equal(await main(['validate', '-c', path], t.io), EXIT.usage);
  assert.match(t.err.join(''), /targets\[0\]\.url/);
  const good = await setup();
  const g = io();
  assert.equal(await main(['validate', '-c', good.path], g.io), EXIT.ok);
  assert.match(g.out.join(''), /Configuration OK/);
  assert.match(g.out.join(''), /CWV_API_KEY is not set/);
});

test('init writes a starter config and refuses to overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-cli-'));
  const path = join(dir, 'cwv-watch.config.json');
  assert.equal(await main(['init', '-c', path], io().io), EXIT.ok);
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(written.targets));
  assert.equal(await main(['init', '-c', path], io().io), EXIT.usage);
  assert.equal(await main(['init', '-c', path, '--force'], io().io), EXIT.ok);
  assert.equal(await main(['validate', '-c', path], io().io), EXIT.ok);
});

test('report re-renders a JSON report', async () => {
  const { dir, path } = await setup();
  await main(['run', '-c', path, '-q', '--format', 'json'], io({ CWV_API_KEY: 'K' }).io);
  const t = io();
  const input = join(dir, 'report', 'cwv-report.json');
  assert.equal(await main(['report', '--input', input, '--out', join(dir, 'again'), '-q'], t.io), EXIT.ok);
  assert.ok(existsSync(join(dir, 'again', 'cwv-report.html')));
  const s = io();
  await main(['report', '--input', input, '--stdout', 'html'], s.io);
  assert.match(s.out.join(''), /<!DOCTYPE html>/);
  assert.equal(await main(['report'], io().io), EXIT.usage);
});

test('report rejects foreign JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-cli-'));
  const p = join(dir, 'x.json');
  await writeFile(p, '{"hello":1}');
  assert.equal(await main(['report', '--input', p], io().io), EXIT.usage);
});

test('--format junit writes a JUnit XML report whose failures match the exit code', async () => {
  const { dir, path } = await setup();
  const t = io({ CWV_API_KEY: 'K' }, 5000);
  assert.equal(await main(['run', '-c', path, '-q', '--format', 'junit,json', '--no-store'], t.io), EXIT.failed);
  const xml = await readFile(join(dir, 'report', 'cwv-report.junit.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites name="cwv-watch" tests="\d+" failures="1" errors="0"/);
  assert.match(xml, /type="BudgetFailure"/);
  const report = JSON.parse(await readFile(join(dir, 'report', 'cwv-report.json'), 'utf8'));
  assert.deepEqual(report.summary.gates, { budget: true, regression: false, errors: false });
});

test('report re-renders a JSON report as JUnit XML using the gates of the run', async () => {
  const { dir, path } = await setup({ budgets: { lcp: 4000 }, failOn: { regression: true } });
  await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K' }, 2000).io);
  assert.equal(await main(['run', '-c', path, '-q'], io({ CWV_API_KEY: 'K' }, 2900).io), EXIT.failed);
  const input = join(dir, 'report', 'cwv-report.json');
  const s = io();
  assert.equal(await main(['report', '--input', input, '--stdout', 'junit'], s.io), EXIT.ok);
  const xml = s.out.join('');
  assert.match(xml, /<failure message="LCP 2 s -&gt; 2.9 s \(\+45.0%\)" type="Regression">/);
  assert.equal(
    await main(['report', '--input', input, '--format', 'junit', '--out', join(dir, 'x'), '-q'], io().io),
    0,
  );
  assert.equal(await readFile(join(dir, 'x', 'cwv-report.junit.xml'), 'utf8'), xml);
});
