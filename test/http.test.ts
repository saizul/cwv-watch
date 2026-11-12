import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, parseRetryAfter } from '../src/http.js';
import { ApiError, NetworkError, TimeoutError } from '../src/errors.js';
import { mockFetch, noSleep } from './helpers.js';

test('GET returns parsed JSON and sends a user agent', async () => {
  const { fetch, calls } = mockFetch([['/ok', () => ({ body: { hello: 'world' } })]]);
  const http = new HttpClient({ fetch, sleep: noSleep });
  assert.deepEqual(await http.json('https://api.test/ok'), { hello: 'world' });
  assert.equal(calls[0]!.method, 'GET');
  assert.match(calls[0]!.headers['user-agent']!, /^cwv-watch\//);
});

test('POST sends a JSON body', async () => {
  const { fetch, calls } = mockFetch([['/post', () => ({ body: {} })]]);
  await new HttpClient({ fetch }).json('https://api.test/post', { body: { a: 1 } });
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  assert.deepEqual(calls[0]!.body, { a: 1 });
});

test('Google error bodies become ApiError with status and message', async () => {
  const { fetch } = mockFetch([
    ['/', () => ({ status: 400, body: { error: { code: 400, message: 'Bad origin', status: 'INVALID_ARGUMENT' } } })],
  ]);
  const err = await new HttpClient({ fetch, retries: 0 }).json('https://api.test/x').catch((e: unknown) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 400);
  assert.equal(err.apiStatus, 'INVALID_ARGUMENT');
  assert.match(err.message, /Bad origin/);
  assert.equal(err.isRetryable, false);
});

test('retries 429 and 5xx, then succeeds', async () => {
  let n = 0;
  const { fetch, calls } = mockFetch([
    ['/', () => (++n < 3 ? { status: n === 1 ? 429 : 503, body: {} } : { body: { ok: true } })],
  ]);
  const delays: number[] = [];
  const http = new HttpClient({ fetch, retries: 2, sleep: async (ms) => void delays.push(ms), random: () => 0 });
  assert.deepEqual(await http.json('https://api.test/r'), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(delays.length, 2);
});

test('gives up after the retry budget', async () => {
  const { fetch, calls } = mockFetch([['/', () => ({ status: 500, body: {} })]]);
  const http = new HttpClient({ fetch, retries: 1, sleep: noSleep });
  await assert.rejects(http.json('https://api.test/r'), ApiError);
  assert.equal(calls.length, 2);
});

test('does not retry 4xx other than 429', async () => {
  const { fetch, calls } = mockFetch([['/', () => ({ status: 403, body: {} })]]);
  await assert.rejects(new HttpClient({ fetch, retries: 3, sleep: noSleep }).json('https://api.test/r'), ApiError);
  assert.equal(calls.length, 1);
});

test('honours Retry-After seconds', async () => {
  let n = 0;
  const { fetch } = mockFetch([
    ['/', () => (n++ === 0 ? { status: 429, body: {}, headers: { 'retry-after': '7' } } : { body: {} })],
  ]);
  const delays: number[] = [];
  await new HttpClient({ fetch, sleep: async (ms) => void delays.push(ms) }).json('https://api.test/r');
  assert.deepEqual(delays, [7000]);
});

test('Retry-After is capped by retryMaxMs', async () => {
  let n = 0;
  const { fetch } = mockFetch([
    ['/', () => (n++ === 0 ? { status: 503, body: {}, headers: { 'retry-after': '3600' } } : { body: {} })],
  ]);
  const delays: number[] = [];
  await new HttpClient({ fetch, retryMaxMs: 5000, sleep: async (ms) => void delays.push(ms) }).json(
    'https://api.test/r',
  );
  assert.deepEqual(delays, [5000]);
});

test('network errors are wrapped and retried', async () => {
  let n = 0;
  const fetch = async () => {
    if (n++ === 0) throw new TypeError('fetch failed');
    return new Response('{"v":1}');
  };
  const http = new HttpClient({ fetch, sleep: noSleep });
  assert.deepEqual(await http.json('https://api.test/n'), { v: 1 });
  const always = new HttpClient({
    fetch: async () => {
      throw new TypeError('ECONNRESET');
    },
    retries: 0,
  });
  await assert.rejects(always.json('https://api.test/n'), NetworkError);
});

test('timeouts raise TimeoutError', async () => {
  const fetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const http = new HttpClient({ fetch, timeoutMs: 20, retries: 0 });
  await assert.rejects(http.json('https://api.test/slow'), TimeoutError);
});

test('API keys never appear in error messages', async () => {
  const { fetch } = mockFetch([['/', () => ({ status: 400, text: 'bad key SECRETKEY123' })]]);
  const http = new HttpClient({ fetch, retries: 0, secrets: ['SECRETKEY123'] });
  const err = (await http.json('https://api.test/x?key=SECRETKEY123').catch((e: unknown) => e)) as ApiError;
  assert.ok(!err.message.includes('SECRETKEY123'));
  assert.ok(!err.url.includes('SECRETKEY123'));
});

test('invalid JSON from a 200 is a NetworkError', async () => {
  const { fetch } = mockFetch([['/', () => ({ text: 'not json' })]]);
  await assert.rejects(new HttpClient({ fetch }).json('https://api.test/x'), NetworkError);
});

test('backoff grows exponentially within the jitter range', () => {
  const http = new HttpClient({ fetch: async () => new Response('{}'), retryBaseMs: 1000, random: () => 0.999 });
  assert.ok(http.delayFor(0, null) <= 1000 && http.delayFor(0, null) >= 500);
  assert.ok(http.delayFor(2, null) <= 4000 && http.delayFor(2, null) >= 2000);
});

test('parseRetryAfter', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('garbage'), null);
  const now = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 12 Nov 2026 00:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Wed, 11 Nov 2026 00:00:00 GMT', now), 0);
});
