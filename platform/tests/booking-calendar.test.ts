import { test } from "node:test";
import assert from "node:assert/strict";
import {
  almatyMinutes,
  isBookableStart,
  overlappingIds,
  parseWorkingHours,
  almatyWindow,
  gridColumn,
  gridRangeColumns,
  windowOverlapsRoom,
  startOptions,
} from "../src/core/booking-calendar.ts";

test("parses branch hours and refuses unknown or too-short ranges", () => {
  assert.deepEqual(parseWorkingHours("10:00-23:00"), { openMin: 600, closeMin: 1380 });
  assert.deepEqual(parseWorkingHours("9:00 – 21:00"), { openMin: 540, closeMin: 1260 });
  assert.equal(parseWorkingHours("по договорённости"), null);
  assert.equal(parseWorkingHours(null), null);
  assert.equal(parseWorkingHours("10:00-13:00"), null, "less than four hours cannot hold a party");
});

test("start options use a 15-minute step and end inside working hours", () => {
  const options = startOptions({ openMin: 600, closeMin: 1380 });
  assert.equal(options[0], "10:00");
  assert.equal(options[1], "10:15");
  assert.equal(options.at(-1), "19:00");
  assert.equal(options.length, (1380 - 600 - 240) / 15 + 1);
});

test("a start must be on the step and fit the window", () => {
  const window = { openMin: 600, closeMin: 1380 };
  assert.equal(isBookableStart("14:00", window), true);
  assert.equal(isBookableStart("14:10", window), false);
  assert.equal(isBookableStart("19:15", window), false, "19:15 + 4h runs past closing");
  assert.equal(isBookableStart("09:45", window), false);
  assert.equal(isBookableStart("14:00", null), false);
});

test("reads Almaty wall-clock time regardless of the offset in the string", () => {
  // 09:00 UTC is 14:00 in Asia/Almaty (UTC+5, no daylight saving).
  assert.equal(almatyMinutes("2026-10-28T09:00:00Z"), 14 * 60);
  assert.equal(almatyMinutes("2026-10-28T14:00:00+05:00"), 14 * 60);
  assert.equal(almatyMinutes("not a date"), null);
});

test("places a reservation on the 15-minute grid and clips it to the day", () => {
  // 09:00 Almaty is grid column 1; 14:00 is column 21; four hours span 16 columns.
  assert.deepEqual(gridColumn("2026-10-28T09:00:00Z", "2026-10-28T13:00:00Z"), { start: 1 + 5 * 4, span: 16 });
  assert.deepEqual(gridColumn("2026-10-28T03:00:00Z", "2026-10-28T06:00:00Z"), { start: 1, span: 8 }, "08:00-11:00 is clipped to start at 09:00");
  assert.equal(gridColumn("2026-10-28T02:00:00Z", "2026-10-28T03:00:00Z"), null, "03:00-04:00 Almaty is before the grid");
  // 18:00 to midnight Almaty: an end at 00:00 means the end of the day.
  assert.deepEqual(gridColumn("2026-10-28T13:00:00Z", "2026-10-28T19:00:00Z"), { start: 37, span: 24 });
  // A zero-length interval (no buffer) draws nothing; it must not run to midnight.
  assert.equal(gridColumn("2026-10-28T13:00:00Z", "2026-10-28T13:00:00Z"), null);
});

test("shades hours outside working time as grid columns", () => {
  assert.deepEqual(gridRangeColumns(9 * 60, 10 * 60), { start: 1, span: 4 });
  assert.equal(gridRangeColumns(23 * 60, 24 * 60 + 0) !== null, true);
  assert.equal(gridRangeColumns(5, 5), null);
});

test("flags overlapping intervals in the same room only", () => {
  const flagged = overlappingIds([
    { id: "a", roomId: "r1", startsAt: "2026-10-28T09:00:00Z", endsAt: "2026-10-28T13:00:00Z" },
    { id: "b", roomId: "r1", startsAt: "2026-10-28T12:00:00Z", endsAt: "2026-10-28T16:00:00Z" },
    { id: "c", roomId: "r2", startsAt: "2026-10-28T09:00:00Z", endsAt: "2026-10-28T13:00:00Z" },
    { id: "d", roomId: "r1", startsAt: "2026-10-28T16:00:00Z", endsAt: "2026-10-28T20:00:00Z" },
  ]);
  assert.deepEqual([...flagged].sort(), ["a", "b"], "touching intervals (13:00) are not an overlap");
});

test("refuses a window that overlaps an active reservation in the same room", () => {
  const taken = [{ roomId: "r1", startsAt: "2026-11-02T08:00:00Z", endsAt: "2026-11-02T12:00:00Z", status: "confirmed" }];
  const at = (start: string) => almatyWindow("2026-11-02", start);
  // 14:00 Almaty is 09:00Z; the taken 08:00Z-12:00Z is 13:00-17:00 Almaty.
  assert.equal(windowOverlapsRoom(taken, "r1", at("16:00").startIso, at("16:00").endIso), true);
  assert.equal(windowOverlapsRoom(taken, "r1", at("17:00").startIso, at("17:00").endIso), false, "starting when the other ends is free");
  assert.equal(windowOverlapsRoom(taken, "r2", at("16:00").startIso, at("16:00").endIso), false, "another room is free");
  const released = [{ ...taken[0], status: "released" }];
  assert.equal(windowOverlapsRoom(released, "r1", at("16:00").startIso, at("16:00").endIso), false);
});
