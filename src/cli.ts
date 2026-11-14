import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig, resolveApiKey, type Config } from './config.js';
import { ConfigError } from './errors.js';
import { exitCodeFor } from './evaluate.js';
import type { FetchLike } from './http.js';
import type { RunResult } from './model.js';
import { buildNotifiers, notifyAll, shouldNotify } from './notify/index.js';
import { REPORT_FILES, render, writeReports, type ReportFormat } from './output.js';
import { redact } from './redact.js';
import { runWatch } from './runner.js';
import { appendRun, latestRun, loadStore, saveStore } from './store.js';
import { VERSION } from './version.js';
import type { Sleep } from './limiter.js';

export const EXIT = { ok: 0, failed: 1, usage: 2, error: 3 } as const;

export const HELP = `cwv-watch ${VERSION}: Core Web Vitals monitor (CrUX field data + PageSpeed Insights lab data)

Usage:
  cwv-watch run [options]          Query the APIs, compare with the last run, write reports
  cwv-watch validate [options]     Check the configuration file and exit
  cwv-watch init [--config path]   Write a starter configuration file
  cwv-watch report --input <file>  Re-render a JSON report as Markdown, HTML or JUnit XML

Options:
  -c, --config <path>     Configuration file (default: cwv-watch.config.json)
  -o, --out <dir>         Report directory (overrides reports.outDir)
  -f, --format <list>     Comma-separated report formats: md,json,html,junit
      --stdout <format>   Also print one report format to standard output
      --no-crux           Skip the CrUX queryRecord call
      --no-history        Skip the CrUX history call (no trends)
      --no-psi            Skip PageSpeed Insights (no lab data)
      --no-store          Do not read or update the run history file
      --no-notify         Do not send notifications
      --fail-on-regression  Exit non-zero on regressions as well as budget failures
      --no-fail           Always exit 0 when the run completes (report only)
  -q, --quiet             Only print errors
  -h, --help              Show this help
  -v, --version           Show the version

Environment:
  CWV_API_KEY             Google API key with the Chrome UX Report API and the
                          PageSpeed Insights API enabled (name configurable via apiKeyEnv)
  GITHUB_STEP_SUMMARY     When set (GitHub Actions), the Markdown report is appended to it

Exit codes: 0 passed, 1 budget (or regression) gate failed, 2 usage or configuration error, 3 runtime error.
`;

export const STARTER_CONFIG = {
  targets: [
    { name: 'Home', url: 'https://www.example.com/' },
    { name: 'Whole site', origin: 'https://www.example.com' },
  ],
  formFactors: ['PHONE', 'DESKTOP'],
  budgets: { lcp: 'good', inp: 'good', cls: 'good' },
  labBudgets: { performanceScore: 70 },
  storage: { path: '.cwv-watch/history.json', keepRuns: 30 },
  reports: { outDir: 'cwv-report', formats: ['md', 'json', 'html'] },
  notify: { on: 'failure' },
};

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
  cwd?: string;
}

const defaultIo = (): CliIo => ({
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
});

