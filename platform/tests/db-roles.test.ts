import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { API_GRANTS, applyRoles } from "../scripts/db-roles.ts";
import { authenticate, completeMfaLogin } from "../src/core/auth.ts";
import { confirmLead, createManualBooking, dayAvailability, monthAvailability, releaseReservation } from "../src/core/bookings.ts";
import { almatyToday } from "../src/core/dates.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { exportContacts } from "../src/core/export.ts";
import { submitConsent, submitLead } from "../src/core/intake.ts";
import { approveDocument, createDraft, getPublished, publishDocument } from "../src/core/legal.ts";
import { beginEnrollment, resetUserMfa } from "../src/core/mfa.ts";
import { createPost, deletePost, publicList, publicPost, publishPost, unpublishPost } from "../src/core/news.ts";
import { drainOutbox } from "../src/core/outbox.ts";
import { anonymizeContact, retentionReport, revokeConsent, updateRetentionSettings } from "../src/core/privacy.ts";
import { totpAt } from "../src/core/totp.ts";
import { changeRole, createUser, listUsers } from "../src/core/users.ts";
import { listContacts } from "../src/core/crm.ts";
import { makeUser, seedFromSite, startTestDb, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

const API_PW = "api-role-password-0123456789abc";
const ADMIN_PW = "admin-role-password-0123456789";
const FUTURE = (() => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 45);
  return d.toISOString().slice(0, 10);
})();
const KEY = Buffer.alloc(32, 21).toString("base64");

/** Tables the public API must never reach. Every table of the schema is either in API_GRANTS or here, so a new table forces a decision. */
const API_CLOSED = ["users", "sessions", "login_attempts", "user_mfa", "mfa_recovery_codes", "export_log", "retention_settings", "schema_migrations"];

