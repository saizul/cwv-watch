# Contributing

Thanks for helping improve cwv-watch. Bug reports, fixes, new notifiers and documentation corrections are all
welcome.

## Reporting a bug

Open an issue with:

- the command you ran and the full output (the API key is redacted automatically, but check before pasting)
- your Node.js version (`node --version`) and operating system
- your configuration file with private URLs replaced by `example.com` addresses
- for API problems, the relevant part of `cwv-report/cwv-report.json`

## Development setup

You need Node.js 20 or newer.

```console
$ git clone https://github.com/saizul/cwv-watch.git
$ cd cwv-watch
$ npm ci
```

Before every commit:

```console
$ npm run lint
$ npm test
```

Both must pass; CI runs them on Node 20, 22 and 24. `npm run format` applies Prettier.

## Guidelines

- **No runtime dependencies.** Use the Node.js standard library and the global `fetch`. Development tools go in
  `devDependencies`.
- **Tests never touch the network.** Pass a fetch double (see `test/helpers.ts`) and a no-op `sleep`. Fixtures must
  follow the response shapes documented by Google; link the documentation when you add or change one.
- **No real data or secrets.** Use `example.com` URLs in tests, examples and issues. Never commit an API key, webhook
  URL or bot token.
- **Every change comes with a test** that fails without it.
- Keep public types stable; anything exported from `src/index.ts` is part of the API.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user would notice.

## Project layout

```text
src/
  metrics.ts       metric catalogue, thresholds, ratings, formatting
  http.ts          JSON HTTP client: timeout, retry, backoff, redaction
  limiter.ts       concurrency and requests-per-minute limiter
  crux.ts          CrUX record and history API client and parsers
  psi.ts           PageSpeed Insights v5 client and parser
  config.ts        configuration schema, defaults and validation
  evaluate.ts      budgets, regressions, summaries
  trend.ts         least-squares trends over CrUX history
  store.ts         run history file
  runner.ts        orchestrates one run
  report/          Markdown, JSON, HTML and sparkline renderers
  notify/          webhook, Slack and Telegram notifiers
  cli.ts, bin.ts   command-line interface
test/              node:test suite and fixtures
examples/          configuration, workflow, library and offline demo
```

## Adding a notifier

Implement the `Notifier` interface in `src/notify/notifiers.ts`, build it from configuration in
`buildNotifiers` (`src/notify/index.ts`), add the configuration keys to `src/config.ts`, and test the payload with a
fetch double. Credentials must come from environment variables and be added to the redaction list.

## Pull requests

Keep pull requests focused on one change, describe what it does and why, and mention anything you could not test. By
contributing you agree that your work is released under the MIT license of this project.
