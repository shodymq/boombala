/**
 * Pure calendar arithmetic for the four-hour birthday calendar. No I/O: the Platform server renders from it and the
 * FastAPI kernel stays the only place where a booking is accepted or refused.
 */

export const BOOKING_DURATION_MINUTES = 240;
export const START_STEP_MINUTES = 15;
export const BUSINESS_TIMEZONE = "Asia/Almaty";
/** Quick-pick starts shown as shortcuts. They never limit the choice: any 15-minute start inside working hours is valid. */
export const QUICK_STARTS = ["12:00", "16:00", "20:00"] as const;

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

/** Every bookable start on the 15-minute step, so that the four-hour window ends inside working hours. */
export function startOptions(window: WorkingWindow): string[] {
  const options: string[] = [];
  for (let t = window.openMin; t + BOOKING_DURATION_MINUTES <= window.closeMin; t += START_STEP_MINUTES) {
    options.push(formatMinutes(t));
  }
  return options;
}

export function isBookableStart(startTime: string, window: WorkingWindow | null): boolean {
  const t = toMinutes(startTime);
  if (t === null || window === null) return false;
  if (t % START_STEP_MINUTES !== 0) return false;
  return t >= window.openMin && t + BOOKING_DURATION_MINUTES <= window.closeMin;
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

/** The day grid always spans 09:00-24:00 in 15-minute columns; hours outside a branch's working day are shaded. */
export const GRID_OPEN_MIN = 9 * 60;
export const GRID_CLOSE_MIN = 24 * 60;
export const GRID_COLUMNS = (GRID_CLOSE_MIN - GRID_OPEN_MIN) / START_STEP_MINUTES;

/**
 * 1-based grid column and span for a reservation, clipped to the day grid. Null when it lies outside the grid or cannot be
 * read. An interval that ends at 00:00 ends at the end of the day.
 */
export function gridColumn(startIso: string, endIso: string): { start: number; span: number } | null {
  const startMin = almatyMinutes(startIso);
  const endRaw = almatyMinutes(endIso);
  if (startMin === null || endRaw === null) return null;
  // An end at 00:00, or before the start, runs to the end of the day. An end equal to the start is empty (null below).
  const endMin = endRaw === 0 || endRaw < startMin ? GRID_CLOSE_MIN : endRaw;
  const from = Math.max(startMin, GRID_OPEN_MIN);
  const to = Math.min(endMin, GRID_CLOSE_MIN);
  if (to <= from) return null;
  return { start: (from - GRID_OPEN_MIN) / START_STEP_MINUTES + 1, span: (to - from) / START_STEP_MINUTES };
}

/** Grid columns for a minute range (used for shading outside working hours). Null when empty. */
export function gridRangeColumns(fromMin: number, toMin: number): { start: number; span: number } | null {
  const from = Math.max(fromMin, GRID_OPEN_MIN);
  const to = Math.min(toMin, GRID_CLOSE_MIN);
  if (to <= from) return null;
  return { start: (from - GRID_OPEN_MIN) / START_STEP_MINUTES + 1, span: (to - from) / START_STEP_MINUTES };
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
