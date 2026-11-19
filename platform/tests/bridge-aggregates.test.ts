import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";
import { almatyToday } from "../src/core/dates.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../src/core/errors.ts";
import type { ValidSession } from "../src/core/session.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

/**
 * Aggregated bridge operations: one round trip returns what a page used to fetch with 3-5 sequential calls. They must return
 * the same data, enforce the same permission, and never serve cached availability.
 */
register("./helpers/next-stub-hooks.mjs", import.meta.url);
const { bridgeBlock, calendarView, requestCard, requestsIndex } = await import("../src/server/legacy-bridge.ts");

const plus = (days: number) => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const fake = (user: { id: string }, role: "manager" | "editor" | "owner") => ({ user: { id: user.id, role, name: role, email: `${role}@example.test` }, sessionId: "s" }) as unknown as ValidSession;

describe("aggregated bridge operations", () => {
  let db: TestDb;
  let manager: ValidSession;
  let editor: ValidSession;
  const day = plus(40);
  const otherDay = plus(41);
  let openId: string;
  let paidId: string;
  let packageId: string;
  let roomId: string;

  const addLead = async (name: string, status: string, date: string, phone: string) => {
    const c = await db.pool.query("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, lower($1), $2, 'manual') RETURNING id", [name, phone]);
    const l = await db.pool.query("INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, children, status, package_id) VALUES ($1, $2, $3, 6, $4, $5) RETURNING id", [randomUUID(), c.rows[0].id, date, status, packageId]);
    return l.rows[0].id as string;
  };

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    manager = fake(await makeUser(db.pool, "manager"), "manager");
    editor = fake(await makeUser(db.pool, "editor"), "editor");
    packageId = (await db.pool.query("SELECT id FROM bb.packages WHERE is_active ORDER BY sort_order LIMIT 1")).rows[0].id;
    roomId = (await db.pool.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order LIMIT 1")).rows[0].id;
    openId = await addLead("Открытая Заявка", "new", day, "+77075550001");
    paidId = await addLead("Оплаченная Заявка", "in_progress", day, "+77075550002");
    await addLead("Подтверждённая", "confirmed", day, "+77075550003");
    await addLead("Отменённая", "cancelled", day, "+77075550004");
    await addLead("Другой День", "new", otherDay, "+77075550005");
    await db.pool.query("INSERT INTO bb.manual_payment_facts (lead_request_id, amount_kzt, payment_method, idempotency_key, recorded_by) VALUES ($1, 10000, 'cash', $2, $3)", [paidId, `k-${randomUUID()}`, manager.user.id]);
  });
  after(async () => db.stop());

  it("calendar.view: catalog, timeline and only the day's open requests in one call", async () => {
    const view = await calendarView(db.pool, manager, { date: day });
    assert.equal(view.catalog.branches.length, 1);
    assert.ok(view.catalog.rooms.length >= 1 && view.catalog.packages.length >= 1);
    assert.equal(view.timeline.date, day);
    assert.deepEqual(view.leads.items.map((l) => l.customerName).sort(), ["Оплаченная Заявка", "Открытая Заявка"]);
    assert.equal(view.leads.total, view.leads.items.length, "not truncated");
    assert.equal(view.lead, null);
    assert.equal(view.bookingLead, null);
    assert.equal(view.continued, null);
  });

  it("calendar.view: truncation is reported instead of hidden", async () => {
    const crowd = plus(60);
    await db.pool.query(
      `WITH c AS (INSERT INTO bb.contacts (name, name_key, phone_e164, source) SELECT 'Толпа '||n, 'толпа '||n, '+7708'||lpad(n::text,7,'0'), 'manual' FROM generate_series(1, 205) n RETURNING id)
       INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, children, status) SELECT gen_random_uuid(), id, $1, 5, 'new' FROM c`,
      [crowd],
    );
    const view = await calendarView(db.pool, manager, { date: crowd });
    assert.equal(view.leads.items.length, 200);
    assert.ok(view.leads.total > view.leads.items.length, "the page can tell the list was cut");
  });

  it("calendar.view: request, reservation and continuation lookups, with malformed ids ignored", async () => {
    const reservation = (await db.pool.query(
      `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, lead_request_id, contact_id, package_id, children, price_kzt, price_source, created_by, starts_at, ends_at)
       SELECT 'booking', $1::date, NULL, $2, $3, l.contact_id, $4, 6, 1000, 'base', $5, ($1::date + time '14:25') AT TIME ZONE 'Asia/Almaty', ($1::date + time '18:25') AT TIME ZONE 'Asia/Almaty'
         FROM bb.lead_requests l WHERE l.id = $3 RETURNING id`,
      [day, roomId, paidId, packageId, manager.user.id],
    )).rows[0].id as string;
    const view = await calendarView(db.pool, manager, { date: day, request: paidId, reservation, continue: openId });
    assert.equal(view.lead?.manualPaymentFactStatus, "prepaid");
    assert.equal(view.lead?.manualPaymentFactAmountKzt, 10000);
    assert.equal(view.bookingLead?.id, paidId);
    assert.equal(view.continued?.id, openId);
    assert.equal(view.timeline.reservations.length, 1);

    const junk = await calendarView(db.pool, manager, { date: day, request: "1' OR '1'='1", reservation: "nope", continue: "../x" });
    assert.equal(junk.lead, null);
    assert.equal(junk.bookingLead, null);
    assert.equal(junk.continued, null);
    // A reservation of another day is not resolved for this day's view.
    assert.equal((await calendarView(db.pool, manager, { date: otherDay, reservation })).bookingLead, null);
    assert.equal((await calendarView(db.pool, manager, { date: day, request: randomUUID() })).lead, null);
  });

  it("calendar.view never serves stale availability: a new block shows on the very next call", async () => {
    const before = await calendarView(db.pool, manager, { date: plus(45) });
    assert.equal(before.timeline.reservations.length, 0);
    await bridgeBlock(db.pool, manager, { idempotencyKey: `k-${randomUUID()}`, bookingDate: plus(45), roomId, startTime: "13:30", reason: "check" });
    const after = await calendarView(db.pool, manager, { date: plus(45) });
    assert.equal(after.timeline.reservations.length, 1);
    assert.equal(after.timeline.reservations[0].kind, "block");
  });

  it("calendar.view: same permission as the calendar page, and a bad date is refused", async () => {
    await assert.rejects(calendarView(db.pool, editor, { date: day }), ForbiddenError);
    await assert.rejects(calendarView(db.pool, manager, { date: "2090-13-45" }), ValidationError);
    await assert.rejects(calendarView(db.pool, manager, {}), ValidationError);
  });

  it("requests.index: the filtered page and the package names together; closed to roles without requests.manage", async () => {
    const out = await requestsIndex(db.pool, manager, { status: "new", q: "Открытая" });
    assert.equal(out.result.total, 1);
    assert.equal(out.result.items[0].name, "Открытая Заявка");
    assert.ok(out.packages.some((p) => p.id === packageId));
    await assert.rejects(requestsIndex(db.pool, editor, {}), ForbiddenError);
  });

  it("requests.card: the record by id with its catalog; unknown ids are not found", async () => {
    const card = await requestCard(db.pool, manager, { id: paidId });
    assert.equal(card.lead.id, paidId);
    assert.equal(card.lead.prepaymentKzt, 10000);
    assert.ok(card.catalog.rooms.length >= 1 && card.catalog.slots.length >= 1 && card.catalog.packages.length >= 1);
    await assert.rejects(requestCard(db.pool, manager, { id: randomUUID() }), NotFoundError);
    await assert.rejects(requestCard(db.pool, manager, { id: "not-a-uuid" }), NotFoundError);
    await assert.rejects(requestCard(db.pool, editor, { id: paidId }), ForbiddenError);
  });
});
