import { test } from "node:test";
import assert from "node:assert/strict";
import {
  almatyMinutes,
  isBookableStart,
  overlappingIds,
  parseWorkingHours,
  almatyWindow,
  axisRange,
  axisSpan,
  dayAxis,
  endTimeFor,
  openRequestsForDate,
  paymentLabel,
  remainingKzt,
  windowOverlapsRoom,
  startOptions,
  bookedWithRealPayment,
  samePhone,
} from "../src/core/booking-calendar.ts";

test("parses branch hours and refuses unknown or too-short ranges", () => {
  assert.deepEqual(parseWorkingHours("10:00-23:00"), { openMin: 600, closeMin: 1380 });
  assert.deepEqual(parseWorkingHours("9:00 – 21:00"), { openMin: 540, closeMin: 1260 });
  assert.equal(parseWorkingHours("по договорённости"), null);
  assert.equal(parseWorkingHours(null), null);
  assert.equal(parseWorkingHours("10:00-13:00"), null, "less than four hours cannot hold a party");
});

test("quick starts use strict whole hours and end inside 10:00-22:00 working hours", () => {
  const options = startOptions({ openMin: 600, closeMin: 1320 });
  assert.equal(options[0], "10:00");
  assert.equal(options[1], "11:00");
  assert.equal(options.at(-1), "18:00");
  assert.equal(options.length, 9);
  assert.ok(options.every((time) => time.endsWith(":00")));
});

test("a branch opening between hours offers only the next whole hour", () => {
  const window = { openMin: 10 * 60 + 30, closeMin: 22 * 60 + 30 };
  const options = startOptions(window);
  assert.equal(options[0], "11:00");
  assert.equal(options.at(-1), "18:00");
  assert.equal(isBookableStart("10:30", window), false, "non-hour start is rejected");
  assert.equal(isBookableStart("11:00", window), true);
  assert.equal(isBookableStart("10:00", window), false, "before opening");
});

test("whole-hour start rule rejects 13:45 and 16:15 without rounding", () => {
  const window = { openMin: 600, closeMin: 1320 };
  for (const t of ["10:00", "11:00", "13:00", "14:00", "16:00", "18:00"]) assert.equal(isBookableStart(t, window), true, t);
  for (const t of ["13:45", "16:15", "19:00", "09:00"]) assert.equal(isBookableStart(t, window), false, t);
  assert.equal(isBookableStart("20:00", window), false);
  assert.equal(isBookableStart("25:00", window), false, "not a time of day");
  assert.equal(isBookableStart("13:60", window), false);
  assert.equal(isBookableStart("14:00", null), false);
});

test("the end is always exactly 240 minutes after the start", () => {
  assert.equal(endTimeFor("10:00"), "14:00");
  assert.equal(endTimeFor("11:15"), "15:15");
  assert.equal(endTimeFor("13:30"), "17:30");
  assert.equal(endTimeFor("16:40"), "20:40");
  assert.equal(endTimeFor("nope"), null);
});

test("reads Almaty wall-clock time regardless of the offset in the string", () => {
  // 09:00 UTC is 14:00 in Asia/Almaty (UTC+5, no daylight saving).
  assert.equal(almatyMinutes("2026-10-28T09:00:00Z"), 14 * 60);
  assert.equal(almatyMinutes("2026-10-28T14:00:00+05:00"), 14 * 60);
  assert.equal(almatyMinutes("not a date"), null);
});

// Almaty is UTC+5: 13:00 Almaty is 08:00Z.
const z = (hhmm: string) => `2026-11-16T${String(Number(hhmm.slice(0, 2)) - 5).padStart(2, "0")}:${hhmm.slice(3)}:00Z`;
const axis10to22 = dayAxis({ openMin: 600, closeMin: 1320 }, []);

test("the axis defaults to the journal's 10:00-22:00 and is 720 minutes", () => {
  assert.deepEqual(axis10to22, { startMin: 600, endMin: 1320, minutes: 720 });
  assert.deepEqual(dayAxis(null, []), axis10to22);
});

test("13:00-17:00 starts on the 13:00 mark and ends on 17:00", () => {
  assert.deepEqual(axisSpan(axis10to22, z("13:00"), z("17:00")), { top: 180, height: 240 });
});

test("13:30-17:30 sits between the hour lines", () => {
  assert.deepEqual(axisSpan(axis10to22, z("13:30"), z("17:30")), { top: 210, height: 240 });
});

test("16:40-20:40 keeps its exact position", () => {
  assert.deepEqual(axisSpan(axis10to22, z("16:40"), z("20:40")), { top: 400, height: 240 });
});

