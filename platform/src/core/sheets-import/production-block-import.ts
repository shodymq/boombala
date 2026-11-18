import "server-only";

import { z } from "zod";
import { almatyToday, isValidDate } from "../dates.ts";
import { normalizeRow, rowFromCells, mapHeader } from "./normalize.ts";
import type { BookingCatalog, BookingTimeline, FastApiCrmClient } from "../../server/fastapi-crm.ts";

export const BOOKING_SHEETS_ID = "10Xe4jTT6QrRO9ZHRSniT_BPfXHfQgmXkEsNsadZ-13U";
const SHEET_TITLE = "Лист1";
const BLOCK_MINUTES = 240;
const MAX_REASON_LENGTH = 300;

const planSchema = z.object({
  spreadsheetId: z.literal(BOOKING_SHEETS_ID),
  sheetId: z.literal(0),
  sheetTitle: z.literal(SHEET_TITLE),
  headers: z.array(z.string().max(200)).length(14),
  rows: z.array(z.object({
    rowNumber: z.number().int().min(3).max(1049),
    cells: z.array(z.string().max(1000)).min(1).max(14),
  }).strict()).max(600),
}).strict();

export type BookingSheetsPlan = z.infer<typeof planSchema>;
type BookingWriter = Pick<FastApiCrmClient, "getBookingCatalog" | "getBookingTimeline" | "blockSlot">;
type ItemStatus = "created" | "already_present" | "conflict" | "skipped" | "failed";
export type SheetBlockImportResult = {
  counts: { futureRows: number; created: number; alreadyPresent: number; conflicts: number; skipped: number; verified: number; failed: number; historical: number };
  items: Array<{ rowNumber: number; status: ItemStatus; reason?: string }>;
};

export class SheetBlockImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "SheetBlockImportError";
    this.code = code;
  }
}

export function parseBookingSheetsPlan(value: unknown): BookingSheetsPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new SheetBlockImportError("invalid_plan");
  const headerMap = mapHeader(parsed.data.headers);
  if (!headerMap) throw new SheetBlockImportError("invalid_headers");
  const rowNumbers = new Set<number>();
  for (const row of parsed.data.rows) {
    if (rowNumbers.has(row.rowNumber)) throw new SheetBlockImportError("duplicate_source_row_number");
    rowNumbers.add(row.rowNumber);
  }
  return parsed.data;
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new SheetBlockImportError("invalid_tsv");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Accept the JSON plan or a direct rectangular copy of Google Sheets A1:N300. */
export function parseBookingSheetsText(value: string): BookingSheetsPlan {
  const trimmed = value.trim();
  if (!trimmed) throw new SheetBlockImportError("invalid_plan");
  if (trimmed.startsWith("{")) {
    try { return parseBookingSheetsPlan(JSON.parse(trimmed)); }
    catch (error) {
      if (error instanceof SheetBlockImportError) throw error;
      throw new SheetBlockImportError("invalid_plan");
    }
  }
  const grid = parseTsv(value);
  const headerIndex = grid.findIndex((cells) => mapHeader(Array.from({ length: 14 }, (_, index) => cells[index] ?? "")) !== null);
  // The source row number is meaningful only when the copy starts at cell A1 and its known header is on row 2.
  if (headerIndex !== 1) throw new SheetBlockImportError("invalid_headers");
  const headers = Array.from({ length: 14 }, (_, index) => grid[headerIndex][index] ?? "");
  const rows = grid.slice(headerIndex + 1).map((cells, index) => ({
    rowNumber: index + 3,
    cells: Array.from({ length: 14 }, (_, cellIndex) => cells[cellIndex] ?? ""),
  }));
  return parseBookingSheetsPlan({ spreadsheetId: BOOKING_SHEETS_ID, sheetId: 0, sheetTitle: SHEET_TITLE, headers, rows });
}

function minutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function workingWindow(value: string): { open: number; close: number } {
  const match = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/.exec(value);
  if (!match) throw new SheetBlockImportError("unsupported_working_hours");
  const open = minutes(match[1].padStart(5, "0"));
  const close = minutes(match[2].padStart(5, "0"));
  if (open === null || close === null || close <= open) throw new SheetBlockImportError("unsupported_working_hours");
  return { open, close };
}

