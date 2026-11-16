/**
 * Pure calendar arithmetic for the four-hour birthday calendar. No I/O: the Platform server renders from it and the
 * FastAPI kernel stays the only place where a booking is accepted or refused.
 */

export const BOOKING_DURATION_MINUTES = 240;
/**
 * Owner decision (2026-11): a party may start at ANY minute (HH:MM), is exactly 240 minutes long and has no buffer.
 * The form offers a 15-minute picker for speed and always allows manual entry to the minute. The authoritative booking
 * writer validates the same minute-precise contract and PostgreSQL remains the final overlap guard.
 */
export const QUICK_STEP_MINUTES = 15;
export const BUSINESS_TIMEZONE = "Asia/Almaty";

const HHMM = /^(\d{2}):(\d{2})$/;
const RANGE = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/;

export type WorkingWindow = { openMin: number; closeMin: number };

/** "HH:MM" to minutes after midnight, or null when the text is not a valid time of day. */
export function toMinutes(hhmm: string): number | null {
  const match = HHMM.exec(hhmm);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Parses branch hours such as "10:00-23:00". Null means unknown: the caller must not offer bookings. */
export function parseWorkingHours(text: string | null | undefined): WorkingWindow | null {
  if (!text) return null;
  const match = RANGE.exec(text);
  if (!match) return null;
  const openMin = toMinutes(match[1].padStart(5, "0"));
  const closeMin = toMinutes(match[2].padStart(5, "0"));
  if (openMin === null || closeMin === null) return null;
  // The FastAPI kernel refuses a start unless the whole four-hour window fits in working hours.
  if (closeMin - openMin < BOOKING_DURATION_MINUTES) return null;
  return { openMin, closeMin };
}

/** Quick-pick starts on a 15-minute step whose four-hour window ends inside working hours. Manual entry is never limited to these. */
export function startOptions(window: WorkingWindow, step: number = QUICK_STEP_MINUTES): string[] {
  const options: string[] = [];
  const firstStart = Math.ceil(window.openMin / step) * step;
  for (let t = firstStart; t + BOOKING_DURATION_MINUTES <= window.closeMin; t += step) {
    options.push(formatMinutes(t));
  }
  return options;
}

/** Any valid HH:MM whose whole four-hour window fits in working hours. No rounding, no step. */
export function isBookableStart(startTime: string, window: WorkingWindow | null): boolean {
  const t = toMinutes(startTime);
  if (t === null || window === null) return false;
  return t >= window.openMin && t + BOOKING_DURATION_MINUTES <= window.closeMin;
}

/** The end of the four-hour window for a start time, "HH:MM", or null when the start is not a valid time. */
export function endTimeFor(startTime: string): string | null {
  const t = toMinutes(startTime);
  return t === null ? null : formatMinutes(t + BOOKING_DURATION_MINUTES);
}

const almatyClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes after midnight in Almaty time for an ISO timestamp, or null when it does not parse. */
export function almatyMinutes(iso: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = almatyClock.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return (hour % 24) * 60 + minute;
}

/** Longest axis the calendar draws, in minutes. The CSS ships position classes for exactly this many minutes. */
export const AXIS_MAX_MINUTES = 16 * 60;
const DAY_END = 24 * 60;

export type Axis = { startMin: number; endMin: number; minutes: number };

/** Clock minutes of an interval in Almaty time; an end at 00:00 (or before the start) means the end of the day. */
export function intervalMinutes(startIso: string, endIso: string): { from: number; to: number } | null {
  const from = almatyMinutes(startIso);
  const endRaw = almatyMinutes(endIso);
  if (from === null || endRaw === null) return null;
  const to = endRaw === 0 || endRaw < from ? DAY_END : endRaw;
  return to > from ? { from, to } : null;
}

/**
 * The visible day axis: the branch's working hours (default 10:00-22:00, as in the paper journal), widened to whole hours so
 * that no reservation (and no non-standard start such as 16:40) is ever cut off, and never longer than AXIS_MAX_MINUTES.
 */
export function dayAxis(window: WorkingWindow | null, intervals: { startsAt: string; endsAt: string }[]): Axis {
  let startMin = window ? window.openMin : 10 * 60;
  let endMin = window ? window.closeMin : 22 * 60;
  for (const item of intervals) {
    const span = intervalMinutes(item.startsAt, item.endsAt);
    if (!span) continue;
    startMin = Math.min(startMin, span.from);
    endMin = Math.max(endMin, span.to);
  }
  startMin = Math.floor(startMin / 60) * 60;
  endMin = Math.min(DAY_END, Math.ceil(endMin / 60) * 60);
  if (endMin - startMin > AXIS_MAX_MINUTES) startMin = endMin - AXIS_MAX_MINUTES;
  return { startMin, endMin, minutes: endMin - startMin };
}

/** Exact position of an interval on the axis in minutes from the axis start, clipped to the axis. Null when it lies outside. */
export function axisSpan(axis: Axis, startIso: string, endIso: string): { top: number; height: number } | null {
  const span = intervalMinutes(startIso, endIso);
  if (!span) return null;
  const from = Math.max(span.from, axis.startMin);
  const to = Math.min(span.to, axis.endMin);
  if (to <= from) return null;
  return { top: from - axis.startMin, height: to - from };
}

/** Position of a minute range (for shading outside working hours). Null when empty. */
export function axisRange(axis: Axis, fromMin: number, toMin: number): { top: number; height: number } | null {
  const from = Math.max(fromMin, axis.startMin);
  const to = Math.min(toMin, axis.endMin);
  return to > from ? { top: from - axis.startMin, height: to - from } : null;
}

/**
 * Whether a proposed four-hour window in a room overlaps an active reservation. Used to refuse before any request or payment
 * is written; the FastAPI kernel still decides, this only avoids leaving a request and a prepayment behind a known conflict.
 */
export function windowOverlapsRoom(
  intervals: { roomId: string; startsAt: string; endsAt: string; status: string }[],
  roomId: string,
  startIso: string,
  endIso: string,
): boolean {
  const from = Date.parse(startIso);
  const to = Date.parse(endIso);
  return intervals.some(
    (r) => r.roomId === roomId && r.status !== "released" && Date.parse(r.startsAt) < to && from < Date.parse(r.endsAt),
  );
}

/** The four-hour window that starts at a Almaty wall-clock time on a date, as ISO timestamps (Almaty is UTC+5, no DST). */
export function almatyWindow(date: string, startTime: string): { startIso: string; endIso: string } {
  const start = new Date(`${date}T${startTime}:00+05:00`);
  return { startIso: start.toISOString(), endIso: new Date(start.getTime() + BOOKING_DURATION_MINUTES * 60_000).toISOString() };
}

/** Greedy lane assignment: overlapping items get different lanes, so a conflict is visible as two stacked blocks. */
export function assignLanes(items: { id: string; start: number; span: number }[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const laneEnds: number[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const end = item.start + item.span;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    lanes.set(item.id, lane + 1);
  }
  return lanes;
}

export type Interval = { id: string; roomId: string; startsAt: string; endsAt: string };

/**
 * Ids of intervals that overlap another interval in the same room. The kernel prevents this; the calendar still marks it,
 * so that a manager never reads a visually clean grid as proof of a free room.
 */
export function overlappingIds(intervals: Interval[]): Set<string> {
  const flagged = new Set<string>();
  const byRoom = new Map<string, Interval[]>();
  for (const item of intervals) {
    const list = byRoom.get(item.roomId) ?? [];
    list.push(item);
    byRoom.set(item.roomId, list);
  }
  for (const list of byRoom.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (new Date(a.startsAt) < new Date(b.endsAt) && new Date(b.startsAt) < new Date(a.endsAt)) {
          flagged.add(a.id);
          flagged.add(b.id);
        }
      }
    }
  }
  return flagged;
}

