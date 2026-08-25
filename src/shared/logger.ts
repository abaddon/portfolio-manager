export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    if (order[level] < order[this.minLevel]) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    if (level === "error") console.error(line + suffix);
    else if (level === "warn") console.warn(line + suffix);
    else console.log(line + suffix);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log("error", msg, meta);
  }
}

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
