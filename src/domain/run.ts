export type RunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

/** Thrown when a manual run is requested while another run is executing. */
export class RunInProgressError extends Error {
  constructor(readonly runId: string) {
    super(`a run is already in progress (${runId})`);
    this.name = "RunInProgressError";
  }
}

export class Run {
  constructor(
    readonly id: string,
    readonly startedAt: string,
    public status: RunStatus,
    public finishedAt: string | null,
    public marketOpen: boolean,
    public error: string | null,
    public details: Record<string, unknown>,
  ) {}

  static start(id: string, startedAt: string, marketOpen: boolean): Run {
    return new Run(id, startedAt, "RUNNING", null, marketOpen, null, {});
  }

  complete(finishedAt: string, details: Record<string, unknown> = {}): void {
    this.status = "COMPLETED";
    this.finishedAt = finishedAt;
    this.details = { ...this.details, ...details };
  }

  skip(finishedAt: string, reason: string): void {
    this.status = "SKIPPED";
    this.finishedAt = finishedAt;
    this.error = reason;
  }

  fail(finishedAt: string, error: string): void {
    this.status = "FAILED";
    this.finishedAt = finishedAt;
    this.error = error;
  }
}
