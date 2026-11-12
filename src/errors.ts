/** Base class for every error raised by cwv-watch. */
export class CwvWatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The configuration file is missing, unreadable or invalid. */
export class ConfigError extends CwvWatchError {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
  }
}

/** A Google API answered with a non-success status. */
export class ApiError extends CwvWatchError {
  constructor(
    message: string,
    readonly status: number,
    readonly apiStatus: string | undefined,
    readonly url: string,
  ) {
    super(message);
  }

  /** CrUX answers 404 when it has no data for the URL or origin. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The request failed before an HTTP status was received. */
export class NetworkError extends CwvWatchError {}

/** The request did not finish within the configured timeout. */
export class TimeoutError extends CwvWatchError {}
