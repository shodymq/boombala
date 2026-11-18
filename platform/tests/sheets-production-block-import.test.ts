import test from "node:test";
import assert from "node:assert/strict";
import {
  importBookingSheetBlocks,
  parseBookingSheetsPlan,
  parseBookingSheetsText,
  SheetBlockImportError,
  BOOKING_SHEETS_ID,
  type BookingSheetsPlan,
} from "../src/core/sheets-import/production-block-import.ts";
import type { BookingCatalog, BookingTimeline } from "../src/server/fastapi-crm.ts";

const headers = ["№ г.", "Дата", "Время", "Наименование пакет", "аниматор", "кабинка", "имя", "номер", "имя ребенка", "возраст", "предоплата", "", "дет", "взр"];
const catalog: BookingCatalog = {
  branches: [{ id: "almaty", slug: "almaty", name: "Almaty", city: "Almaty", workingHours: "10:00–22:00", bufferMinutes: 0 }],
  rooms: [
    { id: "roblox-room", branchId: "almaty", name: "Roblox Room" },
    { id: "ice-room", branchId: "almaty", name: "Ice Room" },
    { id: "magic-room", branchId: "almaty", name: "Magic Room" },
    { id: "rapunzel-room", branchId: "almaty", name: "Rapunzel Room" },
  ],
  packages: [{ id: "boom-party", branchId: "almaty", name: "Boom Bala Party" }],
};

function plan(rows: Array<{ rowNumber: number; cells: string[] }>): BookingSheetsPlan {
  return {
    spreadsheetId: BOOKING_SHEETS_ID,
    sheetId: 0,
    sheetTitle: "Лист1",
    headers,
    rows,
  };
}

function row(rowNumber: number, date: string, time: string, room: string, extra: Partial<Record<number, string>> = {}) {
  const cells = Array(headers.length).fill("");
  cells[0] = String(rowNumber - 2);
  cells[1] = date;
  cells[2] = time;
  cells[3] = "Magic party";
  cells[5] = room;
  cells[6] = "Тестовый сопровождающий";
  cells[7] = "+7 700 000 00 00";
  cells[8] = "Тест";
  cells[9] = "5";
  cells[10] = "10к";
  cells[12] = "3";
  cells[13] = "2";
  for (const [key, value] of Object.entries(extra)) cells[Number(key)] = value;
  return { rowNumber, cells };
}

function instant(date: string, time: string): string {
  return new Date(`${date}T${time}:00+05:00`).toISOString();
}

class FakeWriter {
  readonly reservations = new Map<string, BookingTimeline["reservations"][number][]>();
  readonly calls: Array<Record<string, unknown>> = [];
  async getBookingCatalog() { return catalog; }
  async getBookingTimeline(branchId: string, date: string): Promise<BookingTimeline> {
    return { branchId, date, timezone: "Asia/Almaty", bufferMinutes: 0, rooms: catalog.rooms.map(({ id, name }) => ({ id, name })), reservations: this.reservations.get(date) ?? [] };
  }
  async blockSlot(input: Record<string, unknown>) {
    this.calls.push(input);
    const date = String(input.bookingDate);
    const time = String(input.startTime);
    const startsAt = instant(date, time);
    const endsAt = new Date(Date.parse(startsAt) + 240 * 60_000).toISOString();
    const id = `block-${this.calls.length}`;
    const saved = {
      id, kind: "block" as const, status: "blocked" as const, roomId: String(input.roomId),
      startsAt, endsAt, occupiedEndsAt: endsAt, slotId: null, packageName: null, priceKzt: null,
      priceSource: null, paidKzt: 0, paymentStatus: "unpaid" as const,
      note: String(input.reason), requestId: null, customerName: null, customerPhone: null,
      createdByAdminId: "owner", createdByName: null,
    };
    this.reservations.set(date, [...(this.reservations.get(date) ?? []), saved]);
    return { id, status: "blocked" };
  }
}

const now = new Date("2026-11-18T03:00:00.000Z");

test("owner batch import writes only room blocks and verifies them by reading the calendar back", async () => {
  const writer = new FakeWriter();
  const event = row(148, "20.11.2026", "14:00", "Roblox room");
  event.cells[3] = ""; // Package can be missing; the source row is retained in the block note.
  const result = await importBookingSheetBlocks(plan([event]), writer, now);

  assert.deepEqual(result.counts, { futureRows: 1, created: 1, alreadyPresent: 0, conflicts: 0, skipped: 0, verified: 1, failed: 0, historical: 0 });
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].reason && String(writer.calls[0].reason).includes(JSON.stringify(event.cells)), true);
  assert.match(String(writer.calls[0].reason), /предоплата не подтверждена/);
  assert.equal("amountKzt" in writer.calls[0], false);
  assert.equal("packageId" in writer.calls[0], false);
});

