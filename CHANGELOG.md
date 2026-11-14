# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- JUnit XML report format (`junit`, written as `cwv-report.junit.xml`) for the test report views of CI systems: one
  test suite per target and form factor, one test case per budget, per metric compared with the previous run and per
  API error. Failures follow the `failOn` gates, so the test report agrees with the exit code; ungated problems are
  kept as notes or skipped cases. Available in `reports.formats`, `--format`, `--stdout` and `cwv-watch report`.
- `summary.gates` in the JSON report and run history: the `failOn` settings the run was judged with, used when a
  JSON report is re-rendered as JUnit XML.
- Sample JUnit XML report in `examples/sample-report/`.

## [0.1.0] - 2026-11-12

Initial release.

### Added

- CrUX API client for `records:queryRecord` and `records:queryHistoryRecord`, with URL and origin queries, form
  factors, metric selection, `collectionPeriodCount`, string CLS values, `"NaN"` / `null` gaps and 404 as "no data".
- PageSpeed Insights v5 client: performance score, LCP, CLS, FCP, server response time, TBT, Speed Index and Time to
  Interactive from Lighthouse, embedded CrUX percentiles from `loadingExperience`, Lighthouse runtime errors.
- Metric catalogue for LCP, INP, CLS, FCP and TTFB with the published good / needs improvement / poor boundaries.
- Field and lab budgets, as numeric limits or worst allowed rating, global and per target.
- Regression detection against the previous run with relative and absolute thresholds and rating drops.
- Least-squares p75 trends over a configurable window of CrUX history periods.
- JSON run history with atomic writes and a retention limit.
- Markdown, JSON and self-contained HTML reports with inline SVG sparklines and distribution bars.
- Notifiers: generic JSON webhook, Slack-compatible webhook and Telegram bot, with `failure`, `change`, `always` and
  `never` modes.
- HTTP layer with injectable `fetch`, per-attempt timeout, jittered exponential backoff, `Retry-After` support and
  secret redaction.
- Per-API concurrency and requests-per-minute limiter.
- `cwv-watch` CLI with `run`, `validate`, `init` and `report`, CI exit codes and GitHub Actions job summary output.
- Scheduled GitHub Actions example, offline demo and sample report.
- Test suite of 169 tests on `node:test` against mocked HTTP.

[Unreleased]: https://github.com/saizul/cwv-watch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/cwv-watch/releases/tag/v0.1.0
