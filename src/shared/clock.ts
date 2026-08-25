/** Time source injected everywhere so tests are deterministic. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private readonly current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current.setTime(this.current.getTime() + ms);
  }
}

export function toIso(date: Date): string {
  return date.toISOString();
}