test("a retry with the same source rows is idempotent and creates no second block", async () => {
  const writer = new FakeWriter();
  const batch = plan([row(149, "20.11.2026", "14:00", "Roblox room")]);
  const first = await importBookingSheetBlocks(batch, writer, now);
  const second = await importBookingSheetBlocks(batch, writer, now);
  assert.equal(first.counts.created, 1);
  assert.equal(second.counts.created, 0);
  assert.equal(second.counts.alreadyPresent, 1);
  assert.equal(second.counts.verified, 1);
  assert.equal(writer.calls.length, 1);
});

test("overlapping rows in one room are both rejected; adjacent intervals are accepted", async () => {
  const overlappingWriter = new FakeWriter();
  const overlapResult = await importBookingSheetBlocks(plan([
    row(150, "20.11.2026", "10:00", "Roblox room"),
    row(151, "20.11.2026", "13:00", "Roblox room"),
  ]), overlappingWriter, now);
  assert.equal(overlapResult.counts.conflicts, 2);
  assert.equal(overlappingWriter.calls.length, 0);

  const adjacentWriter = new FakeWriter();
  const adjacentResult = await importBookingSheetBlocks(plan([
    row(152, "20.11.2026", "10:00", "Roblox room"),
    row(153, "20.11.2026", "14:00", "Roblox room"),
  ]), adjacentWriter, now);
  assert.equal(adjacentResult.counts.created, 2);
  assert.equal(adjacentResult.counts.verified, 2);
});

test("occupied rooms, unknown rooms and out-of-hours events do not write", async () => {
  const writer = new FakeWriter();
  const startsAt = instant("2026-11-20", "10:00");
  const endsAt = new Date(Date.parse(startsAt) + 240 * 60_000).toISOString();
  writer.reservations.set("2026-11-20", [{
    id: "existing", kind: "booking", status: "confirmed", roomId: "roblox-room",
    startsAt, endsAt, occupiedEndsAt: endsAt, slotId: null, packageName: "Magic party",
    priceKzt: 0, priceSource: null, paidKzt: 0, paymentStatus: "unpaid", note: null, requestId: null,
    customerName: null, customerPhone: null, createdByAdminId: null, createdByName: null,
  }]);
  const result = await importBookingSheetBlocks(plan([
    row(154, "20.11.2026", "12:00", "Roblox room"),
    row(155, "20.11.2026", "14:00", "Общий зал"),
    row(156, "20.11.2026", "20:00", "Magic room"),
  ]), writer, now);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(result.counts.skipped, 2);
  assert.equal(writer.calls.length, 0);
});

test("the import plan is strict and rejects payment-operation fields", () => {
  const value = plan([row(157, "20.11.2026", "14:00", "Roblox room")]);
  assert.throws(() => parseBookingSheetsPlan({ ...value, payment: { amountKzt: 10_000 } }), (error) =>
    error instanceof SheetBlockImportError && error.code === "invalid_plan");
  assert.equal(parseBookingSheetsPlan(value).rows.length, 1);
});

test("direct Google Sheets clipboard input preserves A1:N row numbers and quoted cells", () => {
  const event = row(3, "20.11.2026", "14:00", "Roblox room");
  event.cells[11] = 'Комментарий с табом\tи строкой\nпереноса';
  const tsvCell = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const title = Array(14).fill("");
  title[0] = "чё";
  title[1] = "17.11.2026";
  const clipboard = [title, headers, event.cells].map((cells) => cells.map(tsvCell).join("\t")).join("\n");
  const parsed = parseBookingSheetsText(clipboard);
  assert.equal(parsed.sheetId, 0);
  assert.equal(parsed.rows[0].rowNumber, 3);
  assert.deepEqual(parsed.rows[0].cells, event.cells);
  assert.equal(parseBookingSheetsText(JSON.stringify(plan([event]))).rows.length, 1);
});

test("clipboard input refuses shifted headers so it cannot misattribute source rows", () => {
  const clipboard = [headers, row(3, "20.11.2026", "14:00", "Roblox room").cells].map((cells) => cells.join("\t")).join("\n");
  assert.throws(() => parseBookingSheetsText(clipboard), (error) =>
    error instanceof SheetBlockImportError && error.code === "invalid_headers");
});