describe("Database roles: one per application, least privilege", () => {
  let db: TestDb;
  let api: Pool;
  let admin: Pool;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  const as = (user: string, password: string) => {
    const u = new URL(db.url);
    u.username = user;
    u.password = password;
    return createPool(u.toString(), { max: 4 });
  };
  const denied = (p: Pool, sql: string, params: unknown[] = []) => assert.rejects(() => p.query(sql, params), /permission denied|must be owner|row-level security|violates row-level/i, sql);

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    owner = await makeUser(db.pool, "owner");
    await applyRoles(db.pool, { apiPassword: API_PW, adminPassword: ADMIN_PW });
    api = as("bb_api", API_PW);
    admin = as("bb_admin", ADMIN_PW);
    // documents are published through the ADMIN role: part of the smoke test below
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(admin, { id: owner.id, role: "owner" }, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(admin, { id: owner.id, role: "owner" }, d.id);
      await publishDocument(admin, { id: owner.id, role: "owner" }, d.id);
    }
  });
  after(async () => {
    await api.end();
    await admin.end();
    await db.stop();
  });

  it("every table of the schema is classified for the API role (a new table cannot slip in unreviewed)", async () => {
    const tables = (await db.pool.query("SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r'")).rows.map((r) => String(r.t)).sort();
    assert.deepEqual(tables, [...Object.keys(API_GRANTS), ...API_CLOSED].sort());
  });

  it("the roles are plain: no superuser, no DDL, no role creation, no row-security bypass, limited connections", async () => {
    const r = (await db.pool.query("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolconnlimit, rolconfig FROM pg_roles WHERE rolname IN ('bb_api','bb_admin') ORDER BY 1")).rows;
    assert.equal(r.length, 2);
    for (const x of r) {
      assert.deepEqual([x.rolsuper, x.rolcreatedb, x.rolcreaterole, x.rolbypassrls, x.rolreplication], [false, false, false, false, false]);
      assert.equal(x.rolconnlimit, 20);
      assert.ok(x.rolconfig.some((c: string) => c.startsWith("statement_timeout=")) && x.rolconfig.some((c: string) => c.startsWith("idle_in_transaction_session_timeout=")));
    }
  });

  describe("the public API role", () => {
    it("does everything the public API does: intake (enquiry and QR), availability, public documents and news", async () => {
      const lead = await submitLead(api, { idempotencyKey: randomUUID(), name: "Роль Апи", phone: "+77010000777", date: FUTURE, children: 5, consent: true });
      assert.equal(lead.duplicate, false);
      assert.equal((await submitLead(api, { idempotencyKey: randomUUID(), name: "Роль Апи", phone: "+77010000777", date: FUTURE, consent: true })).duplicate, false, "same person, a second enquiry");
      const qr = await submitConsent(api, { idempotencyKey: randomUUID(), name: "Роль Кьюар", acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.1", ipPepper: "p", userAgent: "UA" });
      assert.equal((await submitConsent(api, { idempotencyKey: randomUUID(), name: "Роль Кьюар Два", phone: "+7 701 000 07 78", acceptRules: true, acceptPersonalData: true })).duplicate, false);
      const key = randomUUID();
      const burst = await Promise.all(Array.from({ length: 5 }, () => submitConsent(api, { idempotencyKey: key, name: "Роль Гонка", acceptRules: true, acceptPersonalData: true })));
      assert.equal(new Set(burst.map((b) => b.registrationId)).size, 1, "the per-key lock works for this role too");
      assert.ok(qr.registrationId);
      assert.equal((await dayAvailability(api, FUTURE)).slots.length, 3);
      assert.ok((await monthAvailability(api, FUTURE.slice(0, 7))).roomCount >= 1);
      assert.equal((await getPublished(api)).length, 3);
      assert.deepEqual(await publicList(api), []);
      assert.equal(await publicPost(api, "nothing"), null);
      assert.equal((await api.query("SELECT 1 AS ok")).rows[0].ok, 1, "health check");
      // the notification task is queued for the ADMIN worker; the API never reads or sends it
      assert.ok((await db.pool.query("SELECT count(*)::int n FROM bb.outbox WHERE status = 'pending'")).rows[0].n >= 2);
    });

    it("cannot read staff, sessions, second factors, the export log, retention settings, migrations, the audit log or the notification queue", async () => {
      for (const t of ["users", "sessions", "login_attempts", "user_mfa", "mfa_recovery_codes", "export_log", "retention_settings", "schema_migrations", "audit_log", "outbox"]) {
        await denied(api, `SELECT * FROM bb.${t}`);
      }
    });

    it("cannot change or delete what it only reads or inserts, cannot anonymise, cannot touch history, cannot build or drop anything", async () => {
      await denied(api, "UPDATE bb.contacts SET name = 'x'");
      await denied(api, "UPDATE bb.contacts SET anonymized_at = now()");
      await denied(api, "UPDATE bb.contacts SET phone_e164 = NULL");
      await denied(api, "DELETE FROM bb.contacts");
      await denied(api, "DELETE FROM bb.lead_requests");
      await denied(api, "UPDATE bb.lead_requests SET status = 'cancelled'");
      await denied(api, "UPDATE bb.consent_events SET ip_hash = NULL");
      await denied(api, "DELETE FROM bb.consent_events");
      await denied(api, "INSERT INTO bb.users (email, name, password_hash, role) VALUES ('a@b.test', 'x', 'x', 'owner')");
      await denied(api, "UPDATE bb.legal_documents SET status = 'published'");
      await denied(api, "INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, created_by) VALUES ('block', current_date + 90, 1, 'roblox-room', gen_random_uuid())");
      await denied(api, "UPDATE bb.news_posts SET status = 'published'");
      await denied(api, "CREATE TABLE bb.evil (x int)");
      await denied(api, "CREATE TABLE public.evil (x int)");
      await denied(api, "TRUNCATE bb.contacts");
      await denied(api, "DROP TABLE bb.contacts");
      await denied(api, "ALTER TABLE bb.contacts DISABLE TRIGGER ALL");
      await denied(api, "ALTER ROLE bb_api SUPERUSER");
    });

    it("KNOWN LIMIT, kept visible: it can read the contacts table (the enquiry upsert needs it); a compromised API process could read contacts", async () => {
      assert.ok((await api.query("SELECT count(*)::int n FROM bb.contacts")).rows[0].n > 0);
    });
  });

  describe("the staff application role", () => {
    const owner2 = () => ({ id: owner.id, role: "owner" as const });

    it("runs the whole staff application: users, second factor, CRM, privacy, bookings, legal, news, export, notifications, retention", async () => {
      // users and the two-step login
      const staff = await createUser(admin, owner2(), { email: "role.manager@example.test", name: "Менеджер", role: "manager", password: TEST_PASSWORD });
      await changeRole(admin, owner2(), staff.id, "manager");
      assert.ok((await listUsers(admin, owner2())).length >= 2);
      const login = await authenticate(admin, { email: staff.email, password: TEST_PASSWORD, ip: "10.77.0.5", mfaRequired: true });
      assert.ok(login.ok && login.mfa === "enroll");
      const e = await beginEnrollment(admin, staff.id, KEY);
      const done = await completeMfaLogin(admin, { pendingToken: login.token, code: totpAt(e.secret, Date.now()), mfaKey: KEY, ip: "10.77.0.5" });
      assert.ok(done.ok);
      await resetUserMfa(admin, owner2(), staff.id);

      // CRM, privacy
      const q = await submitConsent(api, { idempotencyKey: randomUUID(), name: "Для Роли Админ", acceptRules: true, acceptPersonalData: true });
      const contactId = String((await db.pool.query("SELECT contact_id v FROM bb.consent_registrations WHERE id = $1", [q.registrationId])).rows[0].v);
      assert.ok((await listContacts(admin, owner2(), {})).total >= 1);
      assert.equal((await revokeConsent(admin, owner2(), contactId)).revokedDocuments, 1);
      assert.equal((await anonymizeContact(admin, owner2(), contactId)).anonymized, true);
      assert.ok((await retentionReport(admin, owner2())).totals.alreadyAnonymized >= 1);
      assert.equal((await updateRetentionSettings(admin, owner2(), { qrMonths: 12 })).autoEnabled, false);
      assert.ok((await exportContacts(admin, owner2(), { format: "csv", columns: ["name", "phone"] })).rowCount >= 1);

      // enquiry -> booking -> release, manual booking
      const lead = await submitLead(api, { idempotencyKey: randomUUID(), name: "Заявка Роли", phone: "+77010000888", date: FUTURE, children: 4, consent: true });
      const { reservationId } = await confirmLead(admin, owner2(), { leadId: lead.leadId, date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "wow-party" });
      await assert.rejects(() => createManualBooking(admin, owner2(), { date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "wow-party", name: "Конфликт", phone: "+77010000889" }), /slot_taken|conflict/i);
      await releaseReservation(admin, owner2(), reservationId, "ТЕСТ");
      await createManualBooking(admin, owner2(), { date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "wow-party", name: "Ручной Роли", phone: "+77010000890" });

      // notifications (the worker is part of the staff application)
      const sent: string[] = [];
      const r = await drainOutbox(admin, { send: async (t) => void sent.push(t), level: "minimal", limit: 20 });
      assert.ok(r.sent >= 1);

      // news, published for the API role to read
      const post = await createPost(admin, owner2(), { kind: "news", title: "Роль новость", body: "Текст" });
      await publishPost(admin, owner2(), post.id);
      assert.equal((await publicList(api)).length, 1, "the API role sees what the admin role published");
      await unpublishPost(admin, owner2(), post.id);
      assert.equal((await publicList(api)).length, 0);
      await deletePost(admin, owner2(), post.id);

      assert.ok((await admin.query("SELECT name FROM bb.schema_migrations")).rows.length >= 10, "the dashboard reads the schema version");
    });

    it("cannot change the structure, empty a table, rewrite the append-only history or become more powerful", async () => {
      await denied(admin, "CREATE TABLE bb.evil (x int)");
      await denied(admin, "TRUNCATE bb.contacts");
      await denied(admin, "TRUNCATE bb.audit_log");
      await denied(admin, "DROP TABLE bb.contacts");
      await denied(admin, "ALTER TABLE bb.contacts DISABLE TRIGGER ALL");
      await denied(admin, "DROP TRIGGER contacts_guard_trg ON bb.contacts");
      await denied(admin, "ALTER ROLE bb_admin SUPERUSER");
      await denied(admin, "DELETE FROM bb.contacts");
      await denied(admin, "DELETE FROM bb.slot_reservations");
      await denied(admin, "DELETE FROM bb.audit_log");
      await denied(admin, "DELETE FROM bb.consent_events");
      await denied(admin, "DELETE FROM bb.export_log");
      await assert.rejects(() => admin.query("UPDATE bb.audit_log SET action = 'x.y'"), /append-only|permission denied/i, "the trigger still guards the audit log");
    });
  });

  it("running it again changes nothing and rotates the passwords; weak passwords are refused", async () => {
    const before = JSON.stringify((await db.pool.query("SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('bb_api','bb_admin') ORDER BY 1,2,3")).rows);
    await applyRoles(db.pool, { apiPassword: "rotated-api-password-0123456789", adminPassword: "rotated-admin-password-012345678" });
    const after = JSON.stringify((await db.pool.query("SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('bb_api','bb_admin') ORDER BY 1,2,3")).rows);
    assert.equal(after, before);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'bb' AND policyname IN ('bb_api_access','bb_admin_access')")).rows[0].n, Object.keys(API_GRANTS).length + (await db.pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'r'")).rows[0].n);
    await assert.rejects(() => applyRoles(db.pool, { apiPassword: "short", adminPassword: ADMIN_PW }), /at least 24/);
  });
});
