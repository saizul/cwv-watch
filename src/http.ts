import { ApiError, NetworkError, TimeoutError } from './errors.js';
import { realSleep, type Sleep } from './limiter.js';
import { redact } from './redact.js';
import { USER_AGENT } from './version.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  /** Per-attempt timeout in milliseconds. PSI runs Lighthouse and can take a minute. */
  timeoutMs?: number;
  /** Extra attempts after the first one, for 429, 5xx and network errors. */
  retries?: number;
  /** Base delay for exponential backoff. */
  retryBaseMs?: number;
  /** Upper bound for a single backoff delay, including Retry-After. */
  retryMaxMs?: number;
  sleep?: Sleep;
  /** Random source in [0, 1) for jitter; injectable for deterministic tests. */
  random?: () => number;
  /** Secrets to strip from error messages. */
  secrets?: string[];
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/** Minimal JSON HTTP client with timeout, retry with jittered backoff and Retry-After support. */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly secrets: string[];
  private readonly onRetry: HttpOptions['onRetry'];

  constructor(options: HttpOptions = {}) {
    const globalFetch = typeof fetch === 'function' ? (fetch as FetchLike) : undefined;
    const impl = options.fetch ?? globalFetch;
    if (!impl) throw new Error('No fetch implementation available; pass one in options.fetch');
    this.fetchImpl = impl;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.retries = options.retries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.secrets = options.secrets ?? [];
    this.onRetry = options.onRetry;
  }

  async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.once(url, { method, headers, body });
        const text = await response.text();
        if (response.ok) return parseJson<T>(text, this.safe(url));
        const err = toApiError(response.status, text, this.safe(url), this.secrets);
        if (!err.isRetryable || attempt >= this.retries) throw err;
        const delayMs = this.delayFor(attempt, response.headers.get('retry-after'));
        this.onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${response.status}` });
        await this.sleep(delayMs);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const retryable = err instanceof NetworkError || err instanceof TimeoutError;
        if (!retryable || attempt >= this.retries) throw err;
        const delayMs = this.delayFor(attempt, null);
        this.onRetry?.({ attempt: attempt + 1, delayMs, reason: (err as Error).message });
        await this.sleep(delayMs);
      }
    }
  }

  private async once(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TimeoutError(`Request timed out after ${this.timeoutMs} ms: ${this.safe(url)}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`Request failed: ${this.safe(url)}: ${redact(message, this.secrets)}`, {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exponential backoff with full jitter; Retry-After wins when present. */
  delayFor(attempt: number, retryAfter: string | null): number {
    const header = parseRetryAfter(retryAfter);
    if (header !== null) return Math.min(header, this.retryMaxMs);
    const ceiling = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  private safe(url: string): string {
    return redact(url, this.secrets);
  }
}

/** Retry-After as seconds or an HTTP date, converted to milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function parseJson<T>(text: string, url: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NetworkError(`Invalid JSON response from ${url}`);
  }
}

function toApiError(status: number, text: string, url: string, secrets: string[]): ApiError {
  let message = `HTTP ${status}`;
  let apiStatus: string | undefined;
  try {
    const body = JSON.parse(text) as GoogleErrorBody;
    if (body.error?.message) message = `HTTP ${status}: ${body.error.message}`;
    apiStatus = body.error?.status;
  } catch {
    if (text.trim()) message = `HTTP ${status}: ${text.trim().slice(0, 200)}`;
  }
  return new ApiError(redact(message, secrets), status, apiStatus, url);
}