function almatyMinute(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

function intervalStart(date: string, time: string): number {
  // Almaty has used UTC+05:00 since 2024. This is the same wall-clock conversion used by the production bridge.
  return Date.parse(`${date}T${time}:00+05:00`);
}

function reservationDateTime(reservation: BookingTimeline["reservations"][number]): { date: string; time: string } | null {
  const start = new Date(reservation.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(start);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

function active(reservation: BookingTimeline["reservations"][number]): boolean {
  return reservation.status !== "released" && !reservation.releasedAt;
}

function overlap(start: number, end: number, reservation: BookingTimeline["reservations"][number]): boolean {
  if (!active(reservation)) return false;
  const occupiedEnd = Date.parse(reservation.occupiedEndsAt || reservation.endsAt);
  const reservationStart = Date.parse(reservation.startsAt);
  return Number.isFinite(reservationStart) && Number.isFinite(occupiedEnd) && start < occupiedEnd && reservationStart < end;
}

function noteFor(rowNumber: number, cells: string[], sourceKey: string): string | null {
  const note = `Google Sheets «Банкеты», строка ${rowNumber}; A:N=${JSON.stringify(cells)}; предоплата не подтверждена; src=${sourceKey.slice(0, 20)}`;
  return note.length <= MAX_REASON_LENGTH ? note : null;
}

function idempotencyKey(sourceKey: string): string {
  return `sheets-block-v1:0:${sourceKey}`;
}

function reservationId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function hasSource(reservation: BookingTimeline["reservations"][number], sourceKey: string): boolean {
  return reservation.note?.includes(`src=${sourceKey.slice(0, 20)}`) ?? false;
}

function sourceMatch(reservation: BookingTimeline["reservations"][number], candidate: Candidate): boolean {
  const local = reservationDateTime(reservation);
  return active(reservation) && reservation.roomId === candidate.roomId && local?.date === candidate.date && local.time === candidate.time && hasSource(reservation, candidate.sourceKey);
}

type Candidate = { rowNumber: number; cells: string[]; sourceKey: string; date: string; time: string; roomId: string; reason: string; idempotencyKey: string };

function countResult(items: SheetBlockImportResult["items"], historical: number, futureRows: number): SheetBlockImportResult["counts"] {
  return {
    futureRows, historical,
    created: items.filter((item) => item.status === "created").length,
    alreadyPresent: items.filter((item) => item.status === "already_present").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    verified: items.filter((item) => item.status === "created" || item.status === "already_present").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

/**
 * Imports future spreadsheet events as room blocks through the existing authenticated typed CRM client.
 * It never creates leads, bookings, confirmations, or payment facts. PostgreSQL's existing interval constraint remains
 * the final concurrency guard; this routine performs a read-only preflight and verifies every block after writing.
 */
export async function importBookingSheetBlocks(
  plan: BookingSheetsPlan,
  writer: BookingWriter,
  now: Date = new Date(),
): Promise<SheetBlockImportResult> {
  const headerMap = mapHeader(plan.headers);
  if (!headerMap) throw new SheetBlockImportError("invalid_headers");

  const catalog = await writer.getBookingCatalog("almaty") as BookingCatalog;
  const branch = catalog.branches.find((item) => item.slug === "almaty" && item.id === "almaty");
  if (!branch) throw new SheetBlockImportError("branch_unavailable");
  const window = workingWindow(branch.workingHours);
  const today = almatyToday(now);
  const nowMinute = almatyMinute(now);
  const items: SheetBlockImportResult["items"] = [];
  const historicalCount = { value: 0 };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const sourceRow of plan.rows) {
    const cells = Array.from({ length: plan.headers.length }, (_, index) => sourceRow.cells[index] ?? "");
    const raw = rowFromCells(cells, headerMap);
    if (!Object.values(raw).some((cell) => (cell ?? "").trim())) continue;
    const normalized = normalizeRow(raw, {
      spreadsheetId: plan.spreadsheetId, sheetId: plan.sheetId, rowNumber: sourceRow.rowNumber,
    }, { rooms: catalog.rooms, packages: catalog.packages });
    if (!normalized.date || !isValidDate(normalized.date)) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "date_unresolved" });
      continue;
    }
    if (normalized.date < today) { historicalCount.value += 1; continue; }
    if (!normalized.time || !normalized.roomId) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "date_time_or_room_unresolved" });
      continue;
    }
    const startMinute = minutes(normalized.time);
    if (startMinute === null || startMinute < window.open || startMinute + BLOCK_MINUTES > window.close ||
        (normalized.date === today && startMinute <= nowMinute)) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "outside_future_working_window" });
      continue;
    }
    const room = catalog.rooms.find((item) => item.id === normalized.roomId && item.branchId === branch.id);
    if (!room) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "room_unresolved" });
      continue;
    }
    if (seen.has(normalized.sourceKey)) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "duplicate_source_row" });
      continue;
    }
    seen.add(normalized.sourceKey);
    const reason = noteFor(sourceRow.rowNumber, cells, normalized.sourceKey);
    if (!reason) {
      items.push({ rowNumber: sourceRow.rowNumber, status: "skipped", reason: "source_row_exceeds_note_limit" });
      continue;
    }
    candidates.push({
      rowNumber: sourceRow.rowNumber, cells, sourceKey: normalized.sourceKey, date: normalized.date,
      time: normalized.time, roomId: normalized.roomId, reason, idempotencyKey: idempotencyKey(normalized.sourceKey),
    });
  }

  const internalConflict = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    const aStart = intervalStart(a.date, a.time);
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (a.date !== b.date || a.roomId !== b.roomId) continue;
      const bStart = intervalStart(b.date, b.time);
      if (aStart < bStart + BLOCK_MINUTES * 60_000 && bStart < aStart + BLOCK_MINUTES * 60_000) {
        internalConflict.add(a.sourceKey);
        internalConflict.add(b.sourceKey);
      }
    }
  }

  const dates = [...new Set(candidates.map((candidate) => candidate.date))];
  const timelines = new Map<string, BookingTimeline>();
  await Promise.all(dates.map(async (date) => timelines.set(date, await writer.getBookingTimeline(branch.id, date))));
  const eligible: Candidate[] = [];
  for (const candidate of candidates) {
    const timeline = timelines.get(candidate.date);
    if (!timeline) throw new SheetBlockImportError("timeline_unavailable");
    if (internalConflict.has(candidate.sourceKey)) {
      items.push({ rowNumber: candidate.rowNumber, status: "conflict", reason: "overlap_with_source_sheet" });
      continue;
    }
    const sameSource = timeline.reservations.find((reservation) => hasSource(reservation, candidate.sourceKey));
    if (sameSource && sourceMatch(sameSource, candidate)) {
      items.push({ rowNumber: candidate.rowNumber, status: "already_present" });
      continue;
    }
    if (sameSource || timeline.reservations.some((reservation) =>
      active(reservation) && reservation.roomId === candidate.roomId &&
      overlap(intervalStart(candidate.date, candidate.time), intervalStart(candidate.date, candidate.time) + BLOCK_MINUTES * 60_000, reservation))) {
      items.push({ rowNumber: candidate.rowNumber, status: "conflict", reason: "room_interval_occupied" });
      continue;
    }
    eligible.push(candidate);
  }

  const writtenIds = new Map<string, string>();
  for (const candidate of eligible) {
    try {
      const saved = await writer.blockSlot({
        branchId: branch.id,
        bookingDate: candidate.date,
        roomId: candidate.roomId,
        startTime: candidate.time,
        reason: candidate.reason,
        idempotencyKey: candidate.idempotencyKey,
      });
      const id = reservationId(saved);
      if (!id) {
        items.push({ rowNumber: candidate.rowNumber, status: "failed", reason: "writer_returned_no_id" });
        continue;
      }
      writtenIds.set(candidate.sourceKey, id);
      items.push({ rowNumber: candidate.rowNumber, status: "created" });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 409) {
        const latest = await writer.getBookingTimeline(branch.id, candidate.date);
        const raced = latest.reservations.find((reservation) => sourceMatch(reservation, candidate));
        if (raced) {
          writtenIds.set(candidate.sourceKey, raced.id);
          items.push({ rowNumber: candidate.rowNumber, status: "already_present" });
        } else {
          items.push({ rowNumber: candidate.rowNumber, status: "conflict", reason: "room_interval_occupied" });
        }
        continue;
      }
      throw error;
    }
  }

  const verifyDates = [...new Set(eligible.map((candidate) => candidate.date))];
  const verifiedTimelines = new Map<string, BookingTimeline>();
  await Promise.all(verifyDates.map(async (date) => verifiedTimelines.set(date, await writer.getBookingTimeline(branch.id, date))));
  for (const candidate of candidates) {
    const item = items.find((value) => value.rowNumber === candidate.rowNumber);
    if (!item || (item.status !== "created" && item.status !== "already_present")) continue;
    const timeline = verifiedTimelines.get(candidate.date) ?? timelines.get(candidate.date);
    const id = writtenIds.get(candidate.sourceKey);
    const found = timeline?.reservations.find((reservation) =>
      (id ? reservation.id === id : true) && sourceMatch(reservation, candidate));
    if (!found) {
      item.status = "failed";
      item.reason = "readback_verification_failed";
    }
  }

  return { counts: countResult(items, historicalCount.value, candidates.length), items };
}
