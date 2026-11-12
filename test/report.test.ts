import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { svgSparkline, textSparkline } from '../src/report/sparkline.js';
import { escapeHtml, escapeMd } from '../src/report/escape.js';
import { writeReports } from '../src/output.js';
import { field, run, target } from './fixtures.js';

const failing = () => {
  const previous = target();
  return target({
    field: field({ lcp: 4500, inp: 150, cls: 0.05 }),
    previous,
    errors: [{ source: 'psi', message: 'Lighthouse failed' }],
  });
};

test('textSparkline scales to block characters and keeps gaps', () => {
  assert.equal(textSparkline([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(textSparkline([1, null, 8]), '▁ █');
  assert.equal(textSparkline([5, 5]), '▄▄');
  assert.equal(textSparkline([null, null]), '');
});

test('svgSparkline draws a polyline and a last-point marker', () => {
  const svg = svgSparkline([1, 2, 3], { width: 100, height: 20, title: 'LCP <trend>' });
  assert.match(svg, /^<svg class="spark"/);
  assert.match(svg, /<polyline class="spark-line"/);
  assert.match(svg, /<circle class="spark-last"/);
  assert.match(svg, /<title>LCP &lt;trend&gt;<\/title>/);
  assert.ok(svg.endsWith('</svg>'));
});

test('svgSparkline splits on gaps and marks isolated points', () => {
  const svg = svgSparkline([1, 2, null, 4, null, 6, 7]);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2);
  assert.equal((svg.match(/class="spark-dot"/g) ?? []).length, 1);
});

test('svgSparkline handles empty and flat series', () => {
  assert.match(svgSparkline([null]), /no data/);
  assert.doesNotMatch(svgSparkline([3, 3, 3]), /NaN/);
  assert.doesNotMatch(svgSparkline([0, 0]), /NaN/);
  assert.doesNotMatch(svgSparkline([7]), /NaN/);
});

test('svgSparkline draws reference lines only inside the range', () => {
  const svg = svgSparkline([2000, 3000], {
    references: [
      { value: 2500, className: 'spark-good' },
      { value: 4000, className: 'spark-poor' },
    ],
  });
  assert.match(svg, /class="spark-good"/);
  assert.doesNotMatch(svg, /class="spark-poor"/);
});

test('escaping helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
  assert.equal(escapeMd('a|b\nc'), 'a\\|b c');
});

test('markdown report: passing run', () => {
  const md = renderMarkdown(run([target()]));
  assert.match(md, /^# Core Web Vitals report/);
  assert.match(md, /✅ \*\*Passed\*\*/);
  assert.match(md, /\| Home \| PHONE \| 🟢 Good \| 2.1 s \| 150 ms \| 0.05 \| 91 \|/);
  assert.match(md, /CrUX collection period: 2026-10-12 to 2026-11-08/);
  assert.match(md, /worsening/);
  assert.doesNotMatch(md, /Budget failures\*\*/);
});

test('markdown report: failures, regressions and errors', () => {
  const md = renderMarkdown(run([failing()], undefined, '2026-11-11T06:00:00.000Z'));
  assert.match(md, /❌ \*\*Failed\*\*/);
  assert.match(md, /\*\*Budget failures\*\*/);
  assert.match(md, /LCP \(field\) 4.5 s vs rating good or better: FAIL/);
  assert.match(md, /\*\*Regressions since the previous run\*\*/);
  assert.match(md, /LCP 2.1 s -> 4.5 s/);
  assert.match(md, /psi: Lighthouse failed/);
  assert.match(md, /Compared with the run of 2026-11-11/);
});

test('markdown escapes target names', () => {
  const md = renderMarkdown(run([target({ name: 'A | B' })]));
  assert.match(md, /A \\\| B/);
});

test('markdown notes missing field data', () => {
  assert.match(renderMarkdown(run([target({ field: null, history: null })])), /No CrUX field data/);
});

test('html report is self-contained and escaped', () => {
  const html = renderHtml(run([failing(), target({ name: '<script>alert(1)</script>' })]));
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<svg class="spark"/);
  assert.match(html, /status fail/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<link rel="stylesheet"|src="http/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /Budget: LCP \(field\)/);
  assert.match(html, /class="dist"/);
});

test('json report round-trips', () => {
  const r = run([target()]);
  assert.deepEqual(JSON.parse(renderJson(r)), JSON.parse(JSON.stringify(r)));
});

test('writeReports writes the selected formats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cwv-report-'));
  const written = await writeReports(run([target()]), join(dir, 'out'), ['md', 'html']);
  assert.equal(written.length, 2);
  assert.deepEqual((await readdir(join(dir, 'out'))).sort(), ['cwv-report.html', 'cwv-report.md']);
});
