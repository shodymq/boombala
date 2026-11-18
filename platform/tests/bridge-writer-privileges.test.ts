import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";
import { applyRoles } from "../scripts/db-roles.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { almatyToday } from "../src/core/dates.ts";
import type { ValidSession } from "../src/core/session.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

/**
 * The booking writer runs as bb_admin with EXACTLY the privileges db:roles grants (append-only tables: SELECT and INSERT only,
 * no UPDATE). Every operation below goes through that role, including the concurrent ones: idempotency and one-payment-per-request
 * must hold through the advisory transaction lock, the parent request row lock and the unique constraints, not through row
 * locks on the append-only tables.
 */
// Next's request helpers do not exist outside a Next request: resolve them to stubs, then load the writer.
register("./helpers/next-stub-hooks.mjs", import.meta.url);
const { bridgeBlock, bridgeConfirm, bridgeCreateRequest, bridgePayment, bridgeRelease, bridgeReschedule } = await import("../src/server/legacy-bridge.ts");

const plus = (days: number) => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const key = () => `k-${randomUUID()}`;

describe("booking writer under the exact production bb_admin privileges", () => {
  let db: TestDb;
  let admin: Pool;
  let session: ValidSession;
  let pkg: string;
  let rooms: string[];
  const day = 20;

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    await applyRoles(db.pool, { apiPassword: randomBytes(12).toString("hex") + "A1", adminPassword: "adm" + randomBytes(12).toString("hex") + "B2" });
    // applyRoles sets the password it was given; connect as bb_admin with a password we set explicitly here.
    const password = "adm" + randomBytes(12).toString("hex");
    await db.pool.query(`ALTER ROLE bb_admin PASSWORD '${password}'`);
    const url = new URL(db.url);
    url.username = "bb_admin";
    url.password = password;
    admin = createPool(url.toString(), { max: 16 });
    const manager = await makeUser(db.pool, "manager");
    session = { user: { id: manager.id, role: "manager", name: "m", email: "m@example.test" }, sessionId: "s" } as unknown as ValidSession;
    pkg = (await db.pool.query("SELECT id FROM bb.packages WHERE is_active ORDER BY sort_order LIMIT 1")).rows[0].id;
    rooms = (await db.pool.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order")).rows.map((r) => r.id);
  });
  after(async () => {
    await admin.end();
    await db.stop();
  });

  const newRequest = async (name = "Тест Гость", suffix = Math.floor(Math.random() * 9_000_000) + 1_000_000) =>
    bridgeCreateRequest(admin, session, { idempotencyKey: key(), requestedDate: plus(day), customerName: name, phone: `+7707${suffix}`, packageId: pkg, guestCount: 8 }) as Promise<{ id: string }>;
  const pay = (requestId: string, idempotencyKey = key(), method = "cash") => bridgePayment(admin, session, { requestId, idempotencyKey, amountKzt: 10000, method }) as Promise<{ id: string }>;
  const confirm = (requestId: string, roomId: string, startTime: string, date = plus(day)) =>
    bridgeConfirm(admin, session, { requestId, idempotencyKey: key(), bookingDate: date, roomId, startTime, packageId: pkg, agreedPriceKzt: 150000 }) as Promise<{ id: string }>;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.pool.query(sql, params)).rows[0].n);

  it("the role has exactly the production privileges on the append-only tables", async () => {
    for (const t of ["booking_operations", "manual_payment_facts"]) {
      const { rows } = await db.pool.query(
        `SELECT has_table_privilege('bb_admin', 'bb.${t}', 'SELECT') s, has_table_privilege('bb_admin', 'bb.${t}', 'INSERT') i,
                has_table_privilege('bb_admin', 'bb.${t}', 'UPDATE') u, has_table_privilege('bb_admin', 'bb.${t}', 'DELETE') d`);
      assert.deepEqual(rows[0], { s: true, i: true, u: false, d: false }, t);
    }
    await assert.rejects(admin.query("SELECT 1 FROM bb.booking_operations FOR UPDATE"), /permission denied/, "a row lock needs UPDATE, which bb_admin must not have");
  });

  it("create, payment, confirmation, block, reschedule and cancel all work as bb_admin", async () => {
    const lead = await newRequest();
    const payment = await pay(lead.id);
    assert.ok(payment.id);
    const booked = await confirm(lead.id, rooms[0], "14:25");
    const moved = (await bridgeReschedule(admin, session, { idempotencyKey: key(), reservationId: booked.id, bookingDate: plus(day), roomId: rooms[1], startTime: "11:10" })) as { id: string };
    const block = (await bridgeBlock(admin, session, { idempotencyKey: key(), bookingDate: plus(day), roomId: rooms[2], startTime: "15:35", reason: "e2e" })) as { id: string };
    await bridgeRelease(admin, session, { idempotencyKey: key(), reservationId: moved.id, reason: "cancel" });
    await bridgeRelease(admin, session, { idempotencyKey: key(), reservationId: block.id, reason: "unblock" });
    const row = (await db.pool.query("SELECT status FROM bb.lead_requests WHERE id = $1", [lead.id])).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(await count("SELECT count(*)::int n FROM bb.slot_reservations WHERE lead_request_id = $1 AND released_at IS NULL", [lead.id]), 0);
    assert.equal(await count("SELECT count(*)::int n FROM bb.booking_operations WHERE created_by = $1", [session.user.id]) >= 7, true);
  });

  it("the same idempotency key sent concurrently writes one payment and returns one answer", async () => {
    const lead = await newRequest();
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(lead.id, k)));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(await count("SELECT count(*)::int n FROM bb.manual_payment_facts WHERE lead_request_id = $1", [lead.id]), 1);
    assert.equal(await count("SELECT count(*)::int n FROM bb.booking_operations WHERE idempotency_key = $1", [k]), 1);
  });

  it("different keys for the same request: one payment fact, no deadlock, the others replay it", async () => {
    const lead = await newRequest();
    const results = await Promise.all(Array.from({ length: 8 }, () => pay(lead.id, key())));
    assert.equal(new Set(results.map((r) => r.id)).size, 1, "every caller sees the one fact");
    assert.equal(await count("SELECT count(*)::int n FROM bb.manual_payment_facts WHERE lead_request_id = $1", [lead.id]), 1);
  });

  it("a conflicting payment method for an already paid request is refused", async () => {
    const lead = await newRequest();
    await pay(lead.id, key(), "cash");
    await assert.rejects(pay(lead.id, key(), "card_terminal"), /idempotency_conflict/);
    assert.equal(await count("SELECT count(*)::int n FROM bb.manual_payment_facts WHERE lead_request_id = $1", [lead.id]), 1);
  });

  it("the same key with a different payload is an idempotency conflict, not a second write", async () => {
    const lead = await newRequest();
    const k = key();
    await pay(lead.id, k, "cash");
    await assert.rejects(bridgePayment(admin, session, { requestId: lead.id, idempotencyKey: k, amountKzt: 10000, method: "bank_transfer" }), /idempotency_conflict/);
  });

  it("concurrent request creation with one key creates one request", async () => {
    const k = key();
    const input = { idempotencyKey: k, requestedDate: plus(day), customerName: "Один Запрос", phone: "+77079990001", packageId: pkg };
    const results = (await Promise.all(Array.from({ length: 8 }, () => bridgeCreateRequest(admin, session, input)))) as Array<{ id: string }>;
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(await count("SELECT count(*)::int n FROM bb.lead_requests WHERE id = $1", [results[0].id]), 1);
  });

  it("two paid requests racing for the same room and minute: exactly one wins", async () => {
    const a = await newRequest("Гонка А", 1111111);
    const b = await newRequest("Гонка Б", 2222222);
    await pay(a.id);
    await pay(b.id);
    const settled = await Promise.allSettled([confirm(a.id, rooms[3], "13:45"), confirm(b.id, rooms[3], "13:45")]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    assert.equal(await count("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id = $1 AND slot_date = $2 AND released_at IS NULL", [rooms[3], plus(day)]), 1);
  });

  it("the same confirmation key sent concurrently books once", async () => {
    const lead = await newRequest();
    await pay(lead.id);
    const k = key();
    const input = { requestId: lead.id, idempotencyKey: k, bookingDate: plus(day), roomId: rooms[0], startTime: "16:15", packageId: pkg, agreedPriceKzt: 150000 };
    const results = (await Promise.all(Array.from({ length: 6 }, () => bridgeConfirm(admin, session, input)))) as Array<{ id: string }>;
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(await count("SELECT count(*)::int n FROM bb.slot_reservations WHERE lead_request_id = $1", [lead.id]), 1);
  });

  it("the same block key sent concurrently blocks once; release is idempotent", async () => {
    const k = key();
    const input = { idempotencyKey: k, bookingDate: plus(day + 1), roomId: rooms[1], startTime: "12:20", reason: "race" };
    const results = (await Promise.all(Array.from({ length: 6 }, () => bridgeBlock(admin, session, input)))) as Array<{ id: string }>;
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    const rk = key();
    const rel = { idempotencyKey: rk, reservationId: results[0].id, reason: "done" };
    const released = await Promise.all(Array.from({ length: 4 }, () => bridgeRelease(admin, session, rel)));
    assert.equal(new Set(released.map((r) => JSON.stringify(r))).size, 1);
  });
});
