import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";
import { applyRoles } from "../scripts/db-roles.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import {
  almatyLocalDateTimeToInstant, claimLead, getLeadWorkflowContext, instantToAlmatyLocalDateTime,
  updateLeadWorkflow,
} from "../src/core/lead-workflow.ts";
import { searchLeads } from "../src/core/lead-queue.ts";
import type { ValidSession } from "../src/core/session.ts";
import { makeUser, MIGRATIONS_DIR, startTestDb, syntheticPhone, type TestDb } from "./helpers/db.ts";

register("./helpers/next-stub-hooks.mjs", import.meta.url);
const { bridgeClaimLead, bridgeUpdateLeadWorkflow } = await import("../src/server/legacy-bridge.ts");

const sessionFor = (user: Awaited<ReturnType<typeof makeUser>>): ValidSession => ({
  sessionId: "isolated-test-session",
  user: { id: user.id, email: user.email, name: user.name, role: user.role, canExport: false },
});

describe("lead follow-up workflow", () => {
  let db: TestDb;
  let admin: Pool;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let secondManager: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  let leadId: string;
  let raceLeadId: string;
  let claimLeadId: string;

  async function createLead(status = "new") {
    const suffix = randomBytes(5).toString("hex");
    const contact = await db.pool.query(
      "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, $3, 'manual') RETURNING id",
      [`Synthetic lead ${suffix}`, `synthetic lead ${suffix}`, syntheticPhone()],
    );
    const lead = await db.pool.query(
      "INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, status) VALUES ($1, $2, '2099-05-01', $3) RETURNING id",
      [randomUUID(), contact.rows[0].id, status],
    );
    return lead.rows[0].id as string;
  }

  before(async () => {
    db = await startTestDb();
    manager = await makeUser(db.pool, "manager", "lead-manager@example.test");
    secondManager = await makeUser(db.pool, "manager", "lead-manager-2@example.test");
    editor = await makeUser(db.pool, "editor", "lead-editor@example.test");
    leadId = await createLead();
    raceLeadId = await createLead();
    claimLeadId = await createLead();
    await applyRoles(db.pool, { apiPassword: randomBytes(24).toString("hex"), adminPassword: randomBytes(24).toString("hex") });
    const adminPassword = `test-${randomBytes(24).toString("hex")}`;
    await db.pool.query(`ALTER ROLE bb_admin PASSWORD '${adminPassword}'`);
    const url = new URL(db.url);
    url.username = "bb_admin";
    url.password = adminPassword;
    admin = createPool(url.toString(), { max: 12 });
  });

  after(async () => {
    await admin?.end();
    await db?.stop();
  });

  it("converts browser wall time in Asia/Almaty independent of host timezone", () => {
    const instant = almatyLocalDateTimeToInstant("2026-11-22T09:35");
    assert.equal(instant.toISOString(), "2026-11-22T04:35:00.000Z");
    assert.equal(instantToAlmatyLocalDateTime(instant), "2026-11-22T09:35");
    assert.throws(() => almatyLocalDateTimeToInstant("2026-02-30T09:35"), ValidationError);
    assert.throws(() => almatyLocalDateTimeToInstant("2026-11-22T24:00"), ValidationError);
  });

  it("saves assignment and a concrete follow-up on the existing lead and writes safe audit history as bb_admin", async () => {
    const result = await updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, {
      leadId: leadId, expectedVersion: 1, assignedTo: secondManager.id, nextAction: "call_customer", followUpAtLocal: "2095-04-03T10:15",
    });
    assert.equal(result.version, 2);
    const lead = (await admin.query("SELECT status, assigned_to, next_action, follow_up_at, workflow_version FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0];
    assert.equal(lead.status, "new", "workflow metadata does not change the business state");
    assert.equal(lead.assigned_to, secondManager.id);
    assert.equal(lead.next_action, "call_customer");
    assert.equal((lead.follow_up_at as Date).toISOString(), "2095-04-03T05:15:00.000Z");
    assert.equal(lead.workflow_version, 2);

    const events = (await admin.query("SELECT action, before, after FROM bb.audit_log WHERE entity_type='lead_request' AND entity_id=$1", [leadId])).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "lead.workflow_updated");
    assert.equal(events[0].before.assignedTo, null);
    assert.equal(events[0].after.assigneeName, secondManager.name);
    assert.equal(JSON.stringify(events[0].after).includes("Synthetic lead"), false);

    const context = await getLeadWorkflowContext(admin, { id: managž<êÚ$z{-®éÜj×[actor.rows[0].id]);
    const sharedTwo = await db.pool.query<{ id: string }>(
      "INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'general-hall','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05') RETURNING id", [actor.rows[0].id]);
    assert.notEqual(sharedOne.rows[0].id, sharedTwo.rows[0].id);
    await db.pool.query("INSERT INTO rooms (id,name) VALUES ('exclusive-zone-test','Exclusive test')");
    await db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','one',$1,'2099-02-20 10:00:00+05','2099-02-20 14:00:00+05')", [actor.rows[0].id]);
    await assert.rejects(() => db.pool.query("INSERT INTO slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at) VALUES ('block','2099-02-20',NULL,'exclusive-zone-test','two',$1,'2099-02-20 11:00:00+05','2099-02-20 15:00:00+05')", [actor.rows[0].id]), (error: { code?: string }) => error.code === "23P01");
  });

  it("018 on top of populated 017 keeps every old package, price, reservation and payment; legacy sale flags wait for site cutover", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "bb-before-018-"));
    const pre018 = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "018")) cpSync(join(MIGRATIONS_DIR, file), join(oldDir, file));
      await migrate(pre018.pool, oldDir);
      const q = (sql: string, p: unknown[] = []) => pre018.pool.query(sql, p);
      await q("INSERT INTO packages (id,name,sort_order) VALUES ('wow-party','WOW PARTY',0),('magic-party','MAGIC PARTY',1),('boom-party','BOOM PARTY',2)");
      await q("INSERT INTO price_rules (package_id,rule_type,amount_kzt) VALUES ('wow-party','base',37900),('wow-party','weekday',26530),('boom-party','base',79990)");
      const user = (await q("INSERT INTO users (email,name,password_hash,role) VALUES ('synthetic@example.invalid','M','x','manager') RETURNING id")).rows[0].id;
      const contact = (await q("INSERT INTO contacts (name,name_key,phone_e164,source) VALUES ('Synthetic historical','Ð¸ÑÑ‚Ð¾Ñ€Ð¸Ñ‡',$1,'manual') RETURNING id", [syntheticPhone()])).rows[0].id;
      const lead = (await q("INSERT INTO lead_requests (idempotency_key,contact_id,package_id,requested_date,children,status) VALUES (gen_random_uuid(),$1,'wow-party','2099-03-10',6,'confirmed') RETURNING id", [contact])).rows[0].id;
      const reservation = (await q(
        `INSERT INTO slot_reservations (kind,slot_date,room_id,lead_request_id,contact_id,package_id,children,price_kzt,price_source,created_by,starts_at,ends_at)
         SELECT 'booking','2099-03-10',id,$1,$2,'wow-party',6,37900,'base',$3,'2099-03-10 13:00+05','2099-03-10 17:00+05' FROM rooms ORDER BY sort_order LIMIT 1 RETURNING id`,
        [lead, contact, user],
      )).rows[0].id;
      await q("INSERT INTO manual_payment_facts (lead_request_id,amount_kzt,payment_method,idempotency_key,recorded_by) VALUES ($1,10000,'cash','key-018-history',$2)", [lead, user]);
      const before = {
        prices: (await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n,
        reservation: (await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0],
      };

      await migrate(pre018.pool, MIGRATIONS_DIR);

      assert.deepEqual((await q("SELECT id,is_active FROM packages ORDER BY id")).rows.map((r) => `${r.id}:${r.is_active}`), [
        "boom-bala-party:true", "boom-party:true", "happy-party:true", "magic-party:true", "star-party:true", "wow-party:true",
      ]);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 0, "the migration does not retire legacy IDs before the site switch");
      assert.equal((await q("SELECT count(*)::int n FROM price_rules WHERE package_id IN ('wow-party','boom-party')")).rows[0].n, before.prices, "price history is untouched");
      assert.deepEqual((await q("SELECT id,package_id,price_kzt,price_source,lead_request_id FROM slot_reservations WHERE id=$1", [reservation])).rows[0], before.reservation, "the booking and its agreed price are untouched");
      assert.equal((await q("SELECT count(*)::int n FROM manual_payment_facts WHERE lead_request_id=$1", [lead])).rows[0].n, 1, "the payment fact is untouched");
      assert.equal((await q("SELECT status FROM lead_requests WHERE id=$1", [lead])).rows[0].status, "confirmed");
      assert.equal((await q("SELECT count(*)::int n FROM booking_cards")).rows[0].n, 0, "no card is invented for an old booking");
      // Once explicitly archived after cutover, a later seed/update cannot reopen the legacy ID.
      await q("INSERT INTO package_archive (package_id, reason) VALUES ('magic-party','test retirement')");
      await q("UPDATE packages SET is_active = false WHERE id = 'magic-party'");
      await q("UPDATE packages SET is_active = true WHERE id = 'magic-party'");
      assert.equal((await q("SELECT is_active FROM packages WHERE id='magic-party'")).rows[0].is_active, false);
      assert.equal((await q("SELECT count(*)::int n FROM package_archive")).rows[0].n, 1);
      // A booking card cannot reference a terms version that does not exist.
      await assert.rejects(() => q("INSERT INTO booking_cards (reservation_id,package_id,terms_version,created_by,updated_by) VALUES ($1,'wow-party','v9',$2,$2)", [reservation, user]), /foreign key/i);
    } finally {
      await pre018.stop();
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it("019 and 020 preserve historical leads while adding time preferences and follow-up fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-before-019-"));
    const prior = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "019_lead_preferred_start_time.sql")) {
        cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
      }
      await migrate(prior.pool, dir);
      const contact = (await prior.pool.query("INSERT INTO bb.contacts (name,name_key,phone_e164,source) VALUES ('Synthetic historical lead','historical lead',$1,'birthday_form') RETURNING id", [syntheticPhone()])).rows[0].id;
      const oldLead = (await prior.pool.query("INSERT INTO bb.lead_requests (idempotency_key,contact_id,requested_date,slot_id,status) VALUES ($1,$2,'2099-02-03',2,'new') RETURNING id,seq,slot_id", [randomUUID(), contact])).rows[0];

      const applied = await migrate(prior.pool, MIGRATIONS_DIR);
      assert.deepEqual(applied.applied, ["019_lead_preferred_start_time.sql", "020_lead_follow_up.sql"]);
      const after = (await prior.pool.query("SELECT id,seq,slot_id,preferred_start_time FROM bb.lead_requests WHERE id=$1", [oldLead.id])).rows[0];
      assert.deepEqual(after, { ...oldLead, preferred_start_time: null }, "old identity, slot and status are preserved; no preference is invented");

      const legacy = (await prior.pool.query(
        "SELECT id,seq FROM bb.intake_insert_lead($1,$2,NULL,NULL,'2099-02-04',NULL,NULL,NULL,NULL,NULL,NULL,2::smallint)",
        [randomUUID(), contact],
      )).rows[0];
      assert.equal((await prior.pool.query("SELECT slot_id,preferred_start_time FROM bb.lead_requests WHERE id=$1", [legacy.id])).rows[0].slot_id, 2,
        "the old writer remains available for a safe application rollback");

      const preferred = "15:00";
      const inserted = (await prior.pool.query(
        "SELECT id,seq FROM bb.intake_insert_lead($1,$2,NULL,NULL,'2099-02-04',NULL,NULL,NULL,NULL,NULL,NULL,NULL,$3::time)",
        [randomUUID(), contact, preferred],
      )).rows[0];
      const exact = (await prior.pool.query("SELECT slot_id,to_char(preferred_start_time,'HH24:MI') preference FROM bb.lead_requests WHERE id=$1", [inserted.id])).rows[0];
      assert.deepEqual(exact, { slot_id: null, preference: preferred });
      await assert.rejects(
        () => prior.pool.query("SELECT * FROM bb.intake_insert_lead($1,$2,NULL,NULL,'2099-02-05',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'15:30'::time)", [randomUUID(), contact]),
        (error: { code?: string; constraint?: string }) => error.code === "23514" && error.constraint === "lead_requests_preferred_start_time_check",
      );
    } finally {
      await prior.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audit_log and price_rules are append-only", async () => {
    await db.pool.query("INSERT INTO audit_log (action) VALUES ('test.created')");
    await assert.rejects(() => db.pool.query("UPDATE audit_log SET action = 'test.changed'"), /append-only/);
    await assert.rejects(() => db.pool.query("DELETE FROM audit_log"), /append-only/);
    await assert.rejects(() => db.pool.query("TRUNCATE audit_log"), /append-only/);
    await db.pool.query("INSERT INTO packages (id, name) VALUES ('p1', 'P1')");
    await db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', 1000)");
    await assert.rejects(() => db.pool.query("UPDATE price_rules SET amount_kzt = 1"), /append-only/);
    await assert.rejects(() => db.pool.query("DELETE FROM price_rules"), /append-only/);
  });

  it("packages and rooms can never be deleted", async () => {
    await db.pool.query("INSERT INTO rooms (id, name) VALUES ('r1', 'R1')");
    await assert.rejects(() => db.pool.query("DELETE FROM rooms WHERE id = 'r1'"), /cannot be deleted/);
    await assert.rejects(() => db.pool.query("DELETE FROM packages WHERE id = 'p1'"), /cannot be deleted/);
  });

  it("price_rules enforces its shape", async () => {
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'date', 5000)"), /check/i); // date rule needs a date
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, rule_date, amount_kzt) VALUES ('p1', 'base', '2027-01-01', 5000)"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', NULL)"), /check/i); // only a date rule may clear
    await assert.rejects(() => db.pool.query("INSERT INTO price_rules (package_id, rule_type, amount_kzt) VALUES ('p1', 'base', 0)"), /check/i);
    await db.pool.query("INSERT INTO price_rules (package_id, rule_type, rule_date, amount_kzt) VALUES ('p1', 'date', '2027-01-01', NULL)");
  });

  it("a user referenced by the audit log or price history cannot be deleted (deactivate instead)", async () => {
    const { rows } = await db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('history-owner@example.invalid', 'Synthetic history owner', 'h', 'owner') RETURNING id");
    await db.pool.query("INSERT INTO audit_log (action, actor_user_id) VALUES ('test.acted', $1)", [rows[0].id]);
    await assert.rejects(() => db.pool.query("DELETE FROM users WHERE id = $1", [rows[0].id]), /foreign key|violates/i);
    const { rows: free } = await db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('free-editor@example.invalid', 'Synthetic free editor', 'h', 'editor') RETURNING id");
    await db.pool.query("DELETE FROM users WHERE id = $1", [free[0].id]); // no history: deletable
  });

  it("e-mail must be stored lower-case and users need a valid role", async () => {
    await assert.rejects(() => db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('Uppercase@example.invalid', 'Synthetic invalid user', 'h', 'owner')"), /check/i);
    await assert.rejects(() => db.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('invalid-role@example.invalid', 'Synthetic invalid role', 'h', 'admin')"), /invalid input value/);
  });
});
