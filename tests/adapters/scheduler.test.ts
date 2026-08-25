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
});
