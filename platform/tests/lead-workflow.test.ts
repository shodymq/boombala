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

    const context = await getLeadWorkflowContext(admin, { id: manager.id, role: "manager" }, leadId);
    assert.equal(context.history.length, 1);
    assert.equal(context.history[0].actorName, manager.name);
    assert.ok(context.assignees.some((item) => item.id === secondManager.id));
    assert.ok(!context.assignees.some((item) => item.id === editor.id), "editors are not assignable");
  });

  it("rejects a stale form submission with a clear conflict and does not append a second audit entry", async () => {
    const changed = await updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, {
      leadId, expectedVersion: 2, assignedTo: manager.id, nextAction: "clarify_details", followUpAtLocal: "2095-04-03T11:00",
    });
    assert.equal(changed.version, 3);
    await assert.rejects(updateLeadWorkflow(admin, { id: secondManager.id, role: "manager" }, {
      leadId, expectedVersion: 2, assignedTo: secondManager.id, nextAction: "prepare_offer", followUpAtLocal: "2095-04-03T12:00",
    }), (error: unknown) => error instanceof ConflictError && error.message === "stale_update");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM bb.audit_log WHERE entity_type='lead_request' AND entity_id=$1", [leadId])).rows[0].n, 2);
  });

  it("allows only one concurrent manager update at a given version", async () => {
    const outcomes = await Promise.allSettled([
      updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, { leadId: raceLeadId, expectedVersion: 1, assignedTo: manager.id, nextAction: "call_customer", followUpAtLocal: "2095-05-01T10:00" }),
      updateLeadWorkflow(admin, { id: secondManager.id, role: "manager" }, { leadId: raceLeadId, expectedVersion: 1, assignedTo: secondManager.id, nextAction: "prepare_offer", followUpAtLocal: "2095-05-01T11:00" }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert.ok(rejected?.reason instanceof ConflictError);
    assert.equal(rejected.reason.message, "stale_update");
    assert.equal((await admin.query("SELECT workflow_version FROM bb.lead_requests WHERE id=$1", [raceLeadId])).rows[0].workflow_version, 2);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM bb.audit_log WHERE entity_type='lead_request' AND entity_id=$1", [raceLeadId])).rows[0].n, 1);
  });

  it("does not accept a stale no-op while another transaction has an uncommitted workflow change", async () => {
    const staleNoopLeadId = await createLead();
    const blocker = await admin.connect();
    await blocker.query("BEGIN");
    try {
      await blocker.query(
        "UPDATE bb.lead_requests SET assigned_to=$2,next_action='call_customer',follow_up_at='2095-05-01T05:00:00Z',workflow_version=workflow_version+1 WHERE id=$1",
        [staleNoopLeadId, manager.id],
      );
      const staleNoop = updateLeadWorkflow(admin, { id: secondManager.id, role: "manager" }, {
        leadId: staleNoopLeadId, expectedVersion: 1, assignedTo: null, nextAction: null, followUpAtLocal: null,
      });

      let isWaitingForRowLock = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const waiting = await db.pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock' AND state='active'
                AND query LIKE 'SELECT l.id, l.status, l.assigned_to%'
           ) AS waiting`,
        );
        if (waiting.rows[0]?.waiting) {
          isWaitingForRowLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(isWaitingForRowLock, true, "stale no-op waits for the concurrent row update");
      await blocker.query("COMMIT");
      await assert.rejects(staleNoop, (error: unknown) => error instanceof ConflictError && error.message === "stale_update");
      const final = (await admin.query("SELECT workflow_version, assigned_to, next_action FROM bb.lead_requests WHERE id=$1", [staleNoopLeadId])).rows[0];
      assert.equal(final.workflow_version, 2);
      assert.equal(final.assigned_to, manager.id);
      assert.equal(final.next_action, "call_customer");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("claims an unassigned lead without changing its status and refuses silent takeover", async () => {
    const claimed = await claimLead(admin, { id: manager.id, role: "manager" }, { leadId: claimLeadId, expectedVersion: 1 });
    assert.equal(claimed.assignedTo, manager.id);
    assert.equal(claimed.version, 2);
    assert.equal((await admin.query("SELECT status FROM bb.lead_requests WHERE id=$1", [claimLeadId])).rows[0].status, "new");
    await assert.rejects(claimLead(admin, { id: secondManager.id, role: "manager" }, { leadId: claimLeadId, expectedVersion: 2 }), (error: unknown) => error instanceof ConflictError && error.message === "lead_already_assigned");
  });

  it("filters overdue open leads in Almaty and keeps terminal statuses out", async () => {
    const overdueId = await createLead();
    const past = instantToAlmatyLocalDateTime(new Date(Date.now() - 60_000));
    await updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, {
      leadId: overdueId, expectedVersion: 1, assignedTo: manager.id, nextAction: "await_reply", followUpAtLocal: past,
    });
    const overdue = await searchLeads(admin, { id: manager.id, role: "manager" }, { overdue: true });
    const found = overdue.items.find((item) => item.id === overdueId);
    assert.ok(found);
    assert.equal(found.followUpOverdue, true);
    await admin.query("UPDATE bb.lead_requests SET status='cancelled' WHERE id=$1", [overdueId]);
    const terminal = await searchLeads(admin, { id: manager.id, role: "manager" }, { overdue: true });
    assert.ok(!terminal.items.some((item) => item.id === overdueId));
  });

  it("validates task/time pairs, target role and caller permission", async () => {
    const validationLeadId = await createLead();
    const base = { leadId: validationLeadId, expectedVersion: 1, assignedTo: null, nextAction: null, followUpAtLocal: null };
    await assert.rejects(updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, { ...base, nextAction: "call_customer" }), ValidationError);
    await assert.rejects(updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, { ...base, nextAction: "unsupported" }), ValidationError);
    await assert.rejects(updateLeadWorkflow(admin, { id: manager.id, role: "manager" }, { ...base, assignedTo: editor.id }), ValidationError);
    await assert.rejects(updateLeadWorkflow(admin, { id: editor.id, role: "editor" }, base), ForbiddenError);
  });

  it("uses the same permission and compare-and-set logic through the typed legacy bridge operations", async () => {
    const bridgeLeadId = await createLead();
    const result = await bridgeUpdateLeadWorkflow(admin, sessionFor(manager), {
      leadId: bridgeLeadId, expectedVersion: 1, assignedTo: manager.id, nextAction: "schedule_visit", followUpAtLocal: "2095-07-02T14:20",
    });
    assert.equal(result.version, 2);
    await assert.rejects(bridgeUpdateLeadWorkflow(admin, sessionFor(editor), {
      leadId: bridgeLeadId, expectedVersion: 2, assignedTo: editor.id, nextAction: "schedule_visit", followUpAtLocal: "2095-07-02T15:20",
    }), ForbiddenError);
    await assert.rejects(bridgeClaimLead(admin, sessionFor(secondManager), { leadId: bridgeLeadId, expectedVersion: 2 }), (error: unknown) => error instanceof ConflictError && error.message === "lead_already_assigned");
  });

  it("keeps the no-DATABASE_URL bridge path on explicit allowlisted operations", () => {
    const actions = readFileSync(new URL("../src/app/(admin)/requests/actions.ts", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("../src/server/legacy-bridge.ts", import.meta.url), "utf8");
    assert.match(actions, /if \(legacyBridgeEnabled\(\)\) \{[\s\S]*?bridgeRpc\("requests\.workflow\.update"/);
    assert.match(actions, /if \(legacyBridgeEnabled\(\)\) \{[\s\S]*?bridgeRpc\("requests\.workflow\.claim"/);
    assert.match(bridge, /case "requests\.workflow\.update":/);
    assert.match(bridge, /case "requests\.workflow\.claim":/);
    assert.doesNotMatch(bridge, /case "sql\.|case "query/);
  });

  it("adds migration 020 without rewriting existing leads or statuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-lead-pre020-"));
    const prior = await startTestDb({ migrate: false });
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "020_lead_follow_up.sql")) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
      const { migrate } = await import("../src/core/migrate.ts");
      await migrate(prior.pool, dir);
      const contact = (await prior.pool.query("INSERT INTO bb.contacts (name,name_key,phone_e164,source) VALUES ('Synthetic historical','synthetic historical',$1,'manual') RETURNING id", [syntheticPhone()])).rows[0].id;
      const existing = (await prior.pool.query("INSERT INTO bb.lead_requests (idempotency_key,contact_id,requested_date,status) VALUES ($1,$2,'2099-08-01','in_progress') RETURNING id,seq,status,assigned_to", [randomUUID(), contact])).rows[0];
      await migrate(prior.pool, MIGRATIONS_DIR);
      assert.deepEqual((await prior.pool.query("SELECT id,seq,status,assigned_to,next_action,follow_up_at,workflow_version FROM bb.lead_requests WHERE id=$1", [existing.id])).rows[0], {
        ...existing, next_action: null, follow_up_at: null, workflow_version: 1,
      });
    } finally {
      await prior.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