function parseFormats(value: string | undefined): ReportFormat[] | undefined {
  if (value === undefined) return undefined;
  const list = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((f) => !(f in REPORT_FILES));
  if (bad.length > 0 || list.length === 0)
    throw new ConfigError(`Unknown report format(s): ${bad.join(', ') || value}`);
  return [...new Set(list)] as ReportFormat[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function main(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        out: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f' },
        stdout: { type: 'string' },
        input: { type: 'string', short: 'i' },
        'no-crux': { type: 'boolean' },
        'no-history': { type: 'boolean' },
        'no-psi': { type: 'boolean' },
        'no-store': { type: 'boolean' },
        'no-notify': { type: 'boolean' },
        'no-fail': { type: 'boolean' },
        'fail-on-regression': { type: 'boolean' },
        force: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const command = positionals[0] ?? (opts.help ? 'help' : 'run');
  if (opts.help || command === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const log = (m: string) => {
    if (!opts.quiet) io.stderr(`${m}\n`);
  };
  const configPath = opts.config ?? 'cwv-watch.config.json';

  try {
    switch (command) {
      case 'init': {
        if ((await exists(configPath)) && !opts.force) {
          io.stderr(`${configPath} already exists (use --force to overwrite)\n`);
          return EXIT.usage;
        }
        await writeFile(configPath, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, 'utf8');
        io.stdout(`Wrote ${configPath}. Edit the targets, then run: cwv-watch run\n`);
        return EXIT.ok;
      }
      case 'validate': {
        const config = await loadConfig(configPath);
        const key = resolveApiKey(config, io.env);
        io.stdout(
          `Configuration OK: ${config.targets.length} target(s), form factors ${config.formFactors.join(', ')}, ` +
            `metrics ${config.metrics.join(', ')}.\n`,
        );
        if (!key) io.stdout(`Note: ${config.apiKeyEnv} is not set; "run" needs it for the CrUX API.\n`);
        return EXIT.ok;
      }
      case 'report': {
        if (!opts.input) {
          io.stderr('report needs --input <cwv-report.json>\n');
          return EXIT.usage;
        }
        const run = JSON.parse(await readFile(opts.input, 'utf8')) as RunResult;
        if (run.tool !== 'cwv-watch' || !Array.isArray(run.results)) {
          throw new ConfigError(`${opts.input} is not a cwv-watch JSON report`);
        }
        const formats = parseFormats(opts.format) ?? ['md', 'html'];
        if (opts.stdout) {
          io.stdout(render(run, parseFormats(opts.stdout)![0]!));
        }
        if (opts.out || !opts.stdout) {
          const written = await writeReports(run, opts.out ?? '.', formats);
          log(`wrote ${written.join(', ')}`);
        }
        return EXIT.ok;
      }
      case 'run':
        return await runCommand(configPath, opts, io, log);
      default:
        io.stderr(`Unknown command "${command}"\n\n${HELP}`);
        return EXIT.usage;
    }
  } catch (err) {
    const message = redact((err as Error).message, [resolveApiKey({ apiKeyEnv: 'CWV_API_KEY' }, io.env)]);
    io.stderr(`cwv-watch: ${message}\n`);
    return err instanceof ConfigError ? EXIT.usage : EXIT.error;
  }
}

type Opts = Record<string, string | boolean | undefined>;

async function runCommand(configPath: string, opts: Opts, io: CliIo, log: (m: string) => void): Promise<number> {
  const config: Config = await loadConfig(configPath);
  if (opts['no-crux']) config.sources.crux = false;
  if (opts['no-history']) config.sources.history = false;
  if (opts['no-psi']) config.sources.psi = false;
  if (opts['fail-on-regression']) config.failOn.regression = true;
  const formats = parseFormats(opts.format as string | undefined) ?? config.reports.formats;
  const stdoutFormat = parseFormats(opts.stdout as string | undefined)?.[0];
  const apiKey = resolveApiKey(config, io.env);

  const store = opts['no-store'] ? null : await loadStore(config.storage.path);
  const previous = store ? latestRun(store) : undefined;

  const run = await runWatch({ config, apiKey, previous, fetch: io.fetch, sleep: io.sleep, now: io.now, log });

  const outDir = (opts.out as string | undefined) ?? config.reports.outDir;
  const written = await writeReports(run, outDir, formats);
  log(`wrote ${written.join(', ')}`);
  if (stdoutFormat) io.stdout(render(run, stdoutFormat));

  const summaryFile = io.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) await appendFile(summaryFile, render(run, 'md'), 'utf8');

  if (store) {
    await saveStore(config.storage.path, appendRun(store, run, config.storage.keepRuns));
    log(`updated ${config.storage.path}`);
  }

  if (!opts['no-notify'] && shouldNotify(config.notify.on, run, previous)) {
    const built = buildNotifiers(config.notify, { fetch: io.fetch, env: io.env });
    for (const p of built.problems) io.stderr(`notify: ${p}\n`);
    if (built.notifiers.length > 0) {
      const outcome = await notifyAll(built.notifiers, run, built.secrets);
      if (outcome.sent.length > 0) log(`notified: ${outcome.sent.join(', ')}`);
      for (const f of outcome.failed) io.stderr(`notify ${f.name} failed: ${f.error}\n`);
    }
  }

  const s = run.summary;
  log(
    `${s.passed ? 'PASSED' : 'FAILED'}: ${s.targets} target(s), ${s.budgetFailures} budget failure(s), ` +
      `${s.regressions} regression(s), ${s.errors} error(s)`,
  );
  if (opts['no-fail']) return EXIT.ok;
  return exitCodeFor(run);
}
