import { describe, expect, it } from "vitest";
import { MarketCalendar } from "../../src/domain/calendar.js";

const NYSE = {
  tz: "America/New_York",
  open: "09:30",
  close: "16:00",
  holidays: ["2026-07-03", "2026-12-25"],
};

// Wednesday 2026-08-26 (no holiday).
const wedOpenUtc = new Date("2026-08-26T14:30:00Z"); // 10:30 ET — open
const wedBeforeUtc = new Date("2026-08-26T13:00:00Z"); // 09:00 ET — before open
const wedAtCloseUtc = new Date("2026-08-26T20:00:00Z"); // 16:00 ET — closed (close is exclusive)
const satUtc = new Date("2026-08-29T14:30:00Z"); // Saturday — closed
const holidayUtc = new Date("2026-07-03T14:30:00Z"); // 2026-07-03 observed holiday
const dstSummerUtc = new Date("2026-06-10T13:30:00Z"); // 09:30 ET during DST — open boundary

describe("MarketCalendar", () => {
  const cal = new MarketCalendar("NYSE", NYSE);

  it("is open during a weekday session", () => {
    expect(cal.isOpen(wedOpenUtc)).toBe(true);
  });

  it("is closed before open and at/after close", () => {
    expect(cal.isOpen(wedBeforeUtc)).toBe(false);
    expect(cal.isOpen(wedAtCloseUtc)).toBe(false);
  });

  it("is closed on weekends and holidays", () => {
    expect(cal.isOpen(satUtc)).toBe(false);
    expect(cal.isOpen(holidayUtc)).toBe(false);
  });

  it("handles DST correctly (09:30 ET == 13:30 UTC in summer)", () => {
    expect(cal.isOpen(dstSummerUtc)).toBe(true);
    expect(cal.isOpen(new Date("2026-01-07T14:30:00Z"))).toBe(true); // 09:30 ET in winter
  });

  it("reports trading days ignoring time of day", () => {
    expect(cal.isTradingDay(wedBeforeUtc)).toBe(true);
    expect(cal.isTradingDay(satUtc)).toBe(false);
    expect(cal.isTradingDay(holidayUtc)).toBe(false);
  });

  it("finds the next open instant from a closed one", () => {
    const next = cal.nextOpenUtc(wedBeforeUtc);
    expect(next >= wedBeforeUtc).toBe(true);
    expect(cal.isOpen(next)).toBe(true);
  });

  it("computes minute-of-hour in exchange timezone", () => {
    expect(cal.minuteOfHourInTz(wedOpenUtc)).toBe(30); // 10:30 ET
    expect(cal.minuteOfHourInTz(new Date("2026-08-26T14:00:00Z"))).toBe(0); // 10:00 ET
  });
});
