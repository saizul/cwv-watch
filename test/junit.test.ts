import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATES, escapeXml, junitCases, junitClassName, renderJunit } from '../src/report/junit.js';
import { render } from '../src/output.js';
import type { Gates } from '../src/model.js';
import { config, field, run, target } from './fixtures.js';

const ALL: Gates = { budget: true, regression: true, errors: true };

/** Previous run within budget, current run over the LCP budget, a regression and a PSI error. */
function failing(cfg = config()) {
  const previous = target({ cfg });
  return target({
    cfg,
    field: field({ lcp: 4500, inp: 150, cls: 0.05, fcp: 1500, ttfb: 600 }),
    previous,
    errors: [{ source: 'psi', message: 'Lighthouse returned <NO_FCP> & gave up' }],
  });
}

/**
 * Minimal well-formedness check: every tag is closed in order, attributes are
 * quoted, and no raw "<" or "&" appears outside markup or entities.
 */
function assertWellFormed(xml: string): void {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));
  const body = xml.slice(xml.indexOf('?>') + 2);
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(body); m; m = tag.exec(body)) {
    const text = body.slice(last, m.index);
    assert.doesNotMatch(text, /<|&(?!(amp|lt|gt|quot|apos|#\d+);)/, `bad text before ${m[0]}`);
    last = tag.lastIndex;
    const [, closing, name, , selfClosing] = m;
    if (closing) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else if (!selfClosing) stack.push(name!);
  }
  assert.equal(body.slice(last).trim(), '');
  assert.deepEqual(stack, []);
}

function attr(xml: string, element: string, name: string): string | undefined {
  const m = new RegExp(`<${element}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml);
  return m?.[1];
}

test('escapeXml escapes markup, quotes and whitespace and drops invalid characters', () => {
  assert.equal(escapeXml(`a<b>&"c"'d'`), 'a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;');
  assert.equal(escapeXml('line1\nline2\tx\r'), 'line1&#10;line2&#9;x&#13;');
  assert.equal(escapeXml('bell\u0007 nul\u0000 esc\u001b'), 'bell nul esc');
  assert.equal(escapeXml('lone \uD800 high, pair 😀 ok'), 'lone  high, pair 😀 ok');
});

test('junitClassName is a dotted identifier', () => {
  assert.equal(junitClassName(target({ name: 'Product page (EU)' })), 'cwv-watch.product-page-eu.phone');
  assert.equal(junitClassName(target({ name: '***' })), 'cwv-watch.target.phone');
});

test('a passing run has only passing cases and zero failures', () => {
  const xml = renderJunit(run([target()]));
  assertWellFormed(xml);
  assert.equal(attr(xml, 'testsuites', 'failures'), '0');
  assert.equal(attr(xml, 'testsuites', 'errors'), '0');
  assert.equal(attr(xml, 'testsuites', 'tests'), '3', 'default budgets: lcp, inp, cls');
  assert.equal(attr(xml, 'testsuites', 'time'), '60.000');
  assert.match(xml, /<testsuite name="Home \[PHONE\]" id="0" tests="3"/);
  assert.match(xml, /timestamp="2026-11-12T06:00:00"/);
  assert.match(xml, /<property name="url" value="https:\/\/www.example.com\/"\/>/);
  assert.match(xml, /<property name="overall" value="good"\/>/);
  assert.match(xml, /<testcase name="budget field LCP rating good or better" classname="cwv-watch.home.phone"/);
  assert.doesNotMatch(xml, /<failure|<error|<skipped/);
});

test('default gates: budget failure fails, regression is noted, API error is skipped', () => {
  const r = failing();
  const xml = renderJunit(run([r]));
  assertWellFormed(xml);
  assert.deepEqual(run([r]).summary.gates, DEFAULT_GATES);
  assert.equal(attr(xml, 'testsuites', 'failures'), '1');
  assert.equal(attr(xml, 'testsuites', 'errors'), '0');
  assert.equal(attr(xml, 'testsuites', 'skipped'), '1');
  assert.match(xml, /<failure message="LCP \(field\) 4.5 s vs rating good or better: FAIL" type="BudgetFailure">/);
  assert.match(xml, /<testcase name="regression LCP"[^>]*>\n\s*<system-out>not gated: LCP 2.1 s -&gt; 4.5 s/);
  assert.match(xml, /<skipped message="psi error: Lighthouse returned &lt;NO_FCP&gt; &amp; gave up"\/>/);
});

test('gated regressions and errors become failures and errors', () => {
  const cfg = config({ failOn: { budget: true, regression: true, errors: true } });
  const r = failing(cfg);
  const result = run([r], cfg);
  assert.deepEqual(result.summary.gates, ALL);
  const xml = render(result, 'junit');
  assertWellFormed(xml);
  assert.equal(attr(xml, 'testsuites', 'failures'), '2');
  assert.equal(attr(xml, 'testsuites', 'errors'), '1');
  assert.equal(attr(xml, 'testsuites', 'skipped'), '0');
  assert.match(xml, /<failure message="LCP 2.1 s -&gt; 4.5 s \(\+114.3%\)" type="Regression">/);
  assert.match(xml, /<error message="Lighthouse returned &lt;NO_FCP&gt; &amp; gave up" type="ApiError">/);
});

test('an ungated budget failure is a passing case with a note', () => {
  const cases = junitCases(failing(), { budget: false, regression: false, errors: false });
  const lcp = cases.find((c) => c.name.startsWith('budget field LCP'))!;
  assert.equal(lcp.outcome.kind, 'pass');
  assert.match((lcp.outcome as { note: string }).note, /^not gated: LCP \(field\) 4.5 s/);
});

test('regression cases cover only metrics present in both runs', () => {
  const first = target();
  assert.ok(!junitCases(first).some((c) => c.name.startsWith('regression')), 'no previous run');
  const second = target({ previous: first });
  const names = junitCases(second)
    .filter((c) => c.name.startsWith('regression'))
    .map((c) => c.name);
  assert.deepEqual(names, ['regression LCP', 'regression INP', 'regression CLS', 'regression FCP', 'regression TTFB']);
  const xml = renderJunit(run([second]));
  assert.match(xml, /<testcase name="regression LCP"[^>]*>\n\s*<system-out>2.1 s -&gt; 2.1 s<\/system-out>/);
});

test('budgets without data are skipped', () => {
  const cfg = config({ labBudgets: { performanceScore: 80 } });
  const r = target({ cfg, field: null, lab: null });
  const xml = renderJunit(run([r], cfg));
  assertWellFormed(xml);
  assert.equal(attr(xml, 'testsuites', 'tests'), '4');
  assert.equal(attr(xml, 'testsuites', 'skipped'), '4');
  assert.match(xml, /<skipped message="no field data"\/>/);
  assert.match(xml, /<skipped message="no lab data"\/>/);
  assert.match(xml, /<property name="overall" value="no-data"\/>/);
});

test('one suite per target with origin and score properties', () => {
  const cfg = config({ labBudgets: { performanceScore: 50 } });
  const a = target({ cfg });
  const b = { ...target({ cfg, name: 'Whole site & more' }), url: undefined, origin: 'https://www.example.com' };
  const xml = renderJunit(run([a, b], cfg));
  assertWellFormed(xml);
  assert.equal((xml.match(/<testsuite /g) ?? []).length, 2);
  assert.match(xml, /<testsuite name="Whole site &amp; more \[PHONE\]" id="1"/);
  assert.match(xml, /<property name="origin" value="https:\/\/www.example.com"\/>/);
  assert.match(xml, /<property name="performanceScore" value="\d+"\/>/);
  assert.match(xml, /<testcase name="budget lab Performance score &gt;= 50"/);
  assert.equal(attr(xml, 'testsuites', 'tests'), '8');
});

test('reports without summary.gates fall back to the default gates', () => {
  const cfg = config({ failOn: { budget: true, regression: true, errors: true } });
  const result = run([failing(cfg)], cfg);
  delete result.summary.gates;
  const xml = renderJunit(result);
  assert.equal(attr(xml, 'testsuites', 'failures'), '1');
  assert.equal(attr(xml, 'testsuites', 'errors'), '0');
  assert.equal(attr(renderJunit(result, ALL), 'testsuites', 'failures'), '2');
});

test('an empty run is still a valid document', () => {
  const xml = renderJunit(run([]));
  assertWellFormed(xml);
  assert.match(xml, /<testsuites name="cwv-watch" tests="0" failures="0" errors="0" skipped="0" time="60.000">/);
});