test("two adjacent bookings touch but never overlap", () => {
  const first = axisSpan(axis10to22, z("10:00"), z("14:00"))!;
  const second = axisSpan(axis10to22, z("14:00"), z("18:00"))!;
  assert.equal(first.top + first.height, second.top);
  const inRoom = (id: string, a: string, b: string) => ({ id, roomId: "r1", startsAt: z(a), endsAt: z(b) });
  assert.equal(overlappingIds([inRoom("a", "10:00", "14:00"), inRoom("b", "14:00", "18:00")]).size, 0);
  assert.deepEqual([...overlappingIds([inRoom("a", "10:00", "14:00"), inRoom("b", "13:59", "17:59")])].sort(), ["a", "b"], "one minute of overlap is flagged");
});

test("an off-grid reservation widens the axis instead of being cut off", () => {
  const axis = dayAxis({ openMin: 600, closeMin: 1320 }, [{ startsAt: z("09:30"), endsAt: z("13:30") }, { startsAt: z("19:00"), endsAt: z("23:00") }]);
  assert.deepEqual(axis, { startMin: 540, endMin: 1380, minutes: 840 });
  assert.deepEqual(axisSpan(axis, z("09:30"), z("13:30")), { top: 30, height: 240 });
});

test("an end at 00:00 runs to the end of the day; a zero-length interval draws nothing", () => {
  const axis = dayAxis({ openMin: 600, closeMin: 1440 }, []);
  assert.deepEqual(axisSpan(axis, z("20:00"), z("24:00")), { top: 600, height: 240 });
  assert.equal(axisSpan(axis, z("13:00"), z("13:00")), null);
});

test("shades hours outside working time", () => {
  assert.deepEqual(axisRange(dayAxis({ openMin: 600, closeMin: 1380 }, []), 1380, 1440), null, "axis ends at closing");
  assert.deepEqual(axisRange({ startMin: 540, endMin: 1380, minutes: 840 }, 540, 600), { top: 0, height: 60 });
});

test("counts only open birthday requests for the shown date", () => {
  const items = [
    { type: "birthday_request", status: "new", requestedDate: "2026-11-16" },
    { type: "birthday_request", status: "booked", requestedDate: "2026-11-16" },
    { type: "birthday_request", status: "new", requestedDate: "2026-11-17" },
    { type: "support", status: "new", requestedDate: "2026-11-16" },
  ];
  assert.equal(openRequestsForDate(items, "2026-11-16").length, 1);
});

test("payment label reflects only a recorded manual prepayment", () => {
  const fmt = (n: number) => String(n);
  assert.deepEqual(paymentLabel({ paidKzt: 10000, paymentStatus: "prepaid" }, fmt), { tone: "prepaid", text: "предоплата 10000 ₸" });
  assert.equal(paymentLabel({ paidKzt: 0, paymentStatus: "unpaid" }, fmt).tone, "unpaid");
  assert.equal(paymentLabel({ paidKzt: 0, paymentStatus: "prepaid" }, fmt).tone, "unpaid", "prepaid flag without money is not prepaid");
});

test("the remaining amount needs a manager-agreed price", () => {
  assert.equal(remainingKzt({ priceKzt: 50000, priceSource: "manager_agreed", paidKzt: 10000 }), 40000);
  assert.equal(remainingKzt({ priceKzt: 50000, priceSource: "catalog_base", paidKzt: 10000 }), null);
  assert.equal(remainingKzt({ priceKzt: null, priceSource: null, paidKzt: 0 }), null);
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

test("a confirmed reservation is verified only with a real manual prepayment on the request", () => {
  const confirmedUnpaid = { status: "confirmed", paidKzt: 0, paymentStatus: "unpaid" };
  const paidConfirmed = { status: "confirmed", paidKzt: 20000, paymentStatus: "prepaid" };
  const bookedWithFact = { bookedAt: "2026-11-20T10:00:00Z", manualPaymentFactStatus: "prepaid" as const, manualPaymentFactAmountKzt: 20000 };
  const bookedNoFact = { bookedAt: "2026-11-20T10:00:00Z", manualPaymentFactStatus: "unpaid" as const, manualPaymentFactAmountKzt: 0 };
  // An existing confirmed reservation with no money recorded is not a verified success, whatever the request says.
  assert.equal(bookedWithRealPayment(confirmedUnpaid, bookedWithFact), false, "reservation shows no payment");
  assert.equal(bookedWithRealPayment(confirmedUnpaid, null), false, "no FastAPI read-back");
  // Paid on the reservation, but the request has no booking or no fact in FastAPI.
  assert.equal(bookedWithRealPayment(paidConfirmed, { ...bookedWithFact, bookedAt: null }), false, "request not booked");
  assert.equal(bookedWithRealPayment(paidConfirmed, bookedNoFact), false, "no manual payment fact");
  assert.equal(bookedWithRealPayment({ status: "released", paidKzt: 20000, paymentStatus: "prepaid" }, bookedWithFact), false, "released");
  assert.equal(bookedWithRealPayment(paidConfirmed, bookedWithFact), true);
});

test("phones compare by digits", () => {
  assert.equal(samePhone("+7 700 111-22-33", "77001112233"), true);
  assert.equal(samePhone("+7 700 111-22-34", "77001112233"), false);
  assert.equal(samePhone("12", "12"), false, "too short to be a phone");
});
