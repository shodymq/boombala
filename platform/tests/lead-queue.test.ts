import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { almatyToday } from "../src/core/dates.ts";
import { ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { dashboardCounters, getLead, LEAD_PAGE_SIZE_MAX, searchLeads } from "../src/core/lead-queue.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

describe("request queue: server-side search, pagination, single record, counters", () => {
  let db: TestDb;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  let firstId: string;
  const TOTAL = 130; // more than the old 100-row limit

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    manager = await makeUser(db.pool, "manager");
    editor = await makeUser(db.pool, "editor");
    // 130 synthetic requests: contact "Гость N", phone +7701000NNNN, created N days apart so date filters can pick them.
    await db.pool.query(
      `WITH c AS (
         INSERT INTO bb.contacts (name, name_key, phone_e164, source)
         SELECT 'Гость ' || n, 'гость ' || n, '+7701' || lpad(n::text, 7, '0'), 'birthday_form' FROM generate_series(1, ${TOTAL}) n
         RETURNING id, name)
       INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, children, created_at, status)
       SELECT gen_random_uuid(), c.id, '2099-01-01', 5,
              timestamptz '2090-01-01 12:00+06' + ((regexp_replace(c.name, '\\D', '', 'g'))::int || ' days')::interval,
              CASE WHEN regexp_replace(c.name, '\\D', '', 'g')::int % 10 = 0 THEN 'in_progress' ELSE 'new' END
         FROM c`,
    );
    firstId = (await db.pool.query("SELECT l.id FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = 'Гость 1'")).rows[0].id;
  });
  after(async () => db.stop());

  it("paginates beyond 100 rows and reports the real total", async () => {
    const p1 = await searchLeads(db.pool, manager, { page: 1, pageSize: 100 });
    const p2 = await searchLeads(db.pool, manager, { page: 2, pageSize: 100 });
    assert.equal(p1.total, TOTAL);
    assert.equal(p1.items.length, 100);
    assert.equal(p2.items.length, TOTAL - 100);
    const ids = new Set([...p1.items, ...p2.items].map((l) => l.id));
    assert.equal(ids.size, TOTAL, "no row is lost or repeated between pages");
  });

  it("caps the page size and falls back to the last page for a stale page number", async () => {
    const huge = await searchLeads(db.pool, manager, { pageSize: 5000 });
    assert.equal(huge.pageSize, LEAD_PAGE_SIZE_MAX);
    const past = await searchLeads(db.pool, manager, { page: 999, pageSize: 25 });
    assert.equal(past.page, Math.ceil(TOTAL / 25));
    assert.ok(past.items.length > 0);
  });

  it("finds a record that the old 100-row list could never reach, by name and by phone digits", async () => {
    const byName = await searchLeads(db.pool, manager, { q: "Гость 130" });
    assert.deepEqual(byName.items.map((l) => l.name), ["Гость 130"]);
    const byPhone = await searchLeads(db.pool, manager, { q: "+7 701 000 0130" });
    assert.deepEqual(byPhone.items.map((l) => l.name), ["Гость 130"]);
  });

  it("treats LIKE wildcards in the query as plain text", async () => {
    assert.equal((await searchLeads(db.pool, manager, { q: "%" })).total, 0);
    assert.equal((await searchLeads(db.pool, manager, { q: "_" })).total, 0);
  });

  it("filters by status and by creation day (Asia/Almaty, inclusive) in the database", async () => {
    const inProgress = await searchLeads(db.pool, manager, { status: "in_progress", pageSize: 100 });
    assert.equal(inProgress.total, TOTAL / 10);
    assert.ok(inProgress.items.every((l) => l.status === "in_progress"));
    // Гость N was created on 2090-01-01 + N days.
    const day = await searchLeads(db.pool, manager, { createdFrom: "2090-01-11", createdTo: "2090-01-11" });
    assert.deepEqual(day.items.map((l) => l.name), ["Гость 10"]);
    const range = await searchLeads(db.pool, manager, { createdFrom: "2090-01-11", createdTo: "2090-01-13" });
    assert.equal(range.total, 3);
  });

  it("refuses malformed filters instead of returning everything", async () => {
    await assert.rejects(searchLeads(db.pool, manager, { status: "bogus" }), ValidationError);
    await assert.rejects(searchLeads(db.pool, manager, { createdFrom: "2090-13-45" }), ValidationError);
    await assert.rejects(searchLeads(db.pool, manager, { createdTo: "tomorrow" }), ValidationError);
  });

  it("returns the concrete record by id, including old ones, and null for unknown or malformed ids", async () => {
    const lead = await getLead(db.pool, manager, firstId);
    assert.equal(lead?.name, "Гость 1");
    assert.equal(lead?.prepaymentKzt, null);
    assert.equal(await getLead(db.pool, manager, "00000000-0000-4000-8000-000000000000"), null);
    assert.equal(await getLead(db.pool, manager, "not-a-uuid"), null);
    assert.equal(await getLead(db.pool, manager, "1' OR '1'='1"), null);
  });

  it("surfaces same-customer, same-date candidates without merging separate orders", async () => {
    const contact = await db.pool.query<{ id: string }>(
      "INSERT INTO bb.contacts (name,name_key,phone_e164,source) VALUES ('Synthetic duplicate customer','synthetic duplicate customer','+77070000001','birthday_form') RETURNING id",
    );
    const packageId = (await db.pool.query<{ id: string }>("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
    const date = "2099-06-12";
    const insertOrder = async (time: string | null) => db.pool.query<{ id: string }>(
      `INSERT INTO bb.lead_requests (idempotency_key,contact_id,package_id,requested_date,preferred_start_time,children,status)
       VALUES (gen_random_uuid(),$1,$2,$3,$4::time,6,'new') RETURNING id`,
      [contact.rows[0].id, packageId, date, time],
    );
    const first = await insertOrder("13:00");
    await insertOrder("18:00"); // same client/date, but a distinct requested start remains a separate order
    await insertOrder(null); // even incomplete same-day enquiries are visible for a manager check
    const detail = await getLead(db.pool, manager, first.rows[0].id);
    assert.deepEqual(detail?.possibleDuplicates.map((candidate) => candidate.preferredStartTime).sort((a, b) => (a ?? "").localeCompare(b ?? "")), [null, "18:00"]);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.lead_requests WHERE contact_id=$1 AND requested_date=$2", [contact.rows[0].id, date])).rows[0].n, 3);
    assert.equal(new Set(detail?.possibleDuplicates.map((candidate) => candidate.id)).size, 2);
  });

  it("shows the recorded manual prepayment on the record", async () => {
    const user = manager.id;
    await db.pool.query("INSERT INTO bb.manual_payment_facts (lead_request_id, amount_kzt, payment_method, idempotency_key, recorded_by) VALUES ($1, 10000, 'cash', 'k-lead-queue-1', $2)", [firstId, user]);
    assert.equal((await getLead(db.pool, manager, firstId))?.prepaymentKzt, 10000);
  });

  it("is closed to roles without requests.manage", async () => {
    await assert.rejects(searchLeads(db.pool, editor, {}), ForbiddenError);
    await assert.rejects(getLead(db.pool, editor, firstId), ForbiddenError);
  });

  it("counts new and in-progress requests, and today's active bookings and blocks, without inventing anything", async () => {
    const today = almatyToday();
    const room = (await db.pool.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order")).rows.map((r) => r.id as string);
    const pkg = (await db.pool.query("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id;
    const contact = (await db.pool.query("SELECT id FROM bb.contacts LIMIT 1")).rows[0].id;
    const slots = (await db.pool.query("SELECT id FROM bb.time_slots ORDER BY starts_at LIMIT 4")).rows.map((r) => r.id as number);
    // The guard refuses starts in the past (and at test time "today" may already be late), so the fixtures are written with
    // triggers off and explicit intervals; the constraints that remain (four hours, no overlap) still hold.
    const add = async (kind: "booking" | "block", roomId: string, slotId: number, date: string) => {
      const c = await db.pool.connect();
      try {
        await c.query("SET session_replication_role = replica");
        return await c.query(
          `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, note, created_by, starts_at, ends_at)
           SELECT $1, $2::date, t.id, $4, $5, $6, 5, CASE WHEN $1 = 'booking' THEN 1000 END, CASE WHEN $1 = 'booking' THEN 'base' END, 'x', $7, ($2::date + t.starts_at) AT TIME ZONE 'Asia/Almaty', (($2::date + t.starts_at) AT TIME ZONE 'Asia/Almaty') + interval '4 hours'
             FROM bb.time_slots t WHERE t.id = $3 RETURNING id`,
          [kind, date, slotId, roomId, kind === "booking" ? contact : null, kind === "booking" ? pkg : null, manager.id],
        );
      } finally {
        await c.query("SET session_replication_role = DEFAULT");
        c.release();
      }
    };
    const before = await dashboardCounters(db.pool, "manager");
    assert.equal(before.date, today);
    assert.deepEqual(before.bookings, { booked: 0, blocked: 0 });
    assert.deepEqual(before.requests, { new: TOTAL - TOTAL / 10 + 3, inProgress: TOTAL / 10 }, "includes the three independent orders created by the duplicate-candidate test");
    await add("booking", room[0], slots[0], today);
    await add("booking", room[1], slots[0], today);
    await add("block", room[2], slots[1], today);
    const released = (await add("booking", room[3], slots[2], today)).rows[0].id;
    await db.pool.query("UPDATE bb.slot_reservations SET released_at = now(), released_by = $2 WHERE id = $1", [released, manager.id]);
    await add("booking", room[0], slots[3], "2099-02-02"); // another day: not counted
    const after = await dashboardCounters(db.pool, "manager");
    assert.deepEqual(after.bookings, { booked: 2, blocked: 1 }, "released and other-day reservations are not counted");
  });

  it("returns null, not zero, for counters the role may not see", async () => {
    const seen = await dashboardCounters(db.pool, "editor");
    assert.equal(seen.requests, null);
    assert.equal(seen.bookings, null);
  });
});
