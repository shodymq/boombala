import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastApiCrmError } from "../src/server/fastapi-crm.ts";
import {
  confirmPaidRequestFlow,
  createBookingRequestFlow,
  recordManualPrepaymentFlow,
  type BookingWriter,
  type ConfirmPaidInput,
  type CreateBookingRequestInput,
  type RecordPrepaymentInput,
} from "../src/server/crm-flows.ts";

function fakeWriter(options: {
  conflict?: boolean;
  dropPaymentResponse?: boolean;
  dropConfirmationResponse?: boolean;
  status?: string;
  timelineBranchId?: string;
  timelineRooms?: { id: string; occupancyMode?: string }[];
  timelineReservations?: { id: string; roomId: string; startsAt: string; endsAt: string; occupiedEndsAt: string; status: string }[];
  confirmationError?: Error;
} = {}) {
  const calls: string[] = [];
  const confirmBodies: Record<string, unknown>[] = [];
  const requests = new Map<string, string>();
  const paymentKeys = new Map<string, unknown>();
  const confirmationKeys = new Map<string, { id: string }>();
  let payment: { amountKzt: number; method: string } | null = null;
  let reservation: { id: string } | null = null;
  let confirmationWrites = 0;
  let leadStatus = options.status ?? "new";
  let queue = Promise.resolve();
  const writer = {
    async getBookingTimeline(branchId: string) {
      calls.push("timeline");
      return {
        branchId: options.timelineBranchId ?? branchId,
        bufferMinutes: 0,
        rooms: options.timelineRooms ?? [{ id: "room-a", occupancyMode: "exclusive" }, { id: "room-b", occupancyMode: "exclusive" }],
        reservations: options.timelineReservations ?? [],
      };
    },
    async createStaffRequest(body: Record<string, unknown>) {
      calls.push("request");
      const key = String(body.idempotencyKey);
      const prior = requests.get(key);
      if (prior) return { id: prior };
      requests.set(key, "req-1");
      leadStatus = "new";
      return { id: "req-1" };
    },
    async getBirthdayLead(id: string) {
      calls.push("lead");
      return { id, status: leadStatus, bookedAt: reservation ? "2026-11-20T09:00:00Z" : null, manualPaymentFactStatus: payment ? "prepaid" as const : "unpaid" as const, manualPaymentFactAmountKzt: payment?.amountKzt ?? 0, customerName: "Synthetic" };
    },
    async recordManualPaymentAndRead(id: string, body: Record<string, unknown>) {
      calls.push("payment");
      let release!: () => void;
      const priorWrite = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await priorWrite;
      try {
      const key = String(body.idempotencyKey);
      const prior = paymentKeys.get(key);
      if (!prior && !payment) payment = { amountKzt: Number(body.amountKzt), method: String(body.method) };
      paymentKeys.set(key, payment);
      if (options.dropPaymentResponse) {
        options.dropPaymentResponse = false;
        throw new TypeError("simulated response loss after commit");
      }
      return {
        payment,
        lead: { id, status: leadStatus, bookedAt: null, manualPaymentFactStatus: payment ? "prepaid" as const : "unpaid" as const, manualPaymentFactAmountKzt: payment?.amountKzt ?? 0, customerName: "Synthetic" },
      };
      } finally {
        release();
      }
    },
    async confirmBooking(body: Record<string, unknown>) {
      calls.push("confirm");
      confirmBodies.push(body);
      if (options.confirmationError) throw options.confirmationError;
      if (!payment || payment.amountKzt !== 10_000) throw new FastApiCrmError(422, "birthday_prepayment_required", "fake");
      const key = String(body.idempotencyKey);
      const prior = confirmationKeys.get(key);
      if (prior) return prior;
      if (options.conflict) throw new FastApiCrmError(409, "time_conflict", "fake");
      reservation ??= { id: `reservation-${key}` };
      confirmationKeys.set(key, reservation);
      confirmationWrites += 1;
      leadStatus = "confirmed";
      if (options.dropConfirmationResponse) {
        options.dropConfirmationResponse = false;
        throw new TypeError("simulated response loss after commit");
      }
      return reservation;
    },
  };
  return {
    writer: writer as unknown as BookingWriter,
    calls,
    confirmBodies,
    allowConfirmation: () => { options.conflict = false; },
    paymentFacts: () => payment ? 1 : 0,
    reservations: () => reservation ? 1 : 0,
    confirmationWrites: () => confirmationWrites,
  };
}

