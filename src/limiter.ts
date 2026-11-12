/**
 * Concurrency and rate control for outgoing API calls.
 *
 * The CrUX API allows 150 queries per minute per Google Cloud project and the
 * PageSpeed Insights API has its own per-minute quota, so every request goes
 * through a limiter that caps both parallelism and requests per window.
 */

export type Sleep = (ms: number) => Promise<void>;
export type Clock = () => number;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LimiterOptions {
  /** Maximum requests in flight at once. */
  concurrency: number;
  /** Maximum requests started per `intervalMs`. 0 disables the rate cap. */
  maxPerInterval: number;
  intervalMs?: number;
  now?: Clock;
  sleep?: Sleep;
}

export class Limiter {
  readonly concurrency: number;
  readonly maxPerInterval: number;
  readonly intervalMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Start times of requests inside the current sliding window. */
  private readonly starts: number[] = [];
  private slotChain: Promise<void> = Promise.resolve();

  constructor(options: LimiterOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
    if (!Number.isInteger(options.maxPerInterval) || options.maxPerInterval < 0) {
      throw new RangeError('maxPerInterval must be a non-negative integer');
    }
    this.concurrency = options.concurrency;
    this.maxPerInterval = options.maxPerInterval;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  get pending(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }

  /** Run `task` once a concurrency slot and a rate slot are free. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.rateSlot();
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  /** Serialise rate-slot bookkeeping so concurrent callers do not race. */
  private rateSlot(): Promise<void> {
    const slot = this.slotChain.then(() => this.waitForWindow());
    this.slotChain = slot.catch(() => undefined);
    return slot;
  }

  private async waitForWindow(): Promise<void> {
    if (this.maxPerInterval === 0) return;
    for (;;) {
      const now = this.now();
      while (this.starts.length > 0 && now - this.starts[0]! >= this.intervalMs) this.starts.shift();
      if (this.starts.length < this.maxPerInterval) {
        this.starts.push(now);
        return;
      }
      const waitMs = this.intervalMs - (now - this.starts[0]!);
      await this.sleep(Math.max(1, waitMs));
    }
  }
}

/** Map over `items` with at most `concurrency` promises pending. Results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
