import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  confirmLead, createBlock, createManualBooking, dayAvailability, getGrid, listLeads, monthAvailability, releaseReservation, setLeadStatus,
} from "../src/core/bookings.ts";
import { setPriceRule } from "../src/core/catalog.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { submitLead } from "../src/core/intake.ts";
import { approveDocument, createDraft, publishDocument } from "../src/core/legal.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

const plus = (days: number) => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe("Stage 3: bookings, blocks and double-booking protection", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let manager2: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  let roomIds: string[];
  let pkg: string;
  let day = 10;
  const nextDay = () => plus(day++);

  async function lead(over: Record<string, unknown> = {}) {
    const r = await submitLead(db.pool, {
      idempotencyKey: randomUUID(), name: "Тест Гость", phone: `+7707${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
      date: plus(5), children: 6, consent: true, packageId: pkg, ...over,
    } as never);
    return r.leadId;
  }

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    owner = await makeUser(db.pool, "owner");
    manager = await makeUser(db.pool, "manager", "m1@example.test");
    manager2 = await makeUser(db.pool, "manager", "m2@example.test");
    editor = await makeUser(db.pool, "editor");
    const d = await createDraft(db.pool, owner, { kind: "personal_data_consent", title: "c", body: "text" });
    await approveDocument(db.pool, owner, d.id);
    await publishDocument(db.pool, owner, d.id);
    roomIds = (await db.pool.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order")).rows.map((r) => r.id);
    pkg = (await db.pool.query("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
  });
  after(async () => {
    await db.stop();
  });

  it("the catalog has the four rooms and the three back-to-back slots", async () => {
    assert.equal(roomIds.length, 4);
    const names = (await db.pool.query("SELECT name FROM bb.rooms ORDER BY sort_order")).rows.map((r) => r.name);
    assert.deepEqual(names.map((n: string) => n.split(" ")[0]), ["Roblox", "Ice", "Magic", "Rapunzel"]);
    const slots = (await db.pool.query("SELECT to_char(starts_at,'HH24:MI') s, to_char(ends_at,'HH24:MI') e FROM bb.time_slots ORDER BY id")).rows;
    assert.deepEqual(slots.map((x) => `${x.s}-${x.e}`), ["10:00-14:00", "14:00-18:00", "18:00-22:00"]);
  });

  it("an enquiry does NOT occupy a slot; confirmation does", async () => {
    const date = nextDay();
    const id = await lead({ date, roomId: roomIds[0], slotId: 1 });
    let a = await dayAvailability(db.pool, date);
    assert.equal(a.slots[0].freeRoomIds.length, 4, "open enquiry blocks nothing");
    // a second enquiry for the very same cell is accepted too
    await lead({ date, roomId: roomIds[0], slotId: 1 });
    await confirmLead(db.pool, manager, { leadId: id });
    a = await dayAvailability(db.pool, date);
    assert.equal(a.slots[0].freeRoomIds.length, 3);
    assert.ok(!a.slots[0].freeRoomIds.includes(roomIds[0]));
    const grid = await getGrid(db.pool, manager, date);
    const cell = grid.cells.find((c) => c.roomId === roomIds[0] && c.slotId === 1)!;
    assert.equal(cell.state, "booked");
    assert.equal(cell.pendingLeads, 1, "the second enquiry is shown as pending, not as an occupant");
    assert.equal((await db.pool.query("SELECT status FROM bb.lead_requests WHERE id=$1", [id])).rows[0].status, "confirmed");
  });

  it("a manual block occupies the cell exactly like a booking", async () => {
    const date = nextDay();
    await createBlock(db.pool, manager, { date, slotId: 2, roomId: roomIds[1], note: "ремонт" });
    const a = await dayAvailability(db.pool, date);
    assert.ok(!a.slots[1].freeRoomIds.includes(roomIds[1]));
    await assert.rejects(() => createBlock(db.pool, manager, { date, slotId: 2, roomId: roomIds[1] }), (e) => e instanceof ConflictError && e.message === "slot_taken");
    await assert.rejects(
      () => createManualBooking(db.pool, manager, { date, slotId: 2, roomId: roomIds[1], packageId: pkg, name: "Иван", phone: "+77071234567" }),
      (e) => e instanceof ConflictError && e.message === "slot_taken",
    );
    const id = await lead({ date, roomId: roomIds[1], slotId: 2 });
    await assert.rejects(() => confirmLead(db.pool, manager, { leadId: id }), (e) => e instanceof ConflictError && e.message === "slot_taken");
    assert.equal((await db.pool.query("SELECT status FROM bb.lead_requests WHERE id=$1", [id])).rows[0].status, "new", "a refused confirmation leaves the enquiry open");
  });

  it("no pause between slots: back-to-back slots of one room, and all 4 rooms x 3 slots of one day, can be booked", async () => {
    const date = nextDay();
    for (const room of roomIds) {
      for (const slot of [1, 2, 3]) {
        await createManualBooking(db.pool, manager, { date, slotId: slot, roomId: room, packageId: pkg, name: `Гость ${room} ${slot}`, phone: "+77075550000" });
      }
    }
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date=$1 AND released_at IS NULL", [date])).rows[0].n, 12);
    const a = await dayAvailability(db.pool, date);
    assert.ok(a.slots.every((s) => s.freeRoomIds.length === 0));
    const m = await monthAvailability(db.pool, date.slice(0, 7));
    assert.deepEqual(m.days[date], { "1": 0, "2": 0, "3": 0 });
  });

  it("CONCURRENCY: two managers confirm DIFFERENT enquiries for the same room and slot at once: exactly one booking survives", async () => {
    for (let round = 0; round < 15; round++) {
      const date = nextDay();
      const [l1, l2] = [await lead({ date }), await lead({ date })];
      const p1 = db.newPool(2);
      const p2 = db.newPool(2);
      const results = await Promise.allSettled([
        confirmLead(p1, manager, { leadId: l1, slotId: 1, roomId: roomIds[2] }),
        confirmLead(p2, manager2, { leadId: l2, slotId: 1, roomId: roomIds[2] }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as Error).message === "slot_taken").length;
      assert.equal(ok, 1, `round ${round}: one winner`);
      assert.equal(conflicts, 1, `round ${round}: the other gets a clean conflict`);
      assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date=$1 AND released_at IS NULL", [date])).rows[0].n, 1);
      const statuses = (await db.pool.query("SELECT status FROM bb.lead_requests WHERE id = ANY($1) ORDER BY status", [[l1, l2]])).rows.map((r) => r.status);
      assert.deepEqual(statuses, ["confirmed", "new"], "only the winner is confirmed");
    }
  });

  it("CONCURRENCY: 10 simultaneous writers (bookings, blocks, confirmations) on one cell: one row", async () => {
    const date = nextDay();
    const l = await lead({ date });
    const pools = Array.from({ length: 10 }, () => db.newPool(2));
    const jobs = pools.map((p, i) =>
      i % 3 === 0 ? confirmLead(p, manager, { leadId: l, slotId: 3, roomId: roomIds[3] })
      : i % 3 === 1 ? createBlock(p, manager2, { date, slotId: 3, roomId: roomIds[3] })
      : createManualBooking(p, owner, { date, slotId: 3, roomId: roomIds[3], packageId: pkg, name: `Гость ${i}`, phone: "+77070001122" }),
    );
    const results = await Promise.allSettled(jobs);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok((r.reason as Error).message === "slot_taken" || (r.reason as Error).message === "lead_already_booked", String(r.reason));
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date=$1 AND released_at IS NULL", [date])).rows[0].n, 1);
  });

  it("CONCURRENCY: the same enquiry confirmed twice at once into two different cells: one booking", async () => {
    const date = nextDay();
    const l = await lead({ date });
    const results = await Promise.allSettled([
      confirmLead(db.newPool(2), manager, { leadId: l, slotId: 1, roomId: roomIds[0] }),
      confirmLead(db.newPool(2), manager2, { leadId: l, slotId: 2, roomId: roomIds[1] }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE lead_request_id=$1 AND released_at IS NULL", [l])).rows[0].n, 1);
  });

  it("the database refuses a duplicate even for a raw INSERT that bypasses the application", async () => {
    const date = nextDay();
    const sql = `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, created_by) VALUES ('block', $1, 1, $2, $3)`;
    await db.pool.query(sql, [date, roomIds[0], owner.id]);
    await assert.rejects(() => db.pool.query(sql, [date, roomIds[0], owner.id]), (e: { code?: string }) => e.code === "23505");
  });

  it("cancelling frees the cell; the cancelled row stays as history and can be booked again", async () => {
    const date = nextDay();
    const l = await lead({ date });
    const { reservationId } = await confirmLead(db.pool, manager, { leadId: l, slotId: 1, roomId: roomIds[0] });
    await releaseReservation(db.pool, manager, reservationId, "клиент отказался");
    assert.equal((await db.pool.query("SELECT status FROM bb.lead_requests WHERE id=$1", [l])).rows[0].status, "cancelled");
    await assert.rejects(() => releaseReservation(db.pool, manager, reservationId, "ещё раз"), (e) => e instanceof ConflictError && e.message === "already_released");
    const again = await createManualBooking(db.pool, manager, { date, slotId: 1, roomId: roomIds[0], packageId: pkg, name: "Другой", phone: "+77079990000" });
    assert.ok(again.reservationId);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date=$1", [date])).rows[0].n, 2, "history kept");
    // a released reservation is final and rows can never be deleted or edited
    await assert.rejects(() => db.pool.query("UPDATE bb.slot_reservations SET released_at = NULL, released_by = NULL WHERE id=$1", [reservationId]));
    await assert.rejects(() => db.pool.query("DELETE FROM bb.slot_reservations WHERE id=$1", [reservationId]));
    await assert.rejects(() => db.pool.query("TRUNCATE bb.slot_reservations"));
  });

  it("the price is a snapshot: later price changes never alter a confirmed booking; date-specific and weekday prices apply", async () => {
    const date = nextDay();
    const before = (await dayAvailability(db.pool, date)).prices[pkg]!;
    const l = await lead({ date });
    const { reservationId } = await confirmLead(db.pool, manager, { leadId: l, slotId: 1, roomId: roomIds[0] });
    const snap = (await db.pool.query("SELECT price_kzt, price_source FROM bb.slot_reservations WHERE id=$1", [reservationId])).rows[0];
    assert.equal(snap.price_kzt, before.amountKzt);
    assert.equal(snap.price_source, before.source);
    await setPriceRule(db.pool, owner, { packageId: pkg, ruleType: "date", date, amountKzt: before.amountKzt + 12345 });
    const after = (await dayAvailability(db.pool, date)).prices[pkg]!;
    assert.equal(after.amountKzt, before.amountKzt + 12345);
    assert.equal(after.source, "date");
    assert.equal((await db.pool.query("SELECT price_kzt FROM bb.slot_reservations WHERE id=$1", [reservationId])).rows[0].price_kzt, before.amountKzt, "snapshot unchanged");
    // a booking made after the change takes the new price
    const l2 = await lead({ date });
    const b2 = await confirmLead(db.pool, manager, { leadId: l2, slotId: 2, roomId: roomIds[0] });
    assert.equal((await db.pool.query("SELECT price_kzt FROM bb.slot_reservations WHERE id=$1", [b2.reservationId])).rows[0].price_kzt, before.amountKzt + 12345);
    // the snapshot cannot be edited even by direct SQL
    await assert.rejects(() => db.pool.query("UPDATE bb.slot_reservations SET price_kzt = 1 WHERE id=$1", [reservationId]));
  });

  it("a slot that has already started cannot be taken; past dates are refused", async () => {
    await assert.rejects(() => createBlock(db.pool, manager, { date: plus(-1), slotId: 1, roomId: roomIds[0] }), ValidationError);
    // today, slot 1 starts at 10:00 Almaty: either still future (allowed) or started (refused with a clean validation error)
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", hour12: false }).format(new Date()));
    const attempt = createBlock(db.pool, manager, { date: almatyToday(), slotId: 1, roomId: roomIds[3] });
    if (hour >= 10) await assert.rejects(() => attempt, (e) => e instanceof ValidationError && "date" in (e as ValidationError).fields);
    else await attempt;
  });

  it("validation: unknown/inactive room, missing price, closed enquiry", async () => {
    const date = nextDay();
    await assert.rejects(() => createBlock(db.pool, manager, { date, slotId: 4 as never, roomId: roomIds[0] }), ValidationError);
    await assert.rejects(() => createBlock(db.pool, manager, { date, slotId: 1, roomId: "no-such-room" }), ValidationError);
    await assert.rejects(() => createManualBooking(db.pool, manager, { date, slotId: 1, roomId: roomIds[0], packageId: "no-such", name: "Иван", phone: "+77071234567" }), ValidationError);
    await assert.rejects(() => createManualBooking(db.pool, manager, { date, slotId: 1, roomId: roomIds[0], packageId: pkg, name: "Иван", phone: "12" }), ValidationError);
    const l = await lead({ date, packageId: undefined });
    await assert.rejects(() => confirmLead(db.pool, manager, { leadId: l, slotId: 1, roomId: roomIds[0] }), ValidationError); // "undecided" package: manager must choose
    await confirmLead(db.pool, manager, { leadId: l, slotId: 1, roomId: roomIds[0], packageId: pkg });
    await assert.rejects(() => confirmLead(db.pool, manager, { leadId: l, slotId: 2, roomId: roomIds[0] }), (e) => e instanceof ConflictError && e.message === "lead_not_open");
    await db.pool.query("UPDATE bb.rooms SET is_active = false WHERE id = $1", [roomIds[3]]);
    await assert.rejects(() => createBlock(db.pool, manager, { date, slotId: 1, roomId: roomIds[3] }), ValidationError);
    await db.pool.query("UPDATE bb.rooms SET is_active = true WHERE id = $1", [roomIds[3]]);
  });

  it("enquiry statuses: in_progress / cancelled by hand; a cancelled enquiry cannot be confirmed", async () => {
    const date = nextDay();
    const l = await lead({ date });
    await setLeadStatus(db.pool, manager, l, "in_progress");
    await setLeadStatus(db.pool, manager, l, "cancelled");
    await assert.rejects(() => confirmLead(db.pool, manager, { leadId: l, slotId: 1, roomId: roomIds[0] }), (e) => e instanceof ConflictError && e.message === "lead_not_open");
    const open = await listLeads(db.pool, manager, { status: "cancelled" });
    assert.ok(open.some((x) => x.id === l));
  });

  it("permissions: only owner/manager manage bookings; editors and unknown roles are refused; every change is audited", async () => {
    const date = nextDay();
    await assert.rejects(() => createBlock(db.pool, editor, { date, slotId: 1, roomId: roomIds[0] }), ForbiddenError);
    await assert.rejects(() => getGrid(db.pool, editor, date), ForbiddenError);
    await assert.rejects(() => listLeads(db.pool, editor), ForbiddenError);
    const { reservationId } = await createBlock(db.pool, owner, { date, slotId: 1, roomId: roomIds[0] });
    await releaseReservation(db.pool, manager, reservationId, undefined);
    const actions = (await db.pool.query("SELECT action FROM bb.audit_log WHERE entity_id=$1 ORDER BY id", [reservationId])).rows.map((r) => r.action);
    assert.deepEqual(actions, ["block.created", "block.released"]);
  });
});
