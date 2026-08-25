import { DomainError } from "../shared/errors.js";

export interface MarketSession {
  /** IANA timezone of the exchange. */
  tz: string;
  /** Local open time, "HH:MM". */
  open: string;
  /** Local close time, "HH:MM". */
  close: string;
  /** Local dates (YYYY-MM-DD) the exchange is closed. */
  holidays: string[];
  /** Local time the exchange closes early on `earlyCloses` dates, "HH:MM". */
  earlyClose?: string;
  /** Local dates (YYYY-MM-DD) with an early close (e.g. day after Thanksgiving). */
  earlyCloses?: string[];
}

/**
 * Exchange calendar as pure domain logic: given a session definition and a UTC
 * instant, decide whether the market is open. Weekday-only model with a
 * configurable holiday list (no external calendar dependency).
 */
export class MarketCalendar {
  constructor(readonly exchange: string, readonly session: MarketSession) {}

  private partsInTz(date: Date): { y: number; m: number; d: number; hhmm: number; day: number; dateStr: string } {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.session.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const y = get("year");
    const m = get("month");
    const d = get("day");
    const hh = get("hour");
    const mm = get("minute");
    return {
      y,
      m,
      d,
      hhmm: hh * 60 + mm,
      day: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
      dateStr: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    };
  }

  private toMinutes(hm: string): number {
    const m = /^(\d{2}):(\d{2})$/.exec(hm);
    if (!m) throw new DomainError(`invalid time "${hm}", expected HH:MM`);
    return Number(m[1]) * 60 + Number(m[2]);
  }

  isOpen(utcInstant: Date): boolean {
    const p = this.partsInTz(utcInstant);
    if (p.day === 0 || p.day === 6) return false;
    if (this.session.holidays.includes(p.dateStr)) return false;
    const open = this.toMinutes(this.session.open);
    const isEarlyCloseDate = this.session.earlyCloses?.includes(p.dateStr) ?? false;
    const close = isEarlyCloseDate && this.session.earlyClose ? this.toMinutes(this.session.earlyClose) : this.toMinutes(this.session.close);
    return p.hhmm >= open && p.hhmm < close;
  }

  /** Minute-of-hour of the instant in the exchange timezone (scheduler alignment). */
  minuteOfHourInTz(utcInstant: Date): number {
    return this.partsInTz(utcInstant).hhmm % 60;
  }

  /** True when the exchange trades at all on the instant's local date. */
  isTradingDay(utcInstant: Date): boolean {
    const p = this.partsInTz(utcInstant);
    if (p.day === 0 || p.day === 6) return false;
    return !this.session.holidays.includes(p.dateStr);
  }

  /** Next UTC instant at or after `after` when the market is open (for scheduler wake-ups). */
  nextOpenUtc(after: Date): Date {
    const step = 60_000; // 1-minute search granularity
    let t = new Date(after.getTime());
    let guard = 0;
    while (!this.isOpen(t)) {
      t = new Date(t.getTime() + step);
      if (++guard > 60 * 24 * 30) throw new DomainError(`no market open found within 30 days from ${after.toISOString()}`);
    }
    return t;
  }
}
