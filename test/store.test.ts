import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRun,
  compactRun,
  emptyStore,
  indexResults,
  latestRun,
  loadStore,
  saveStore,
  validateStore,
} from '../src/store.js';
import { run, target } from './fixtures.js';

test('missing history file is an empty store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-store-'));
  assert.deepEqual(await loadStore(join(dir, 'nope.json')), emptyStore());
});

test('save and load round trip, creating directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-store-'));
  const path = join(dir, 'nested', 'history.json');
  const store = appendRun(emptyStore(), run([target()]), 10);
  await saveStore(path, store);
  const loaded = await loadStore(path);
  assert.equal(loaded.runs.length, 1);
  assert.equal(latestRun(loaded)?.results[0]?.key, 'Home|PHONE');
  assert.ok((await readFile(path, 'utf8')).endsWith('\n'));
});

test('appendRun keeps only the newest runs', () => {
  let store = emptyStore();
  for (let i = 0; i < 5; i++) {
    const r = run([target()]);
    r.finishedAt = `2026-11-0${i + 1}T00:00:00.000Z`;
    store = appendRun(store, r, 3);
  }
  assert.equal(store.runs.length, 3);
  assert.equal(store.runs[0]!.finishedAt, '2026-11-03T00:00:00.000Z');
});

test('compactRun drops history time series but keeps p75s', () => {
  const c = compactRun(run([target()]));
  const r = c.results[0]!;
  assert.equal(r.history, null);
  assert.equal(r.field?.metrics.lcp?.p75, 2100);
  assert.deepEqual(r.metrics[0]!.trend?.values, []);
});

test('corrupt or foreign files are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-store-'));
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{oops');
  await assert.rejects(loadStore(bad), /not valid JSON/);
  assert.throws(() => validateStore({ hello: 1 }), /unexpected shape/);
  assert.throws(() => validateStore({ storeVersion: 99, runs: [] }), /newer/);
});

test('indexResults maps by key', () => {
  const m = indexResults(run([target(), target({ name: 'Blog' })]));
  assert.deepEqual([...m.keys()], ['Home|PHONE', 'Blog|PHONE']);
  assert.equal(indexResults(undefined).size, 0);
});
