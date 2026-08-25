import type { Clock } from "../../shared/clock.js";
import type { Logger } from "../../shared/logger.js";
import type { MarketCalendarPort } from "../../application/ports.js";
import { MarketCalendar, type MarketSession } from "../../domain/calendar.js";

export interface SchedulableCalendar extends MarketCalendarPort {
  /** Minute-of-hour in the market's timezone (for run-minute alignment). */
  minuteOfHour(now: Date): number;
}

export class ConfigMarketCalendar extends MarketCalendar implements SchedulableCalendar {
  constructor(exchange: string, session: MarketSession) {
    super(exchange, session);
  }

  minuteOfHour(now: Date): number {
    return this.minuteOfHourInTz(now);
  }
}

/**
 * In-process hourly scheduler: ticks every few seconds, triggers the pipeline
 * at the configured minute of each hour while the market is open. Idempotent:
 * a run fires at most once per market hour (the orchestrator double-guards
 * via RunRepository.findSameHour).
 */
export class PipelineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastFiredHour: string | null = null;
  private running = false;

  constructor(
    private readonly calendar: SchedulableCalendar,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly onRun: () => Promise<unknown>,
    private readonly opts: { runAtMinutePastHour: number; tickMs?: number; runOnStartup?: boolean },
  ) {}

  start(): void {
    const tickMs = this.opts.tickMs ?? 20_000;
    if (this.opts.runOnStartup) {
      void this.check(true);
    }
    this.timer = setInterval(() => void this.check(false), tickMs);
    this.timer.unref?.();
    this.logger.info(
      `scheduler started (run at minute ${this.opts.runAtMinutePastHour} of each open market hour)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(startup: boolean): Promise<void> {
    if (this.running) return;
    const now = this.clock.now();
    if (!this.calendar.isOpen(now)) return;
    const minute = this.calendar.minuteOfHour(now);
    if (!startup && minute !== this.opts.runAtMinutePastHour) return;

    const hourKey = now.toISOString().slice(0, 13);
    if (!startup && this.lastFiredHour === hourKey) return;
    this.lastFiredHour = hourKey;
    this.running = true;
    try {
      await this.onRun();
    } finally {
      this.running = false;
    }
  }
}
