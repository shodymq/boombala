import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastApiCrmError } from "../src/server/fastapi-crm.ts";
import { confirmPaidRequestFlow, createBookingFlow, type BookingWriter, type NewBookingInput } from "../src/server/crm-flows.ts";

/** A FastAPI stand-in that records every write. `timeline` decides the pre-check; `confirm` decides the kernel. */
function fakeWriter(options: { reservations?: unknown[]; confirm?: () => unknown } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const writer = {
    async getBookingTimeline(...args: unknown[]) {
      calls.push({ op: "timeline", args });
      return { bufferMinutes: 0, reservations: options.reservations ?? [] };
    },
    async createStaffRequest(body: Record<string, unknown>) {
      calls.push({ op: "request", args: [body] });
      return { id: "req-1" };
    },
    async recordManualPayment(id: string, body: Record<string, unknown>) {
      calls.push({ op: "payment", args: [id, body] });
      return { id: "pay-1" };
    },
    async confirmBooking(body: Record<string, unknown>) {
      calls.push({ op: "confirm", args: [body] });
      return options.confirm ? options.confirm() : { id: "res-1" };
    },
  };
  return { writer: writer as unknown as BookingWriter, calls, ops: () => calls.map((c) => c.op) };
}

const input: NewBookingInput = {
  branchId: "stg-almaty",
  date: "2026-11-20",
  roomId: "stg-room-a",
  startTime: "14:00",
  packageId: "stg-pkg-start",
  customerName: "Тест",
  phone: "+77001112233",
  agreedPriceKzt: 180000,
  prepaymentKzt: 20000,
  prepaymentMethod: "cash",
  idempotencyKey: "key-aaaaaaaa",
};

const occupied14to18 = [
  { id: "r1", kind: "booking", status: "confirmed", roomId: "stg-room-a", startsAt: "2026-11-20T14:00:00+05:00", endsAt: "2026-11-20T18:00:00+05:00", occupiedEndsAt: "2026-11-20T18:00:00+05:00" },
];

const kernel409 = () => {
  throw new FastApiCrmError(409, "time_conflict", "kernel");
};

describe("booking flows: pre-check and kernel decisions", () => {
  it("a known conflict is refused before any request or payment is written", async () => {
    const fake = fakeWriter({ reservations: occupied14to18 });
    const result = await createBookingFlow(fake.writer, { ...input, startTime: "16:00" });
    assert.deepEqual(result, { ok: false, code: "time_conflict", requestId: null });
    assert.deepEqual(fake.ops(), ["timeline"], "nothing written after the pre-check refused");
  });

  it("a confirmation refused by the kernel after the payment keeps the request id and writes the payment once", async () => {
    const fake = fakeWriter({ confirm: kernel409 });
    const result = await createBookingFlow(fake.writer, input);
    assert.deepEqual(result, { ok: false, code: "time_conflict", requestId: "req-1" });
    assert.deepEqual(fake.ops(), ["timeline", "request", "payment", "confirm"]);
  });

  it("a race: the pre-check passes, another session takes the room, the kernel refuses the confirmation", async () => {
    // The pre-check is clear when read; the conflicting booking lands before the confirmation is sent.
    const fake = fakeWriter({ confirm: kernel409 });
    const result = await confirmPaidRequestFlow(fake.writer, { requestId: "req-paid", branchId: "stg-almaty", date: "2026-11-20", roomId: "stg-room-a", startTime: "16:00", packageId: "stg-pkg-start", agreedPriceKzt: 150000, idempotencyKey: "key-bbbbbbbb" });
    assert.deepEqual(result, { ok: false, code: "time_conflict", requestId: "req-paid" });
    assert.deepEqual(fake.ops(), ["timeline", "confirm"], "confirm-only: no request and no payment are written");
  });
});

describe("booking flows: no repeated money", () => {
  it("the confirm-only action never creates a request or a payment fact", async () => {
    const fake = fakeWriter();
    const result = await confirmPaidRequestFlow(fake.writer, { requestId: "req-paid", branchId: "stg-almaty", date: "2026-11-20", roomId: "stg-room-b", startTime: "18:00", packageId: "stg-pkg-start", agreedPriceKzt: 150000, idempotencyKey: "key-cccccccc" });
    assert.equal(result.ok, true);
    assert.ok(!fake.ops().includes("request") && !fake.ops().includes("payment"));
    assert.equal((fake.calls.at(-1)?.args[0] as { idempotencyKey: string }).idempotencyKey, "key-cccccccc:confirm");
  });

  it("a double submit replays the same derived keys, so the server replays instead of adding records", async () => {
    const first = fakeWriter();
    const second = fakeWriter();
    await createBookingFlow(first.writer, input);
    await createBookingFlow(second.writer, input);
    const keysOf = (f: ReturnType<typeof fakeWriter>) => ({
      request: (f.calls.find((c) => c.op === "request")?.args[0] as { idempotencyKey: string }).idempotencyKey,
      payment: (f.calls.find((c) => c.op === "payment")?.args[1] as { idempotencyKey: string }).idempotencyKey,
      confirm: (f.calls.find((c) => c.op === "confirm")?.args[0] as { idempotencyKey: string }).idempotencyKey,
    });
    assert.deepEqual(keysOf(first), keysOf(second));
    assert.deepEqual(keysOf(first), { request: "key-aaaaaaaa:request", payment: "key-aaaaaaaa:payment", confirm: "key-aaaaaaaa:confirm" });
  });
});

describe("booking flows: token expiry", () => {
  it("a 401 is rethrown so the caller can issue a fresh bridge token and retry", async () => {
    const fake = fakeWriter({ confirm: () => { throw new FastApiCrmError(401, "token_expired", "x"); } });
    await assert.rejects(createBookingFlow(fake.writer, input), (error: unknown) => error instanceof FastApiCrmError && error.status === 401);
  });
});
