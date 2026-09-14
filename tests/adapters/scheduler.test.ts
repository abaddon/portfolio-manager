import { describe, expect, it, vi } from "vitest";
import { PipelineScheduler, ConfigMarketCalendar } from "../../src/adapters/scheduler/scheduler.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";

const session = {
  tz: "America/New_York",
  open: "09:30",
  close: "16:00",
  holidays: [],
};

describe("PipelineScheduler", () => {
  it("fires at the configured minute of each open market hour, once per hour", async () => {
    // Clock that tracks real elapsed time from a base near an hour boundary.
    let base = Date.parse("2026-08-26T13:59:55Z"); // 09:59:55 ET — open, 5s before minute 0
    const t0 = Date.now();
    const clock = { now: () => new Date(base + (Date.now() - t0)) };
    const calendar = new ConfigMarketCalendar("NYSE", session);
    const onRun = vi.fn(async () => {});
    const scheduler = new PipelineScheduler(calendar, clock, new NullLogger(), onRun, {
      runAtMinutePastHour: 0,
      tickMs: 100,
      runOnStartup: false,
    });
    scheduler.start();

    // Fires at 10:00 ET (minute 0).
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 100 });
    // Same hour keeps ticking — no duplicate runs.
    await new Promise((r) => setTimeout(r, 500));
    expect(onRun).toHaveBeenCalledTimes(1);

    // Jump to just before the next hour boundary → second run fires.
    base += 3_600_000; // now 14:59:55Z = 10:59:55 ET
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(2), { timeout: 15_000, interval: 100 });
    scheduler.stop();
  }, 40_000);

  it("never fires while the market is closed", async () => {
    const clock = new FixedClock(new Date("2026-08-29T14:00:00Z")); // Saturday 10:00 ET
    const calendar = new ConfigMarketCalendar("NYSE", session);
    const onRun = vi.fn(async () => {});
    const scheduler = new PipelineScheduler(calendar, clock, new NullLogger(), onRun, {
      runAtMinutePastHour: 0,
      tickMs: 100,
      runOnStartup: false,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(onRun).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("runs once on startup when market is open and runOnStartup is set", async () => {
    const clock = new FixedClock(new Date("2026-08-26T14:17:00Z")); // 10:17 ET — open, not minute 0
    const calendar = new ConfigMarketCalendar("NYSE", session);
    const onRun = vi.fn(async () => {});
    const scheduler = new PipelineScheduler(calendar, clock, new NullLogger(), onRun, {
      runAtMinutePastHour: 0,
      tickMs: 60_000,
      runOnStartup: true,
    });
    scheduler.start();
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 50 });
    scheduler.stop();
  });

  it("contains a rejected run instead of leaving an unhandled rejection", async () => {
    // `check()` is fire-and-forget; PipelineOrchestrator.runOnce can reject from
    // its prologue (reconcile/sweep/db), and an unhandled rejection terminates
    // `pnpm serve` — taking the scheduler and the dashboard down with it.
    let now = new Date("2026-08-26T14:00:00Z"); // 10:00 ET, minute 0
    const clock = { now: () => new Date(now.getTime()) };
    const calendar = new ConfigMarketCalendar("NYSE", session);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const onRun = vi.fn(async () => {
        throw new Error("database is locked");
      });
      const scheduler = new PipelineScheduler(calendar, clock, new NullLogger(), onRun, {
        runAtMinutePastHour: 0,
        tickMs: 100,
        runOnStartup: true,
      });
      scheduler.start();
      await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 50 });

      // The rejected run did not kill the scheduler: the next market hour fires.
      now = new Date("2026-08-26T15:00:00Z");
      await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 50 });
      scheduler.stop();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20_000);
});