/** A calendar date in Almaty, YYYY-MM-DD. The clock comes from the server, so the calendar never shows the client's day. */
export function almatyDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** What FastAPI reports about a birthday request's money and confirmation (the fields the calendar reads). */
export type LeadMoneyState = { bookedAt: string | null; manualPaymentFactStatus: "unpaid" | "prepaid"; manualPaymentFactAmountKzt: number };

/**
 * A reservation counts as a verified booking only when the reservation is confirmed AND the request has a real manual
 * prepayment fact AND the request is booked. The reservation status alone is not proof of money.
 */
export function bookedWithRealPayment(reservation: { status: string; paidKzt: number; paymentStatus: string }, lead: LeadMoneyState | null): boolean {
  if (reservation.status !== "confirmed") return false;
  if (reservation.paidKzt <= 0 || reservation.paymentStatus !== "prepaid") return false;
  if (!lead) return false;
  return lead.bookedAt !== null && lead.manualPaymentFactStatus === "prepaid" && lead.manualPaymentFactAmountKzt > 0;
}

/** Phone numbers compared by digits only, so "+7 700 111-22-33" equals "77001112233". */
export function samePhone(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  return da.length >= 7 && da === db;
}

/** Lead statuses after which a request no longer waits for a decision. */
export const CLOSED_REQUEST_STATUSES = new Set(["booked", "completed", "lost", "closed", "cancelled", "confirmed"]);

/** Birthday requests for a date that still wait for a decision. A request holds no room and no time, so it never fills the grid. */
export function openRequestsForDate<T extends { type: string; status: string; requestedDate?: string | null }>(items: T[], date: string): T[] {
  return items.filter((i) => i.type === "birthday_request" && i.requestedDate === date && !CLOSED_REQUEST_STATUSES.has(i.status));
}

export type PaymentTone = "prepaid" | "unpaid";

/** One short, factual payment label for a reservation block. "Prepaid" is a manual fact, never an online payment. */
export function paymentLabel(r: { paidKzt: number; paymentStatus: string }, format: (n: number) => string): { tone: PaymentTone; text: string } {
  if (r.paymentStatus === "prepaid" && r.paidKzt > 0) return { tone: "prepaid", text: `предоплата ${format(r.paidKzt)} ₸` };
  return { tone: "unpaid", text: "ждёт предоплату" };
}

/** The remaining amount is shown only when the price was agreed by a manager; a catalogue "from" price is not a debt. */
export function remainingKzt(r: { priceKzt: number | null; priceSource: string | null; paidKzt: number }): number | null {
  if (r.priceKzt === null || r.priceSource !== "manager_agreed") return null;
  return Math.max(r.priceKzt - r.paidKzt, 0);
}
