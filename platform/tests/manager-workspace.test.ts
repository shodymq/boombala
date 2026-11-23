import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { managerWorkspace } from "../src/core/manager-workspace.ts";
import { seedFromSite, makeUser, startTestDb, syntheticPhone } from "./helpers/db.ts";

describe("manager workspace projection", () => {
  it("shows overdue tasks first, new requests, calls in the Almaty day, and only active upcoming bookings to authorized roles", async () => {
    const db = await startTestDb();
    try {
      const manager = await makeUser(db.pool, "manager", "workspace-manager@example.test");
      const editor = await makeUser(db.pool, "editor", "workspace-editor@example.test");
      await seedFromSite(db.pool);
      const contactId = async (label: string) => (await db.pool.query(
        "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, $3, 'manual') RETURNING id",
        [`Synthetic ${label}`, `synthetic ${label}`, syntheticPhone()],
      )).rows[0].id as string;
      const createLead = async (label: string, status: string, workflow?: { action: string; followUpAt: string }) => {
        const contact = await contactId(label);
        const created = await db.pool.query(
          `INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, status, next_action, follow_up_at)
           VALUES ($1, $2, '2099-05-01', $3, $4, $5::timestamptz) RETURNING id`,
          [randomUUID(), contact, status, workflow?.action ?? null, workflow?.followUpAt ?? null],
        );
        return { id: created.rows[0].id as string, contact };
      };

      const overdueLater = await createLead("overdue-later", "in_progress", { action: "clarify_details", followUpAt: "2099-04-19T12:00:00Z" });
      const overdueSooner = await createLead("overdue-sooner", "new", { action: "call_customer", followUpAt: "2099-04-19T11:00:00Z" });
      const newLead = await createLead("new", "new");
      const overdueCallToday = await createLead("overdue-call-today", "in_progress", { action: "call_customer", followUpAt: "2099-04-20T07:30:00Z" });
      const callLead = await createLead("call-today", "in_progress", { action: "call_customer", followUpAt: "2099-04-20T11:00:00Z" });
      await db.pool.query("UPDATE bb.lead_requests SET assigned_to=$2 WHERE id=$1", [callLead.id, manager.id]);

      const roomId = (await db.pool.query<{ id: string }>("SELECT id FROM bb.rooms ORDER BY sort_order, id LIMIT 1")).rows[0].id;
      const packageId = (await db.pool.query<{ id: string }>("SELECT id FROM bb.packages ORDER BY sort_order, id LIMIT 1")).rows[0].id;
      await db.pool.query(
        `INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, contact_id, package_id, children, price_kzt, price_source, created_by)
         VALUES ('booking', '2099-04-22', 1, $1, $2, $3, 1, 10000, 'base', $4)`,
        [roomId, await contactId("booking"), packageId, manager.id],
      );

      const now = new Date("2099-04-20T08:00:00.000Z"); // 13:00, Asia/Almaty.
      const result = await managerWorkspace(db.pool, { id: manager.id, role: "manager" }, now);
      assert.deepEqual(result.overdueActions?.map((lead) => lead.id), [overdueSooner.id, overdueLater.id, overdueCallToday.id]);
      assert.ok(result.newRequests?.some((lead) => lead.id === newLead.id));
      assert.deepEqual(result.callsToday?.map((lead) => lead.id), [callLead.id]);
      assert.equal(result.callsToday?.some((lead) => lead.id === overdueCallToday.id), false, "already overdue calls remain only in the overdue list");
      assert.equal(result.callsToday?.[0].assignedTo, manager.id);
      assert.equal(result.upcomingBirthdays?.length, 1);
      assert.equal(result.upcomingBirthdays?.[0].date, "2099-04-22");
      assert.deepEqual(Object.keys(result.upcomingBirthdays![0]).sort(), ["date", "id", "packageName", "room", "startsAt"]);
      const json = JSON.stringify(result.upcomingBirthdays);
      assert.equal(json.includes("Synthetic booking"), false, "booking read model contains no customer PII");

      const editorResult = await managerWorkspace(db.pool, { id: editor.id, role: "editor" }, now);
      assert.deepEqual(editorResult, { overdueActions: null, newRequests: null, callsToday: null, upcomingBirthdays: null });
    } finally {
      await db.stop();
    }
  });
});