const createInput: CreateBookingRequestInput = {
  branchId: "almaty",
  requestedDate: "2026-11-20",
  packageId: "star-party",
  customerName: "Synthetic Customer",
  phone: "+77001112233",
  guestCount: 8,
  idempotencyKey: "request-key-001",
};
const paymentInput: RecordPrepaymentInput = {
  requestId: "req-1",
  amountKzt: 10_000,
  method: "cash",
  idempotencyKey: "payment-key-001",
};
const confirmInput: ConfirmPaidInput = {
  requestId: "req-1",
  branchId: "almaty",
  date: "2026-11-20",
  roomId: "room-a",
  startTime: "14:00",
  packageId: "star-party",
  agreedPriceKzt: 79_900,
  idempotencyKey: "confirm-key-001",
};

describe("manual payment is a distinct, explicit step", () => {
  it("request creation creates no payment fact and no reservation, including idempotent retry", async () => {
    const fake = fakeWriter();
    const first = await createBookingRequestFlow(fake.writer, createInput);
    const retry = await createBookingRequestFlow(fake.writer, createInput);
    assert.deepEqual(first, { ok: true, requestId: "req-1" });
    assert.deepEqual(retry, first);
    assert.equal(fake.paymentFacts(), 0);
    assert.equal(fake.reservations(), 0);
    assert.deepEqual(fake.calls, ["request", "request"]);
  });

  it("a separately recorded receipt creates exactly one fact; a second call does not write again", async () => {
    const fake = fakeWriter();
    const first = await recordManualPrepaymentFlow(fake.writer, paymentInput);
    const retry = await recordManualPrepaymentFlow(fake.writer, { ...paymentInput, idempotencyKey: "payment-key-002" });
    assert.deepEqual(first, { ok: true, requestId: "req-1", amountKzt: 10_000, alreadyRecorded: false });
    assert.deepEqual(retry, { ok: true, requestId: "req-1", amountKzt: 10_000, alreadyRecorded: true });
    assert.equal(fake.paymentFacts(), 1);
    assert.equal(fake.reservations(), 0);
    assert.equal(fake.calls.filter((c) => c === "payment").length, 1);
  });

  it("two managers recording the same request at once leave one append-only fact", async () => {
    const fake = fakeWriter();
    const [first, second] = await Promise.all([
      recordManualPrepaymentFlow(fake.writer, paymentInput),
      recordManualPrepaymentFlow(fake.writer, { ...paymentInput, idempotencyKey: "payment-key-manager-b" }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fake.paymentFacts(), 1);
  });

  it("a retry after the payment committed but its response was lost leaves one fact", async () => {
    const fake = fakeWriter({ dropPaymentResponse: true });
    const first = await recordManualPrepaymentFlow(fake.writer, paymentInput);
    assert.deepEqual(first, { ok: false, code: "unavailable", requestId: "req-1" });
    const retry = await recordManualPrepaymentFlow(fake.writer, { ...paymentInput, idempotencyKey: "payment-key-new" });
    assert.deepEqual(retry, { ok: true, requestId: "req-1", amountKzt: 10_000, alreadyRecorded: true });
    assert.equal(fake.paymentFacts(), 1);
    assert.equal(fake.calls.filter((c) => c === "payment").length, 1);
  });

  it("confirmation without a backend payment fact is refused and does not occupy a room", async () => {
    const fake = fakeWriter();
    const result = await confirmPaidRequestFlow(fake.writer, confirmInput);
    assert.deepEqual(result, { ok: false, code: "birthday_prepayment_required", requestId: "req-1" });
    assert.equal(fake.paymentFacts(), 0);
    assert.equal(fake.reservations(), 0);
    assert.deepEqual(fake.calls, ["lead"]);
  });

  it("a room conflict after receipt keeps the fact; a new free slot confirms without another payment", async () => {
    const fake = fakeWriter({ conflict: true });
    const received = await recordManualPrepaymentFlow(fake.writer, paymentInput);
    assert.equal(received.ok, true);
    const conflict = await confirmPaidRequestFlow(fake.writer, confirmInput);
    assert.deepEqual(conflict, { ok: false, code: "time_conflict", requestId: "req-1" });
    assert.equal(fake.paymentFacts(), 1);
    assert.equal(fake.reservations(), 0);

    fake.allowConfirmation();
    const moved = await confirmPaidRequestFlow(fake.writer, { ...confirmInput, roomId: "room-b", startTime: "18:00" });
    assert.equal(moved.ok, true);
    if (moved.ok) assert.match(moved.reservationId, /^reservation-/);
    else assert.fail("expected alternate slot to confirm");
    assert.equal(fake.paymentFacts(), 1);
    assert.notEqual(fake.confirmBodies[0].idempotencyKey, fake.confirmBodies[1].idempotencyKey, "changing the target slot creates a new confirmation idempotency key");
  });

  it("a known occupied interval is refused before the confirmation write", async () => {
    const fake = fakeWriter({
      timelineReservations: [{ id: "occupied", roomId: "room-a", startsAt: "2026-11-20T09:00:00+05:00", endsAt: "2026-11-20T13:00:00+05:00", occupiedEndsAt: "2026-11-20T13:00:00+05:00", status: "confirmed" }],
    });
    await recordManualPrepaymentFlow(fake.writer, paymentInput);
    const result = await confirmPaidRequestFlow(fake.writer, { ...confirmInput, startTime: "12:00" });
    assert.deepEqual(result, { ok: false, code: "time_conflict", requestId: "req-1" });
    assert.equal(fake.paymentFacts(), 1, "the previously received payment remains recorded");
    assert.equal(fake.confirmationWrites(), 0, "known conflict never reaches the booking writer");
  });

  it("adjacent four-hour bookings remain allowed with no extra preparation buffer", async () => {
    const fake = fakeWriter({
      timelineReservations: [{ id: "occupied", roomId: "room-a", startsAt: "2026-11-20T09:00:00+05:00", endsAt: "2026-11-20T13:00:00+05:00", occupiedEndsAt: "2026-11-20T14:00:00+05:00", status: "confirmed" }],
    });
    await recordManualPrepaymentFlow(fake.writer, paymentInput);
    const result = await confirmPaidRequestFlow(fake.writer, { ...confirmInput, startTime: "13:00" });
    assert.equal(result.ok, true, "occupiedEndsAt compatibility metadata cannot add a buffer to the four-hour interval");
    assert.equal(fake.confirmationWrites(), 1);
  });

  it("a room outside the selected branch timeline is refused before confirmation", async () => {
    const fake = fakeWriter({ timelineBranchId: "almaty" });
    await recordManualPrepaymentFlow(fake.writer, paymentInput);
    const result = await confirmPaidRequestFlow(fake.writer, { ...confirmInput, branchId: "foreign-branch", roomId: "room-a" });
    assert.deepEqual(result, { ok: false, code: "forbidden", requestId: "req-1" });
    assert.equal(fake.confirmationWrites(), 0);
  });

  it("a committed confirmation whose response is lost is not duplicated on retry", async () => {
    const fake = fakeWriter({ dropConfirmationResponse: true });
    await recordManualPrepaymentFlow(fake.writer, paymentInput);
    const first = await confirmPaidRequestFlow(fake.writer, confirmInput);
    assert.deepEqual(first, { ok: false, code: "unavailable", requestId: "req-1" });
    const retry = await confirmPaidRequestFlow(fake.writer, confirmInput);
    assert.deepEqual(retry, { ok: false, code: "request_already_booked", requestId: "req-1" }, "backend state is authoritative after the lost response");
    assert.equal(fake.confirmationWrites(), 1);
    assert.equal(fake.paymentFacts(), 1);
    assert.equal(fake.reservations(), 1);
    assert.equal(fake.confirmBodies.length, 1, "the retry reads the committed booking and does not issue another write");
  });

  it("reauthentication errors escape confirmation so the caller can refresh the bridge token", async () => {
    const fake = fakeWriter({ confirmationError: new FastApiCrmError(401, "token_expired", "synthetic") });
    await recordManualPrepaymentFlow(fake.writer, paymentInput);
    await assert.rejects(
      confirmPaidRequestFlow(fake.writer, confirmInput),
      (error: unknown) => error instanceof FastApiCrmError && error.status === 401,
    );
    assert.equal(fake.confirmationWrites(), 0);
  });

  it("does not record money for a closed or already booked request", async () => {
    const closed = fakeWriter({ status: "cancelled" });
    assert.deepEqual(await recordManualPrepaymentFlow(closed.writer, paymentInput), { ok: false, code: "birthday_request_not_payable", requestId: "req-1" });
    assert.equal(closed.paymentFacts(), 0);
    const booked = fakeWriter();
    await recordManualPrepaymentFlow(booked.writer, paymentInput);
    await confirmPaidRequestFlow(booked.writer, confirmInput);
    assert.deepEqual(await recordManualPrepaymentFlow(booked.writer, paymentInput), { ok: false, code: "request_already_booked", requestId: "req-1" });
    assert.equal(booked.paymentFacts(), 1);
  });
});
