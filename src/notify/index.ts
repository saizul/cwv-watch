import type { NotifyConfig, NotifyOn } from '../config.js';
import { HttpClient, type FetchLike } from '../http.js';
import type { RunResult } from '../model.js';
import { redact } from '../redact.js';
import { SlackNotifier, TelegramNotifier, WebhookNotifier, type Notifier } from './notifiers.js';

export { SlackNotifier, TelegramNotifier, WebhookNotifier, type Notifier } from './notifiers.js';
export { headline, plainMessage, detailLines } from './message.js';

/** Signature of a run's problems, used by notify.on = "change". */
export function problemSignature(run: RunResult | undefined): string {
  if (!run) return '';
  const items: string[] = [];
  for (const r of run.results) {
    for (const b of r.budgets) if (!b.passed) items.push(`${r.key}:budget:${b.source}:${b.metric}`);
    for (const x of r.regressions) items.push(`${r.key}:regression:${x.metric}`);
  }
  return items.sort().join(',');
}

export function shouldNotify(on: NotifyOn, run: RunResult, previous: RunResult | undefined): boolean {
  switch (on) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'failure':
      return !run.summary.passed;
    case 'change':
      // Notify when the set of problems differs from last time, including recovery.
      return problemSignature(run) !== problemSignature(previous) || (previous === undefined && !run.summary.passed);
  }
}

export interface BuildNotifiersOptions {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltNotifiers {
  notifiers: Notifier[];
  /** Notifiers that are configured but could not be built (missing env var). */
  problems: string[];
  secrets: string[];
}

export function buildNotifiers(config: NotifyConfig, options: BuildNotifiersOptions = {}): BuiltNotifiers {
  const env = options.env ?? process.env;
  const notifiers: Notifier[] = [];
  const problems: string[] = [];
  const secrets: string[] = [];
  const msg = config.reportUrl ? { reportUrl: config.reportUrl } : {};
  const resolveUrl = (name: string, c: { url?: string; urlEnv?: string }): string | undefined => {
    const url = c.url ?? (c.urlEnv ? env[c.urlEnv] : undefined);
    if (!url) problems.push(`${name}: environment variable ${c.urlEnv} is not set`);
    else if (c.urlEnv) secrets.push(url);
    return url;
  };
  const http = () => new HttpClient({ fetch: options.fetch, timeoutMs: 15_000, retries: 1, secrets });

  if (config.webhook) {
    const url = resolveUrl('webhook', config.webhook);
    if (url) notifiers.push(new WebhookNotifier(http(), url, config.webhook.headers, msg));
  }
  if (config.slack) {
    const url = resolveUrl('slack', config.slack);
    if (url) notifiers.push(new SlackNotifier(http(), url, msg));
  }
  if (config.telegram) {
    const token = env[config.telegram.botTokenEnv];
    const chatId = config.telegram.chatId ?? (config.telegram.chatIdEnv ? env[config.telegram.chatIdEnv] : undefined);
    if (!token) problems.push(`telegram: environment variable ${config.telegram.botTokenEnv} is not set`);
    else if (!chatId) problems.push(`telegram: chat id is not set (${config.telegram.chatIdEnv ?? 'chatId'})`);
    else {
      secrets.push(token);
      notifiers.push(new TelegramNotifier(http(), token, chatId, msg));
    }
  }
  return { notifiers, problems, secrets };
}

export interface NotifyOutcome {
  sent: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Send to every notifier; one failing channel never stops the others or the run. */
export async function notifyAll(notifiers: Notifier[], run: RunResult, secrets: string[] = []): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { sent: [], failed: [] };
  await Promise.all(
    notifiers.map(async (n) => {
      try {
        await n.send(run);
        outcome.sent.push(n.name);
      } catch (err) {
        outcome.failed.push({ name: n.name, error: redact((err as Error).message, secrets) });
      }
    }),
  );
  return outcome;
}
