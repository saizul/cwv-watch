# cwv-watch

Core Web Vitals monitoring for CI: real-user field data from the Chrome UX Report, weekly trends from the CrUX History
API and Lighthouse lab data from PageSpeed Insights, checked against budgets and compared with the previous run.

[![CI](https://github.com/saizul/cwv-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/cwv-watch/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

Google Search Console tells you weeks later that a group of URLs went from "Good" to "Needs improvement". `cwv-watch`
runs on a schedule, reads the same field data straight from the Chrome UX Report (CrUX) API, and fails the build or
sends a message as soon as a page leaves its budget or gets measurably worse.

```text
$ cwv-watch run
checking 4 target/form-factor combination(s)
Home [PHONE]: field ok, history ok, lab ok
Product page [PHONE]: field ok, history ok, lab ok
...
wrote cwv-report/cwv-report.md, cwv-report/cwv-report.json, cwv-report/cwv-report.html
FAILED: 4 target(s), 2 budget failure(s), 1 regression(s), 0 error(s)
$ echo $?
1
```

## Features

- **Field data** from CrUX `records:queryRecord`: p75 and the good / needs improvement / poor distribution for LCP,
  INP, CLS, FCP and TTFB, per URL or per origin, per form factor (phone, desktop, tablet or all).
- **Trends** from CrUX `records:queryHistoryRecord`: up to 40 weekly collection periods, a least-squares trend over a
  configurable window (improving / stable / worsening), with gaps kept as gaps.
- **Lab data** from the PageSpeed Insights v5 API: Lighthouse performance score, LCP, CLS, FCP, server response time,
  Total Blocking Time and Speed Index, on the mobile or desktop strategy.
- **Budgets** per metric as a number (`"lcp": 3000`) or a rating (`"lcp": "good"`), globally or per target, for field
  data and for lab data (`"performanceScore": 80`).
- **Ratings** with Google's published boundaries (see [Thresholds](#thresholds)).
- **Regression detection** against the previous run, stored as JSON: a p75 that got worse by a relative _and_ an
  absolute threshold, or whose rating dropped.
- **Reports** in Markdown (ready for `GITHUB_STEP_SUMMARY` and PR comments), JSON (everything, for your own tooling)
  and self-contained HTML with inline SVG sparklines (no scripts, no external requests, light and dark mode).
- **CI-friendly exit codes**: non-zero when a budget fails, optionally also on regressions or API errors.
- **Notifiers**: generic JSON webhook, Slack-compatible incoming webhook, Telegram bot. Each one is optional and a
  failing notifier never fails the run.
- **Rate limiting and concurrency control** for each API (CrUX allows 150 queries per minute per Google Cloud
  project), retries with jittered exponential backoff on 429 and 5xx, `Retry-After` support, per-request timeouts.
- **Secrets stay secret**: the API key comes from an environment variable and is redacted from every error, log line
  and report, as are Slack webhook paths and Telegram bot tokens.
- **Zero runtime dependencies**. Uses the global `fetch` of Node 20+, and the fetch implementation is injectable, so the
  whole pipeline is tested against mocked HTTP.

## Install

```bash
npm install --save-dev cwv-watch
# or run it without installing
npx cwv-watch --help
```

Node.js 20 or newer is required.

### Install from GitHub Packages

Releases are also published as `@saizul/cwv-watch` on GitHub Packages:

```bash
echo "@saizul:registry=https://npm.pkg.github.com" >> .npmrc
npm install --save-dev @saizul/cwv-watch
```

GitHub Packages needs a personal access token with `read:packages` in your npm config to install. The command name is
`cwv-watch` either way.

## Getting an API key

1. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project.
2. Enable the **Chrome UX Report API** and the **PageSpeed Insights API** for it.
3. Create an API key under _APIs & Services > Credentials_. Restrict it to those two APIs.
4. Export it as `CWV_API_KEY` (or the variable named in `apiKeyEnv`).

```bash
export CWV_API_KEY=your-key-here
```

The key is sent as the `key` query parameter, as both APIs require. It is never written to reports or the history
file.

## Usage

```bash
cwv-watch init                         # writes a starter cwv-watch.config.json
cwv-watch validate                     # checks the config and exits
cwv-watch run                          # queries the APIs and writes reports
cwv-watch run --stdout md              # also prints the Markdown report
cwv-watch run --no-psi --format json   # field data only, JSON report only
cwv-watch report --input cwv-report/cwv-report.json --format html --out public/
```

| Option                 | Meaning                                                  |
| ---------------------- | -------------------------------------------------------- |
| `-c, --config <path>`  | Configuration file, default `cwv-watch.config.json`      |
| `-o, --out <dir>`      | Report directory, overrides `reports.outDir`             |
| `-f, --format <list>`  | Report formats to write, comma separated: `md,json,html` |
| `--stdout <format>`    | Also print one format to standard output                 |
| `--no-crux`            | Skip the CrUX `queryRecord` call                         |
| `--no-history`         | Skip the CrUX history call (no trends or sparklines)     |
| `--no-psi`             | Skip PageSpeed Insights (no lab data, much faster)       |
| `--no-store`           | Do not read or update the history file                   |
| `--no-notify`          | Do not send notifications                                |
| `--fail-on-regression` | Exit 1 on regressions too, not only on budget failures   |
| `--no-fail`            | Exit 0 whenever the run completes (report only)          |
| `-q, --quiet`          | Only print errors                                        |

### Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Run completed and every enabled gate passed                              |
| 1    | A gate failed: budget failure (and, if enabled, regression or API error) |
| 2    | Usage or configuration error                                             |
| 3    | Runtime error, for example a missing API key                             |

When `GITHUB_STEP_SUMMARY` is set, as it is in GitHub Actions, the Markdown report is appended to the job summary.

## Configuration

`cwv-watch.config.json` is plain JSON. Only `targets` is required; everything else has a default. A complete example is
in [`examples/cwv-watch.config.json`](examples/cwv-watch.config.json).

```json
{
  "targets": [
    { "name": "Home", "url": "https://www.example.com/" },
    { "name": "Product page", "url": "https://www.example.com/products/blue-widget", "budgets": { "lcp": 3000 } },
    { "name": "Whole site", "origin": "https://www.example.com", "skipLab": true }
  ],
  "formFactors": ["PHONE", "DESKTOP"],
  "budgets": { "lcp": "good", "inp": "good", "cls": "good" },
  "labBudgets": { "performanceScore": 70 },
  "notify": { "on": "change", "slack": { "urlEnv": "SLACK_WEBHOOK_URL" } }
}
```

A target can also be a bare string: `"https://www.example.com"` (no path) is an origin and `"https://www.example.com/"`
or anything with a path is a page URL.

| Key                       | Default                                          | Meaning                                                                                                  |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `targets[]`               | required                                         | `name`, and exactly one of `url` or `origin`; optional `formFactors`, `budgets`, `labBudgets`, `skipLab` |
| `formFactors`             | `["PHONE", "DESKTOP"]`                           | Any of `PHONE`, `DESKTOP`, `TABLET`, `ALL_FORM_FACTORS`                                                  |
| `metrics`                 | all five                                         | Subset of `lcp`, `inp`, `cls`, `fcp`, `ttfb`                                                             |
| `sources`                 | all `true`                                       | `crux`, `history`, `psi` switches                                                                        |
| `historyPeriods`          | `25`                                             | CrUX history periods to request (1 to 40, weekly)                                                        |
| `trendPeriods`            | `8`                                              | How many recent periods the trend is computed over                                                       |
| `trendThreshold`          | `0.05`                                           | Relative change over the window that counts as improving or worsening                                    |
| `budgets`                 | `{ lcp, inp, cls: "good" }`                      | Field budgets: number (inclusive maximum) or worst allowed rating                                        |
| `labBudgets`              | `{}`                                             | Lab budgets: `performanceScore` (minimum, 0-100), `tbt`, `lcp`, `cls`, `fcp`, `ttfb` (maximums)          |
| `regression.relative`     | `0.1`                                            | Relative worsening of p75 that counts as a regression                                                    |
| `regression.absolute`     | `lcp 100, inp 20, cls 0.02, fcp 100, ttfb 50`    | Minimum absolute worsening, so small values do not trigger on noise                                      |
| `regression.ratingDrop`   | `true`                                           | A rating drop (for example good to needs improvement) is always a regression                             |
| `failOn`                  | `budget: true, regression: false, errors: false` | Which problems make the exit code 1                                                                      |
| `storage.path`            | `.cwv-watch/history.json`                        | Run history file                                                                                         |
| `storage.keepRuns`        | `30`                                             | Runs to keep in it                                                                                       |
| `reports.outDir`          | `cwv-report`                                     | Report directory                                                                                         |
| `reports.formats`         | `["md", "json", "html"]`                         | Formats to write                                                                                         |
| `concurrency`             | `4`                                              | Requests in flight per API                                                                               |
| `rateLimit.cruxPerMinute` | `120`                                            | Requests started per minute against CrUX (its quota is 150); `0` disables the cap                        |
| `rateLimit.psiPerMinute`  | `60`                                             | Same for PageSpeed Insights                                                                              |
| `http.timeoutMs`          | `90000`                                          | Per-attempt timeout; a PSI run can take close to a minute                                                |
| `http.retries`            | `2`                                              | Retries after the first attempt on 429, 5xx, network errors and timeouts                                 |
| `apiKeyEnv`               | `CWV_API_KEY`                                    | Environment variable holding the key (`CRUX_API_KEY` and `GOOGLE_API_KEY` are fallbacks)                 |
| `notify`                  | `{ "on": "failure" }`                            | See [Notifications](#notifications)                                                                      |

Validation reports every problem at once, with its path (`targets[2].url: must be an absolute http(s) URL`), and
unknown keys are errors so that typos do not silently disable a budget.

### Thresholds

Ratings use the boundaries published for Core Web Vitals and used by PageSpeed Insights. Each bound is inclusive.

| Metric | Good       | Needs improvement | Poor      | CrUX metric name                  |
| ------ | ---------- | ----------------- | --------- | --------------------------------- |
| LCP    | <= 2500 ms | <= 4000 ms        | > 4000 ms | `largest_contentful_paint`        |
| INP    | <= 200 ms  | <= 500 ms         | > 500 ms  | `interaction_to_next_paint`       |
| CLS    | <= 0.1     | <= 0.25           | > 0.25    | `cumulative_layout_shift`         |
| FCP    | <= 1800 ms | <= 3000 ms        | > 3000 ms | `first_contentful_paint`          |
| TTFB   | <= 800 ms  | <= 1800 ms        | > 1800 ms | `experimental_time_to_first_byte` |

The overall rating of a target is the worst rating among LCP, INP and CLS, which is how Google assesses a page or
origin.

### How regressions are detected

The previous run is the last entry in the history file whose target key (`name|formFactor`) matches. For each metric
with field data in both runs:

- **threshold**: `current - previous >= regression.absolute[metric]` **and** `(current - previous) / previous >=
regression.relative`;
- **rating drop**: the rating got worse (only when `regression.ratingDrop` is on).

CrUX p75 values are 28-day rolling aggregates that update daily, so comparing two runs a day apart shows a small slice
of change. Weekly schedules give clearer signals; the trend column looks further back using the history API.

### How trends are computed

For each metric, cwv-watch takes the last `trendPeriods` weekly p75 values from the CrUX History API, fits a
least-squares line through the points that have data (at least three), and compares the fitted start and end of the
window. Lower is better for every metric, so a rise above `trendThreshold` is _worsening_. Fitting a line instead of
comparing the first and last week keeps one noisy week from flipping the result.

## Notifications

```json
{
  "notify": {
    "on": "change",
    "reportUrl": "https://ci.example.com/cwv/latest.html",
    "webhook": { "urlEnv": "CWV_WEBHOOK_URL", "headers": { "authorization": "Bearer ..." } },
    "slack": { "urlEnv": "SLACK_WEBHOOK_URL" },
    "telegram": { "botTokenEnv": "TELEGRAM_BOT_TOKEN", "chatIdEnv": "TELEGRAM_CHAT_ID" }
  }
}
```

| `notify.on` | Sends when                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------- |
| `failure`   | the run failed a gate (default)                                                              |
| `change`    | the set of budget failures and regressions differs from the previous run, including recovery |
| `always`    | every run                                                                                    |
| `never`     | never                                                                                        |

- **webhook** POSTs JSON: `event`, `passed`, `headline`, `text`, `summary`, `results[]` (per target: metrics, budget
  failures, regressions, errors) and `reportUrl`.
- **slack** POSTs `{ text, blocks }` to an incoming webhook. Services with Slack-compatible webhooks (Mattermost, Rocket.Chat) show the `text` field.
- **telegram** calls the Bot API `sendMessage` with `chat_id` and a plain text message.

Prefer `urlEnv` over `url` for webhook URLs that act as credentials. Telegram tokens can only come from the
environment.

## Running on a schedule with GitHub Actions

[`examples/github-actions-scheduled.yml`](examples/github-actions-scheduled.yml) runs weekly, restores the previous run
from the Actions cache, writes the Markdown report to the job summary and uploads the HTML report as an artifact:

```yaml
on:
  schedule:
    - cron: '30 6 * * 1'
  workflow_dispatch:

jobs:
  cwv:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/cache/restore@v4
        with:
          path: .cwv-watch
          key: cwv-history-${{ github.run_id }}
          restore-keys: cwv-history-
      - run: npx --yes cwv-watch@0.1.0 run
        env:
          CWV_API_KEY: ${{ secrets.CWV_API_KEY }}
      - if: always()
        uses: actions/cache/save@v4
        with:
          path: .cwv-watch
          key: cwv-history-${{ github.run_id }}
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: cwv-report
          path: cwv-report/
```

Actions caches expire after seven days without access, so a weekly schedule keeps the history alive. If you need a
permanent record, commit `.cwv-watch/history.json` to a branch instead.

## Reports

All three formats come from the same run data.

- **Markdown**: overview table, then per target and form factor the field p75, rating, share of good experiences,
  change since the last run, trend, a text sparkline of the weekly p75 and the lab value, followed by budget failures,
  regressions and errors.
- **HTML**: the same content with distribution bars and inline SVG sparklines. Dashed lines in a sparkline mark the
  good and poor boundaries when they fall inside the plotted range. One file, no JavaScript, works offline.
- **JSON**: the complete `RunResult`, including normalised CrUX and PSI data, for dashboards or your own checks.

A sample built from canned responses is in [`examples/sample-report/`](examples/sample-report/). Recreate it with
`npm run build && node examples/offline-demo.mjs`, which needs no API key and no network.

## Library use

Everything the CLI does is exported:

```js
import { CruxClient, HttpClient, Limiter, PsiClient, rate } from 'cwv-watch';

const apiKey = process.env.CWV_API_KEY;
const http = new HttpClient({ secrets: [apiKey], retries: 2 });
const limiter = new Limiter({ concurrency: 2, maxPerInterval: 120 });
const crux = new CruxClient({ http, apiKey, limiter });

const field = await crux.queryRecord({ origin: 'https://www.example.com', formFactor: 'PHONE' });
if (field) console.log(field.metrics.lcp?.p75, rate('lcp', field.metrics.lcp.p75));

const history = await crux.queryHistoryRecord({ url: 'https://www.example.com/', formFactor: 'DESKTOP' }, 12);
const lab = await new PsiClient({ http, apiKey }).run('https://www.example.com/', 'mobile');
```

`queryRecord` and `queryHistoryRecord` return `null` when CrUX has no data for the URL or origin (HTTP 404). CLS values,
which the API sends as strings, are converted to numbers; missing history periods (`"NaN"` densities, `null` p75s)
become `null`.

Pass `fetch` to `HttpClient` (or `runWatch`) to route requests through a proxy, add logging or mock them in tests. See
[`examples/library.mjs`](examples/library.mjs).

## API notes

| API                   | Request                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CrUX record           | `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY` with `{ url \| origin, formFactor, metrics }`                             |
| CrUX history          | `POST https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=KEY` with the same body plus `collectionPeriodCount` (1-40, default 25) |
| PageSpeed Insights v5 | `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=URL&strategy=mobile\|desktop&category=performance&key=KEY`                        |

- CrUX data is a 28-day rolling window, updated daily around 04:00 UTC; the history API returns weekly periods.
- CrUX only has data for URLs and origins with enough Chrome traffic. Low-traffic pages return 404; target the origin
  instead, which aggregates every page.
- `formFactor` is omitted from the request for `ALL_FORM_FACTORS`, which returns data across all devices.
- PSI has no tablet strategy, so lab data is collected for `PHONE` (mobile) and `DESKTOP` targets only, and an origin
  target is tested on its home page.

## Testing

```bash
npm ci
npm test        # build, then run the node:test suite
npm run lint    # type check, Prettier check, style checks
```

The tests never touch the network: every HTTP call goes through an injected fetch double that serves fixtures shaped
like the documented API responses. CI runs lint and the test suite on Node 20, 22 and 24.

## Limitations

- **Field data needs traffic.** CrUX covers pages and origins with enough eligible Chrome users; small sites may only
  have origin-level data, or none.
- **Response fixtures, not live calls.** The request and response shapes follow Google's documentation for the CrUX
  API, the CrUX History API and the PSI v5 API, and the test suite checks against fixtures in those shapes. The PSI
  `loadingExperience` metric keys (`LARGEST_CONTENTFUL_PAINT_MS`, `CUMULATIVE_LAYOUT_SHIFT_SCORE` scaled by 100, and so
  on) and the Lighthouse audit ids are not listed in the PSI reference; they follow the responses the API returns.
- **Lab data is one Lighthouse run** on Google's servers, so the score and lab metrics vary between runs. Use lab
  budgets with some headroom, or rely on field budgets for gating.
- **No INP in the lab.** Lighthouse has no interaction in a page load, so INP is field-only. Total Blocking Time is the
  closest lab proxy and can be budgeted as `labBudgets.tbt`.
- **One history file per config.** Runs are matched by target name and form factor; renaming a target starts its
  history from scratch.
- **Quotas are per Google Cloud project.** Several jobs sharing one key share the 150 queries per minute CrUX quota;
  lower `rateLimit.cruxPerMinute` accordingly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Saizul Amin
