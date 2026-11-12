import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, mapLimit } from '../src/limiter.js';

test('caps concurrency', async () => {
  const limiter = new Limiter({ concurrency: 2, maxPerInterval: 0 });
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  };
  await Promise.all(Array.from({ length: 8 }, () => limiter.run(task)));
  assert.equal(peak, 2);
  assert.equal(limiter.running, 0);
});

test('caps requests per interval using the injected clock', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const limiter = new Limiter({
    concurrency: 10,
    maxPerInterval: 3,
    intervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const starts: number[] = [];
  await Promise.all(Array.from({ length: 7 }, () => limiter.run(async () => void starts.push(clock))));
  assert.deepEqual(starts, [0, 0, 0, 1000, 1000, 1000, 2000]);
  assert.ok(sleeps.length >= 2);
});

test('errors release the slot', async () => {
  const limiter = new Limiter({ concurrency: 1, maxPerInterval: 0 });
  await assert.rejects(
    limiter.run(async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await limiter.run(async () => 42), 42);
});

test('validates options', () => {
  assert.throws(() => new Limiter({ concurrency: 0, maxPerInterval: 1 }), RangeError);
  assert.throws(() => new Limiter({ concurrency: 1, maxPerInterval: -1 }), RangeError);
  assert.throws(() => new Limiter({ concurrency: 1.5, maxPerInterval: 1 }), RangeError);
});

test('mapLimit keeps order and limits parallelism', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n));
    active--;
    return `${i}:${n}`;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:3', '3:2', '4:4']);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});
