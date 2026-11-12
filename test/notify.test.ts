import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import {
  SlackNotifier,
  TelegramNotifier,
  WebhookNotifier,
  buildNotifiers,
  detailLines,
  headline,
  notifyAll,
  plainMessage,
  problemSignature,
  shouldNotify,
} from '../src/notify/index.js';
import { resolveConfig } from '../src/config.js';
import { field, run, target } from './fixtures.js';
import { mockFetch, noSleep } from './helpers.js';

const okRun = () => run([target()]);
const badRun = () => run([target({ field: field({ lcp: 5000, inp: 150, cls: 0.05 }) })]);

test('headline and details', () => {
  assert.match(headline(okRun()), /^Core Web Vitals PASSED: 1 target/);
  assert.match(headline(badRun()), /FAILED.*1 budget failure/);
  assert.match(detailLines(okRun())[0]!, /Home \[phone\]: ok \(Good, LCP 2.1 s\)/);
  assert.match(detailLines(badRun())[0]!, /budget LCP \(field\) 5 s/);
});

test('plainMessage caps lines and adds the report link', () => {
  const many = run(Array.from({ length: 30 }, (_, i) => target({ name: `T${i}` })));
  const text = plainMessage(many, { maxLines: 5, reportUrl: 'https://ci.example.com/run/1' });
  assert.match(text, /\.\.\. and 25 more/);
  assert.match(text, /Report: https:\/\/ci\.example\.com\/run\/1$/);
});

test('shouldNotify modes', () => {
  assert.equal(shouldNotify('always', okRun(), undefined), true);
  assert.equal(shouldNotify('never', badRun(), undefined), false);
  assert.equal(shouldNotify('failure', okRun(), undefined), false);
  assert.equal(shouldNotify('failure', badRun(), undefined), true);
  assert.equal(shouldNotify('change', badRun(), badRun()), false);
  assert.equal(shouldNotify('change', okRun(), badRun()), true, 'recovery is a change');
  assert.equal(shouldNotify('change', badRun(), okRun()), true);
  assert.equal(shouldNotify('change', okRun(), undefined), false);
  assert.equal(shouldNotify('change', badRun(), undefined), true);
});

test('problemSignature is order independent', () => {
  assert.equal(problemSignature(undefined), '');
  assert.equal(problemSignature(badRun()), 'Home|PHONE:budget:field:lcp');
});

test('webhook notifier posts a JSON summary with custom headers', async () => {
  const { fetch, calls } = mockFetch([['hooks.example.com', () => ({ body: {} })]]);
  const n = new WebhookNotifier(new HttpClient({ fetch }), 'https://hooks.example.com/cwv', {
    authorization: 'Bearer t',
  });
  await n.send(badRun());
  const body = calls[0]!.body as {
    event: string;
    passed: boolean;
    results: Array<{ metrics: { lcp: { p75: number } } }>;
  };
  assert.equal(body.event, 'cwv-watch.run');
  assert.equal(body.passed, false);
  assert.equal(body.results[0]!.metrics.lcp.p75, 5000);
  assert.equal(calls[0]!.headers.authorization, 'Bearer t');
});

test('slack notifier sends text and blocks and accepts a plain "ok" body', async () => {
  const { fetch, calls } = mockFetch([
    ['hooks.slack.com', () => ({ text: 'ok', headers: { 'content-type': 'text/plain' } })],
  ]);
  await new SlackNotifier(new HttpClient({ fetch }), 'https://hooks.slack.com/services/T/B/X').send(badRun());
  const body = calls[0]!.body as { text: string; blocks: Array<{ type: string }> };
  assert.match(body.text, /FAILED/);
  assert.equal(body.blocks[0]!.type, 'header');
  assert.equal(body.blocks.length, 3);
});

test('telegram notifier calls sendMessage with chat_id', async () => {
  const { fetch, calls } = mockFetch([['api.telegram.org', () => ({ body: { ok: true, result: {} } })]]);
  await new TelegramNotifier(new HttpClient({ fetch }), '123:ABC', '-100200').send(okRun());
  assert.equal(calls[0]!.url, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal((calls[0]!.body as { chat_id: string }).chat_id, '-100200');
});

test('telegram ok:false is an error', async () => {
  const { fetch } = mockFetch([['api.telegram.org', () => ({ body: { ok: false, description: 'chat not found' } })]]);
  await assert.rejects(new TelegramNotifier(new HttpClient({ fetch }), 't', 'c').send(okRun()), /chat not found/);
});

test('buildNotifiers resolves env vars and reports missing ones', () => {
  const cfg = resolveConfig({
    targets: ['https://a.test'],
    notify: {
      slack: { urlEnv: 'SLACK_URL' },
      telegram: { botTokenEnv: 'TG', chatIdEnv: 'TG_CHAT' },
      webhook: { url: 'https://h.test/x' },
    },
  });
  const none = buildNotifiers(cfg.notify, { env: {} });
  assert.deepEqual(
    none.notifiers.map((n) => n.name),
    ['webhook'],
  );
  assert.equal(none.problems.length, 2);
  const all = buildNotifiers(cfg.notify, {
    env: { SLACK_URL: 'https://hooks.slack.com/services/a', TG: 'tok', TG_CHAT: '1' },
  });
  assert.deepEqual(
    all.notifiers.map((n) => n.name),
    ['webhook', 'slack', 'telegram'],
  );
  assert.ok(all.secrets.includes('tok'));
});

test('notifyAll isolates failures and redacts secrets', async () => {
  const { fetch } = mockFetch([
    ['good.test', () => ({ body: {} })],
    ['api.telegram.org', () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } })],
  ]);
  const http = new HttpClient({ fetch, retries: 0, sleep: noSleep, secrets: ['SECRET:TOKEN'] });
  const outcome = await notifyAll(
    [new WebhookNotifier(http, 'https://good.test/'), new TelegramNotifier(http, 'SECRET:TOKEN', '1')],
    okRun(),
    ['SECRET:TOKEN'],
  );
  assert.deepEqual(outcome.sent, ['webhook']);
  assert.equal(outcome.failed[0]!.name, 'telegram');
  assert.ok(!outcome.failed[0]!.error.includes('SECRET:TOKEN'));
});
