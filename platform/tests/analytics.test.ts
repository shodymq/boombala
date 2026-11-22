import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool } from "../src/core/db.ts";
import { dashboardAnalytics } from "../src/core/analytics.ts";
import { almatyToday } from "../src/core/dates.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

describe("dashboard analytics: facts only, distinct bookings and blocks", () => {
  let db: TestDb;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  let leadIds: Record<string, string>;
  let contactIds: Record<string, string>;
  let roomIds: string[];
  let packageId: string;
  const today = almatyToday();

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    manager = await makeUser(db.pool, "manager");
    editor = await makeUser(db.pool, "editor");
    roomIds = (await db.pool.query("SELECT id FROM bb.rooms WHERE is_active ORDER BY sort_order")).rows.map((r) => r.id as string);
    packageId = (await db.pool.query("SELECT id FROM bb.packages ORDER BY sort_order LIMIT 1")).rows[0].id as string;
    const statuses = ["new", "in_progress", "confirmed", "cancelled", "completed", "new"];
    leadIds = {};
    contactIds = {};
    for (const [index, status] of statuses.entries()) {
      const key = `fixture-${index}`;
      const contact = await db.pool.query<{ id: string }>(
        "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, NULL, 'qr') RETURNING id",
        [`Analytics fixture ${index}`, `analytics fixture ${index}`],
      );
      contactIds[key] = contact.rows[0].id;
      const lead = await db.pool.query<{ id: string }>(
        `INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, children, status, created_at)
         VALUES ($1, $2, '2099-02-02', 1, $3, CASE WHEN $4 THEN now() - interval '31 days' ELSE now() - interval '2 days' END)
         RETURNING id`,
        [randomUUID(), contact.rows[0].id, status, index === statuses.length - 1],
      );
      leadIds[key] = lead.rows[0].id;
    }

    await db.pool.query(
      `INSERT INTO bb.manual_payment_facts (lead_request_id, amount_kzt, payment_method, idempotency_key, recorded_by, created_at)
       VALUES ($1, 10000, 'cash', $2, $3, now() - interval '1 day'),
              ($4, 5000, 'cash', $5, $3, now() - interval '31 days')`,
      [leadIds["fixture-2"], `analytics-recent-${randomUUID()}`, manager.id, leadIds["fixture-5"], `analytics-old-${randomUUID()}`],
    );

    const addReservation = async (kind: "booking" | "block", roomId: string, dayOffset: number, leadId: string | null, contactId: string | null, released = false) => {
      const row = await db.pool.query<{ id: string }>(
        `INSERT INTO bb.slot_reservations
           (kind, slot_date, slot_id, room_id, lead_request_id, contact_id, package_id, children, price_kzt, price_source, note, created_by, starts_at, ends_at)
         VALUES ($1, $2::date + $3::int, NULL, $4, $5, $6, CASE WHEN $1='booking' THEN $7 END,
                 CASE WHEN $1='booking' THEN 1 END, CASE WHEN $1='booking' THEN 10000 END,
                 CASE WHEN $1='booking' THEN 'manager_agreed' END, NULL, $8,
                 (($2::date + $3::int + time '11:00') AT TIME ZONE 'Asia/Almaty'),
                 ((($2::date + $3::int + time '11:00') AT TIME ZONE 'Asia/Almaty') + interval '4 hours'))
         RETURNING id`,
        [kind, today, dayOffset, roomId, leadId, contactId, packageId, manager.id],
      );
      if (released) await db.pool.query("UPDATE bb.slot_reservations SET released_at=now(), released_by=$2 WHERE id=$1", [row.rows[0].id, manager.id]);
    };
    await addReservation("booking", roomIds[0], 1, leadIds["fixture-2"], contactIds["fixture-2"]);
    await addReservation("block", roomIds[1], 2, null, null);
    await addReservation("booking", roomIds[2], 3, null, contactIds["fixture-0"], true);
  });

  after(async () => db.stop());

  it("reports Almaty request status counts, future bookings separate from blocks, and only recorded recent payment facts", async () => {
    const result = await dashboardAnalytics(db.pool, "manager", today);
    const from = new Date(`${today}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 29);
    assert.equal(result.historyFrom, from.toISOString().slice(0, 10));
    assert.equal(result.historyThrough, today);
    assert.deepEqual(result.leads, { total: 5, new: 1, inProgress: 1, confirmed: 1, cancelled: 1, completed: 1 });
    assert.deepEqual(result.upcoming, { bookings: 1, blocks: 1 }, "released bookings are excluded and blocks never count as bookings");
    assert.deepEqual(result.manualPrepayments, { count: 1, amountKzt: "10000" }, "historical payment facts are excluded and money remains exact");
  });

  it("returns null metrics to roles without request or booking permissions without issuing aggregate queries", async () => {
    let queries = 0;
    const noQueryPool = { query: async () => { queries += 1; throw new Error("unexpected_query"); } } as unknown as Pool;
    const result = await dashboardAnalytics(noQueryPool, "editor", today);
    assert.deepEqual(result.leads, null);
    assert.deepEqual(result.upcoming, null);
    assert.deepEqual(result.manualPrepayments, null);
    assert.equal(queries, 0);
    assert.equal(editor.role, "editor");
  });
});
