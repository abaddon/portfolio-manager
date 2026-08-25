/** Typed error hierarchy: domain rules vs adapter failures vs configuration. */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** An adapter could not fetch/parse external data (mirrors tradingagents' typed "no data" errors). */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind: "no-data" | "auth" | "rate-limit" | "http" | "parse" | "unsupported",
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}
