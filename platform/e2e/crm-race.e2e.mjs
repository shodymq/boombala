// Race E2E against the real FastAPI kernel. The first session runs the real booking flow code; between its pre-check and its
// confirmation, a second staff session takes the same room and time through FastAPI. The first confirmation must come back
// as the kernel's time_conflict, keep the one manual payment fact, and the same paid request must then be confirmed elsewhere
// without a new payment.
//   E2E_FASTAPI_BASE_URL, E2E_CRM_SERVICE_TOKEN, E2E_CRM_STAFF_ASSERTION_SECRET, FASTAPI_DATABASE_URL, E2E_RACE_DATE
import pg from "pg";
import { FastApiCrmClient } from "../src/server/fastapi-crm.ts";
import { confirmPaidRequestFlow } from "../src/server/crm-flows.ts";
import { lead, paidUnconfirmedRequest, staffToken, api } from "./support/crm-fastapi.mjs";

process.env.UNIFIED_FASTAPI_CRM_ENABLED = "1";
process.env.FASTAPI_ADMIN_BASE_URL ??= process.env.E2E_FASTAPI_BASE_URL ?? "http://127.0.0.1:8000";
const DATE = process.env.E2E_RACE_DATE ?? "2026-11-21";
const BRANCH = "stg-almaty";
const PACKAGE = "stg-pkg-start";
const ROOM_A = "stg-room-a";
const ROOM_B = "stg-room-b";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const tokenA = await staffToken({ email: "manager-a@staging.boombala.example.com", staffId: "stg-manager-a" });
const tokenB = await staffToken({ email: "manager-b@staging.boombala.example.com", staffId: "stg-manager-b" });
const db = new pg.Client({ connectionString: process.env.FASTAPI_DATABASE_URL.replace("postgresql+psycopg://", "postgresql://") });
await db.connect();

// The paid request for session A: 20 000 ₸ recorded, nothing confirmed yet.
const requestId = await paidUnconfirmedRequest(tokenA, { branchId: BRANCH, packageId: PACKAGE, amountKzt: 20000, customerName: "Гонка A" });
const clientA = new FastApiCrmClient({ accessToken: tokenA, requestId: crypto.randomUUID() });
const clientB = new FastApiCrmClient({ accessToken: tokenB, requestId: crypto.randomUUID() });

// Session A's client, with one hook: after its pre-check has read a clear timeline, session B takes Room A at 16:00.
const hooked = Object.create(clientA);
let raced = false;
hooked.getBookingTimeline = async (...args) => {
  const timeline = await clientA.getBookingTimeline(...args);
  if (!raced) {
    raced = true;
    const rivalRequest = await paidUnconfirmedRequest(tokenB, { branchId: BRANCH, packageId: PACKAGE, amountKzt: 10000, customerName: "Гонка B" });
    await clientB.confirmBooking({
      requestId: rivalRequest,
      bookingDate: DATE,
      roomId: ROOM_A,
      startTime: "16:00",
      packageId: PACKAGE,
      agreedPriceKzt: 150000,
      idempotencyKey: `race-${rivalRequest}:confirm`,
    });
  }
  return timeline;
};

const first = await confirmPaidRequestFlow(hooked, {
  requestId,
  branchId: BRANCH,
  date: DATE,
  roomId: ROOM_A,
  startTime: "16:00",
  packageId: PACKAGE,
  agreedPriceKzt: 150000,
  idempotencyKey: `race-a-${requestId}`,
});
check("the rival session took Room A 16:00 after A's pre-check", raced);
check("A's confirmation comes back as the kernel's time_conflict (not success)", first.ok === false && first.code === "time_conflict", JSON.stringify(first));

const afterRace = await lead(tokenA, requestId);
check("paid request stays unbooked after the 409", afterRace.body?.bookedAt === null, `bookedAt=${afterRace.body?.bookedAt}`);
check("the 20 000 ₸ payment fact is kept", afterRace.body?.manualPaymentFactAmountKzt === 20000 && afterRace.body?.manualPaymentFactStatus === "prepaid");
const facts = await db.query("SELECT count(*)::int AS n, sum(amount_kzt)::int AS total FROM birthday_payment_facts WHERE birthday_request_id = $1", [requestId]);
check("DB: exactly one payment fact for the paid request", facts.rows[0].n === 1 && facts.rows[0].total === 20000, JSON.stringify(facts.rows[0]));

// Confirm the same paid request in another room and time: no new payment, success.
const second = await confirmPaidRequestFlow(clientA, {
  requestId,
  branchId: BRANCH,
  date: DATE,
  roomId: ROOM_B,
  startTime: "18:00",
  packageId: PACKAGE,
  agreedPriceKzt: 150000,
  idempotencyKey: `race-a2-${requestId}`,
});
check("the paid request is confirmed elsewhere without repaying", second.ok === true, JSON.stringify(second));
const afterConfirm = await lead(tokenA, requestId);
const facts2 = await db.query("SELECT count(*)::int AS n FROM birthday_payment_facts WHERE birthday_request_id = $1", [requestId]);
check("after confirmation: still one payment fact and the request is booked", facts2.rows[0].n === 1 && afterConfirm.body?.bookedAt !== null);

// Replaying the same confirmation key returns the saved result; it does not create a second booking.
const replay = await api(tokenA, "POST", "/admin/birthday-bookings/confirm", {
  requestId, bookingDate: DATE, roomId: ROOM_B, startTime: "18:00", packageId: PACKAGE, agreedPriceKzt: 150000, idempotencyKey: `race-a2-${requestId}:confirm`,
});
check("replaying the same confirm key does not create another reservation", replay.status === 200 || replay.status === 409, `status=${replay.status}`);
const reservations = await db.query("SELECT count(*)::int AS n FROM birthday_slot_reservations WHERE birthday_request_id = $1 AND kind = 'booking' AND released_at IS NULL", [requestId]);
check("DB: one active reservation for the paid request", reservations.rows[0].n === 1, `n=${reservations.rows[0].n}`);

await db.end();
if (process.env.E2E_ARTIFACTS) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true });
  writeFileSync(`${process.env.E2E_ARTIFACTS}/race-results.json`, JSON.stringify({ at: new Date().toISOString(), date: DATE, results }, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
