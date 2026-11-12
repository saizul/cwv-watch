import type { HttpClient } from '../http.js';
import type { RunResult } from '../model.js';
import { headline, plainMessage, type MessageOptions } from './message.js';

export interface Notifier {
  readonly name: string;
  send(run: RunResult): Promise<void>;
}

/** POSTs a JSON summary (headline, text, summary counts and per-target results) to any URL. */
export class WebhookNotifier implements Notifier {
  readonly name = 'webhook';

  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly options: MessageOptions = {},
  ) {}

  payload(run: RunResult): Record<string, unknown> {
    return {
      event: 'cwv-watch.run',
      passed: run.summary.passed,
      headline: headline(run),
      text: plainMessage(run, this.options),
      summary: run.summary,
      finishedAt: run.finishedAt,
      reportUrl: this.options.reportUrl ?? null,
      results: run.results.map((r) => ({
        key: r.key,
        name: r.name,
        url: r.url ?? null,
        origin: r.origin ?? null,
        formFactor: r.formFactor,
        overall: r.overall,
        metrics: Object.fromEntries(
          r.metrics.map((m) => [m.metric, { p75: m.fieldP75, rating: m.fieldRating, lab: m.labValue }]),
        ),
        budgetFailures: r.budgets.filter((b) => !b.passed),
        regressions: r.regressions,
        errors: r.errors,
      })),
    };
  }

  async send(run: RunResult): Promise<void> {
    await this.http.json(this.url, { method: 'POST', body: this.payload(run), headers: this.headers });
  }
}

/** Slack incoming webhook format ({ text, blocks }); Slack-compatible services fall back to `text`. */
export class SlackNotifier implements Notifier {
  readonly name = 'slack';

  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
    private readonly options: MessageOptions = {},
  ) {}

  payload(run: RunResult): Record<string, unknown> {
    const body = plainMessage(run, this.options).split('\n').slice(2).join('\n');
    const blocks: unknown[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: run.summary.passed ? 'Core Web Vitals passed' : 'Core Web Vitals failed' },
      },
      { type: 'section', text: { type: 'mrkdwn', text: headline(run) } },
    ];
    if (body.trim())
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + body.slice(0, 2900) + '```' } });
    return { text: headline(run), blocks };
  }

  async send(run: RunResult): Promise<void> {
    await this.http.json(this.url, { method: 'POST', body: this.payload(run) }).catch((err: unknown) => {
      // Slack answers a plain "ok" body, which is not JSON; treat that as success.
      if (err instanceof Error && /Invalid JSON response/.test(err.message)) return;
      throw err;
    });
  }
}

/** Telegram Bot API sendMessage. The token stays in the URL path, which is redacted from errors. */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';

  constructor(
    private readonly http: HttpClient,
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly options: MessageOptions = {},
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  payload(run: RunResult): Record<string, unknown> {
    // Telegram caps messages at 4096 characters.
    return {
      chat_id: this.chatId,
      text: plainMessage(run, this.options).slice(0, 4000),
      disable_web_page_preview: true,
    };
  }

  async send(run: RunResult): Promise<void> {
    const url = `${this.apiBase}/bot${this.botToken}/sendMessage`;
    const res = await this.http.json<{ ok?: boolean; description?: string }>(url, {
      method: 'POST',
      body: this.payload(run),
    });
    if (res.ok === false) throw new Error(`Telegram rejected the message: ${res.description ?? 'unknown error'}`);
  }
}
