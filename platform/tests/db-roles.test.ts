import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { API_GRANTS, applyRoles } from "../scripts/db-roles.ts";
import { authenticate, completeMfaLogin } from "../src/core/auth.ts";
import { confirmLead, createManualBooking, dayAvailability, monthAvailability, releaseReservation } from "../src/core/bookings.ts";
import { almatyToday } from "../src/core/dates.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { exportContacts } from "../src/core/export.ts";
import { submitLead } from "../src/core/intake.ts";
import { approveDocument, createDraft, getPublished, publishDocument } from "../src/core/legal.ts";
import { beginEnrollment, resetUserMfa } from "../src/core/mfa.ts";
import { createPost, deletePost, publicList, publicPost, publishPost, unpublishPost } from "../src/core/news.ts";
import { drainOutbox } from "../src/core/outbox.ts";
import { anonymizeContact, retentionReport, revokeConsent, updateRetentionSettings } from "../src/core/privacy.ts";
import { totpAt } from "../src/core/totp.ts";
import { changeRole, createUser, listUsers } from "../src/core/users.ts";
import { listContacts } from "../src/core/crm.ts";
import { makeUser, seedFromSite, startTestDb, submitConsentV, TEST_PASSWORD, type TestDb } from "./helpers/db.ts";

const API_PW = "api-role-password-0123456789abc";
const ADMIN_PW = "admin-role-password-0123456789";
const FUTURE = (() => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 45);
  return d.toISOString().slice(0, 10);
})();
const KEY = Buffer.alloc(32, 21).toString("base64");

/** Tables the public API must never reach. Every table of the schema is either in API_GRANTS or here, so a new table forces a decision. */
const API_CLOSED = ["users", "sessions", "login_attempts", "user_mfa", "mfa_recovery_codes", "export_log", "retention_settings", "schema_migrations", "contacts", "lead_requests", "consent_registrations", "consent_events", "outbox", "audit_log", "attendance_entries", "attendance_corrections"];

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
      const qr = await submitConsentV(api, { idempotencyKey: randomUUID(), name: "Роль Кьюар", childrenCount: 1, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.1", ipPepper: "p", userAgent: "UA" });
      assert.equal((await submitConsentV(api, { idempotencyKey: randomUUID(), name: "Роль Кьюар Два", phone: "+7 701 000 07 78", childrenCount: 1, acceptRules: true, acceptPersonalData: true })).duplicate, false);
      const key = randomUUID();
      const burst = await Promise.all(Array.from({ length: 5 }, () => submitConsentV(api, { idempotencyKey: key, name: "Роль Гонка", childrenCount: 1, acceptRules: true, acceptPersonalData: true })));
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

    it("cannot read contacts, enquiries, registrations or the consent history: not whole, not by column, not by count, not by a join", async () => {
      for (const sql of [
        "SELECT * FROM bb.contacts",
        "SELECT count(*) FROM bb.contacts",
        "SELECT id FROM bb.contacts",
        "SELECT name FROM bb.contacts",
        "SELECT phone_e164 FROM bb.contacts WHERE phone_e164 LIKE '+7%'",
        "SELECT name_key FROM bb.contacts",
        "SELECT * FROM bb.lead_requests",
        "SELECT count(*) FROM bb.lead_requests",
        "SELECT contact_id, idempotency_key FROM bb.lead_requests",
        "SELECT * FROM bb.consent_registrations",
        "SELECT * FROM bb.consent_events",
        "SELECT ip_hash, user_agent FROM bb.consent_events",
        "SELECT c.name FROM bb.slot_reservations r JOIN bb.contacts c ON c.id = r.contact_id",
        "SELECT (SELECT name FROM bb.contacts LIMIT 1)",
        "SELECT row_to_json(c) FROM bb.contacts c",
        "SELECT * FROM bb.contacts TABLESAMPLE SYSTEM (100)",
        "COPY bb.contacts TO STDOUT",
        "WITH x AS (SELECT * FROM bb.contacts) SELECT * FROM x",
        "SELECT * FROM bb.slot_reservations",
        "SELECT contact_id FROM bb.slot_reservations",
        "SELECT price_kzt FROM bb.slot_reservations",
        "SELECT note FROM bb.slot_reservations",
      ]) await denied(api, sql);
      assert.ok((await api.query("SELECT slot_date, slot_id, room_id, released_at FROM bb.slot_reservations")).rows.length >= 0, "free/busy columns stay readable");
    });

    it("the only doors to personal data are the intake functions: each returns one row or only non-personal columns, with no way to list or search", async () => {
      const fns = (await db.pool.query("SELECT p.oid, p.proname, pg_get_function_result(p.oid) result, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.pronamespace = 'bb'::regnamespace AND p.proname LIKE 'intake\\_%' ORDER BY 2")).rows;
      assert.equal(fns.length, 9);
      for (const f of fns) {
        assert.equal(f.prosecdef, true, `${f.proname} is SECURITY DEFINER`);
        assert.ok((f.proconfig ?? []).some((c: string) => c.startsWith("search_path=")), `${f.proname} pins its search_path`);
        assert.ok(!/(name|phone|ip_hash|user_agent|note|email)/i.test(f.result), `${f.proname} returns no personal column (${f.result})`);
        assert.ok(!/\bSETOF\b/i.test(f.result), `${f.proname} is not an open-ended row source`);
      }
      // who may execute what: the API role runs exactly these nine and no other function of the schema
      const exec = (await db.pool.query("SELECT p.proname, has_function_privilege('bb_api', p.oid, 'EXECUTE') ok FROM pg_proc p WHERE p.pronamespace = 'bb'::regnamespace")).rows;
      for (const e of exec) assert.equal(e.ok, e.proname.startsWith("intake_"), e.proname);
      await denied(api, "SELECT bb.contacts_guard()");
      await denied(api, "SELECT bb.consent_events_guard()");
      await denied(api, "SELECT bb.harden_schema()");
    });

    it("the intake functions refuse what the public API must never do", async () => {
      const refused = (sql: string, params: unknown[] = []) => assert.rejects(() => api.query(sql, params), /unknown intake source|exactly one|not published|not an intake audit|unknown enquiry|invalid_parameter|violates|permission denied/i, sql);
      await refused("SELECT bb.intake_upsert_contact('x', 'x', '+77010000999', 'manual')");
      await refused("SELECT bb.intake_upsert_contact('x', 'x', '+77010000999', 'staff')");
      await refused("SELECT bb.intake_upsert_contact('x', 'x', 'not a phone', 'qr')");
      const doc = (await db.pool.query("SELECT id FROM bb.legal_documents WHERE status = 'published' LIMIT 1")).rows[0].id;
      const draft = await createDraft(admin, { id: owner.id, role: "owner" }, { kind: "privacy_policy", title: "черновик", body: "не опубликован" });
      const c = (await api.query("SELECT bb.intake_upsert_contact('Проверка Функций', 'проверка функций', NULL, 'qr') AS id")).rows[0].id;
      await refused("SELECT bb.intake_add_consent($1, $2, NULL, NULL, NULL, NULL)", [c, doc]); // neither enquiry nor registration
      await refused("SELECT bb.intake_add_consent($1, $2, NULL, NULL, $3, $3)", [c, doc, randomUUID()]); // both
      await refused("SELECT bb.intake_add_consent($1, $2, NULL, NULL, NULL, $3)", [c, draft.id, randomUUID()]); // a document that is not published
      await refused("SELECT bb.intake_queue_notification($1)", [randomUUID()]);
      await refused("SELECT bb.intake_audit('user.created', 'user', 'x')");
      await refused("SELECT bb.intake_audit('lead.created', 'user', 'x')");
      await refused("SELECT bb.intake_audit('mfa.reset', 'consent_registration', 'x')");
      // a withdrawal, a staff-made consent or a delete cannot be produced through any of them
      assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.consent_events WHERE contact_id = $1", [c])).rows[0].n, 0);
    });

    it("lookups need the unguessable handle: an unknown key finds nothing, a known one finds exactly its own row", async () => {
      const key = randomUUID();
      const lead = await submitLead(api, { idempotencyKey: key, name: "Ключ Проверка", phone: "+77010000444", date: FUTURE, consent: true });
      assert.equal((await api.query("SELECT * FROM bb.intake_find_lead($1)", [randomUUID()])).rows.length, 0);
      assert.equal((await api.query("SELECT * FROM bb.intake_find_lead(NULL)")).rows.length, 0);
      const found = (await api.query("SELECT * FROM bb.intake_find_lead($1)", [key])).rows;
      assert.equal(found.length, 1);
      assert.equal(found[0].id, lead.leadId);
      assert.deepEqual(Object.keys(found[0]).sort(), ["id", "seq"]);
      assert.equal((await api.query("SELECT * FROM bb.intake_find_registration($1)", [randomUUID()])).rows.length, 0);
      assert.equal((await api.query("SELECT * FROM bb.intake_registration_documents($1)", [randomUUID()])).rows.length, 0);
    });

    describe("a consent can only be written into the submission it belongs to", () => {
      const refusedWith = (sql: string, params: unknown[], re: RegExp) => assert.rejects(() => api.query(sql, params), re, sql);
      const ADD = "SELECT bb.intake_add_consent($1, $2, NULL, NULL, $3, $4)";
      let pd: string;
      let rules: string;
      const contact = async (name: string) => String((await api.query("SELECT bb.intake_upsert_contact($1, $2, NULL, 'qr') AS id", [name, name.toLowerCase()])).rows[0].id);
      const lead = async (contactId: string) => String((await api.query("SELECT id FROM bb.intake_insert_lead($1, $2, NULL, NULL, $3::date, NULL, NULL, NULL, NULL, NULL, NULL, NULL)", [randomUUID(), contactId, FUTURE])).rows[0].id);
      const registration = async (contactId: string) => String((await api.query("SELECT id FROM bb.intake_insert_registration($1, $2, 2::smallint)", [randomUUID(), contactId])).rows[0].id);
      const consents = async (where: string, id: string) => (await db.pool.query(`SELECT count(*)::int n FROM bb.consent_events WHERE ${where} = $1`, [id])).rows[0].n;

      before(async () => {
        pd = String((await db.pool.query("SELECT id FROM bb.legal_documents WHERE kind = 'personal_data_consent' AND status = 'published'")).rows[0].id);
        rules = String((await db.pool.query("SELECT id FROM bb.legal_documents WHERE kind = 'visit_rules' AND status = 'published'")).rows[0].id);
      });

      it("the happy paths work once: an enquiry with the personal-data consent, a registration with its documents", async () => {
        const c = await contact("Согласие Норма");
        const l = await lead(c);
        await api.query(ADD, [c, pd, l, null]);
        assert.equal(await consents("lead_request_id", l), 1);
        const r = await registration(c);
        await api.query(ADD, [c, rules, null, r]);
        await api.query(ADD, [c, pd, null, r]);
        assert.equal(await consents("registration_id", r), 2);
      });

      it("an enquiry of ANOTHER contact cannot receive a consent", async () => {
        const a = await contact("Согласие Хозяин");
        const b = await contact("Согласие Чужой");
        const leadOfA = await lead(a);
        await refusedWith(ADD, [b, pd, leadOfA, null], /does not belong to this contact/);
        assert.equal(await consents("lead_request_id", leadOfA), 0, "nothing was written");
        assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.consent_events WHERE contact_id = $1", [b])).rows[0].n, 0);
      });

      it("a registration of ANOTHER contact cannot receive a consent", async () => {
        const a = await contact("Регистрация Хозяин");
        const b = await contact("Регистрация Чужой");
        const regOfA = await registration(a);
        await refusedWith(ADD, [b, rules, null, regOfA], /does not belong to this contact/);
        assert.equal(await consents("registration_id", regOfA), 0);
      });

      it("unknown handles are refused, and so is a contact that does not exist", async () => {
        const c = await contact("Согласие Пустота");
        await refusedWith(ADD, [c, pd, randomUUID(), null], /does not belong to this contact/);
        await refusedWith(ADD, [c, pd, null, randomUUID()], /does not belong to this contact/);
        await refusedWith(ADD, [randomUUID(), pd, await lead(c), null], /does not belong to this contact/);
      });

      it("an old submission is closed: a leaked id from yesterday cannot be written into", async () => {
        const c = await contact("Согласие Старое");
        const l = await lead(c);
        const r = await registration(c);
        await db.pool.query("UPDATE bb.lead_requests SET created_at = now() - interval '1 hour' WHERE id = $1", [l]);
        await db.pool.query("UPDATE bb.consent_registrations SET created_at = now() - interval '1 hour' WHERE id = $1", [r]);
        await refusedWith(ADD, [c, pd, l, null], /not a current submission/);
        await refusedWith(ADD, [c, rules, null, r], /not a current submission/);
        await refusedWith("SELECT bb.intake_queue_notification($1)", [l], /unknown enquiry/);
      });

      it("an enquiry carries the personal-data consent only; the same consent is not recorded twice", async () => {
        const c = await contact("Согласие Вид");
        const l = await lead(c);
        await refusedWith(ADD, [c, rules, l, null], /only the personal-data consent/);
        await api.query(ADD, [c, pd, l, null]);
        await refusedWith(ADD, [c, pd, l, null], /already recorded/);
        const r = await registration(c);
        await api.query(ADD, [c, rules, null, r]);
        await refusedWith(ADD, [c, rules, null, r], /already recorded/);
        assert.equal(await consents("lead_request_id", l), 1);
        assert.equal(await consents("registration_id", r), 1);
      });

      describe("two submissions racing for the same consent: PostgreSQL keeps exactly one", () => {
        const given = async (where: string, id: string) => (await db.pool.query(`SELECT count(*)::int n FROM bb.consent_events WHERE ${where} = $1 AND event = 'given'`, [id])).rows[0].n;
        const waiting = async () => (await db.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'")).rows[0].n;
        const settle = () => new Promise((r) => setTimeout(r, 400));

        it("the indexes exist, are partial and unique, and leave withdrawals alone", async () => {
          const defs = (await db.pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'bb' AND tablename = 'consent_events' AND indexname LIKE '%given_uq'")).rows;
          assert.deepEqual(defs.map((d) => d.indexname).sort(), ["consent_events_lead_document_given_uq", "consent_events_registration_document_given_uq"]);
          for (const d of defs) assert.match(d.indexdef, /CREATE UNIQUE INDEX .* WHERE .*event = 'given'/s);
        });

        it("two transactions at once on an enquiry: the second waits for the first, then loses; exactly one 'given' remains", async () => {
          const c = await contact("Гонка Заявка");
          const l = await lead(c);
          const A = await api.connect();
          const B = await api.connect();
          try {
            await A.query("BEGIN");
            await B.query("BEGIN");
            await A.query(ADD, [c, pd, l, null]); // first writer, not committed yet
            const second = B.query(ADD, [c, pd, l, null]).then(() => "recorded", (e: Error) => e.message);
            await settle();
            assert.equal(await waiting(), 1, "the second transaction really is blocked on the first one's index entry");
            await A.query("COMMIT");
            assert.match(await second, /already recorded/, "and loses once the first commits");
            await B.query("ROLLBACK");
          } finally {
            A.release();
            B.release();
          }
          assert.equal(await given("lead_request_id", l), 1);
        });

        it("if the first transaction rolls back, the waiting second one takes its place: still exactly one", async () => {
          const c = await contact("Гонка Откат");
          const l = await lead(c);
          const A = await api.connect();
          const B = await api.connect();
          try {
            await A.query("BEGIN");
            await B.query("BEGIN");
            await A.query(ADD, [c, pd, l, null]);
            const second = B.query(ADD, [c, pd, l, null]).then(() => "recorded", (e: Error) => e.message);
            await settle();
            assert.equal(await waiting(), 1);
            await A.query("ROLLBACK");
            assert.equal(await second, "recorded");
            await B.query("COMMIT");
          } finally {
            A.release();
            B.release();
          }
          assert.equal(await given("lead_request_id", l), 1);
        });

        it("the same on a registration and its document", async () => {
          const c = await contact("Гонка Регистрация");
          const r = await registration(c);
          const A = await api.connect();
          const B = await api.connect();
          try {
            await A.query("BEGIN");
            await B.query("BEGIN");
            await A.query(ADD, [c, rules, null, r]);
            const second = B.query(ADD, [c, rules, null, r]).then(() => "recorded", (e: Error) => e.message);
            await settle();
            await A.query("COMMIT");
            assert.match(await second, /already recorded/);
            await B.query("ROLLBACK");
            await A.query(ADD, [c, pd, null, r]); // another document of the same registration is a different consent
          } finally {
            A.release();
            B.release();
          }
          assert.equal(await given("registration_id", r), 2);
        });

        it("many at once: ten parallel callers, one winner, nine told 'already recorded', one row", async () => {
          const c = await contact("Гонка Десять");
          const l = await lead(c);
          const results = await Promise.all(Array.from({ length: 10 }, () => api.query(ADD, [c, pd, l, null]).then(() => "ok", (e: Error) => e.message)));
          assert.equal(results.filter((x) => x === "ok").length, 1);
          assert.equal(results.filter((x) => /already recorded/.test(x)).length, 9);
          assert.equal(await given("lead_request_id", l), 1);
        });

        it("the index itself refuses a duplicate even without the function, but never blocks withdrawals or the history rules", async () => {
          const c = await contact("Гонка Индекс");
          const l = await lead(c);
          await api.query(ADD, [c, pd, l, null]);
          const dup = "INSERT INTO bb.consent_events (contact_id, document_id, event, method, lead_request_id) VALUES ($1, $2, 'given', 'web_checkbox', $3)";
          await assert.rejects(() => db.pool.query(dup, [c, pd, l]), (e: { code?: string }) => e.code === "23505");
          // a withdrawal by staff (tied to no enquiry) is a different kind of row: allowed, and repeatable
          const revoke = "INSERT INTO bb.consent_events (contact_id, document_id, event, method, note) VALUES ($1, $2, 'revoked', 'staff', 'subject_request')";
          await db.pool.query(revoke, [c, pd]);
          await db.pool.query(revoke, [c, pd]);
          // after a withdrawal the SAME enquiry still cannot be given a second 'given': a new consent means a new submission
          await assert.rejects(() => db.pool.query(dup, [c, pd, l]), (e: { code?: string }) => e.code === "23505");
          assert.equal(await given("lead_request_id", l), 1);
          // the history is still append-only
          await assert.rejects(() => db.pool.query("DELETE FROM bb.consent_events WHERE lead_request_id = $1", [l]), /append-only/);
        });
      });
    });

    it("has no right on any sequence of the schema: it cannot draw, read or set a counter", async () => {
      const seqs = (await db.pool.query("SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'S' ORDER BY 2")).rows;
      assert.ok(seqs.length >= 3, "the schema has sequences");
      for (const q of seqs) {
        for (const priv of ["USAGE", "SELECT", "UPDATE"]) assert.equal((await db.pool.query("SELECT has_sequence_privilege('bb_api', $1::oid, $2) AS ok", [q.oid, priv])).rows[0].ok, false, `${q.relname} ${priv}`);
        await denied(api, `SELECT nextval('bb.${q.relname}')`);
        await denied(api, `SELECT currval('bb.${q.relname}')`);
        await denied(api, `SELECT setval('bb.${q.relname}', 1)`);
        await denied(api, `SELECT last_value FROM bb.${q.relname}`);
      }
      // and the intake still works, because the functions run as their owner
      assert.ok((await submitConsentV(api, { idempotencyKey: randomUUID(), name: "Последовательность Ок", childrenCount: 1, acceptRules: true, acceptPersonalData: true })).registrationId);
      assert.ok((await submitLead(api, { idempotencyKey: randomUUID(), name: "Последовательность Ок", phone: "+77010000333", date: FUTURE, consent: true })).leadId);
    });

    it("KNOWN LIMIT, kept visible: whether an exact (name, phone) pair exists can be learned (an id comes back), never the data itself", async () => {
      const a = (await api.query("SELECT bb.intake_upsert_contact('Оракул Один', 'оракул один', '+77010000555', 'birthday_form') AS id")).rows[0].id;
      const b = (await api.query("SELECT bb.intake_upsert_contact('Оракул Один', 'оракул один', '+77010000555', 'birthday_form') AS id")).rows[0].id;
      assert.equal(a, b, "the same pair gives the same contact (and so confirms it exists)");
      const other = (await api.query("SELECT bb.intake_upsert_contact('Оракул Один', 'оракул один', '+77010000556', 'birthday_form') AS id")).rows[0].id;
      assert.notEqual(a, other);
    });

    it("sees only what is public: not a draft document, not an unpublished post", async () => {
      assert.ok((await db.pool.query("SELECT count(*)::int n FROM bb.legal_documents WHERE status <> 'published'")).rows[0].n >= 1, "there is a draft in the database");
      assert.equal((await api.query("SELECT count(*)::int n FROM bb.legal_documents WHERE status <> 'published'")).rows[0].n, 0);
      const post = await createPost(admin, { id: owner.id, role: "owner" }, { kind: "news", title: "Черновик для роли", body: "секрет" });
      assert.equal((await api.query("SELECT count(*)::int n FROM bb.news_posts WHERE id = $1", [post.id])).rows[0].n, 0, "an unpublished post does not exist for the API");
      await publishPost(admin, { id: owner.id, role: "owner" }, post.id);
      assert.equal((await api.query("SELECT count(*)::int n FROM bb.news_posts WHERE id = $1", [post.id])).rows[0].n, 1);
      await unpublishPost(admin, { id: owner.id, role: "owner" }, post.id);
      assert.equal((await api.query("SELECT count(*)::int n FROM bb.news_posts WHERE id = $1", [post.id])).rows[0].n, 0, "and it disappears again");
      await deletePost(admin, { id: owner.id, role: "owner" }, post.id);
    });

    it("cannot change or delete anything directly, cannot anonymise, cannot touch history, cannot build or drop anything", async () => {
      for (const sql of [
        "UPDATE bb.contacts SET name = 'x'", "UPDATE bb.contacts SET anonymized_at = now()", "UPDATE bb.contacts SET last_activity_at = now()", "DELETE FROM bb.contacts",
        "INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('a', 'a', '+77010000001', 'qr')",
        "INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date) VALUES (gen_random_uuid(), gen_random_uuid(), current_date)",
        "DELETE FROM bb.lead_requests", "UPDATE bb.lead_requests SET status = 'cancelled'",
        "INSERT INTO bb.consent_events (contact_id, document_id, event, method) VALUES (gen_random_uuid(), gen_random_uuid(), 'revoked', 'staff')",
        "UPDATE bb.consent_events SET ip_hash = NULL", "DELETE FROM bb.consent_events",
        "INSERT INTO bb.outbox (topic, ref_id) VALUES ('telegram.lead', gen_random_uuid())",
        "INSERT INTO bb.audit_log (action) VALUES ('user.created')",
        "INSERT INTO bb.users (email, name, password_hash, role) VALUES ('a@b.test', 'x', 'x', 'owner')",
        "UPDATE bb.legal_documents SET status = 'published'",
        "INSERT INTO bb.slot_reservations (kind, slot_date, slot_id, room_id, created_by) VALUES ('block', current_date + 90, 1, 'roblox-room', gen_random_uuid())",
        "UPDATE bb.news_posts SET status = 'published'",
        "CREATE TABLE bb.evil (x int)", "CREATE TABLE public.evil (x int)", "TRUNCATE bb.contacts", "DROP TABLE bb.contacts",
        "ALTER TABLE bb.contacts DISABLE TRIGGER ALL", "ALTER ROLE bb_api SUPERUSER",
        "CREATE FUNCTION bb.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      ]) await denied(api, sql);
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
      const q = await submitConsentV(api, { idempotencyKey: randomUUID(), name: "Для Роли Админ", childrenCount: 1, acceptRules: true, acceptPersonalData: true });
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

    it("may use the sequences it needs (serial columns), and nothing else about them is a way in", async () => {
      const seqs = (await db.pool.query("SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bb' AND c.relkind = 'S'")).rows;
      for (const q of seqs) assert.equal((await db.pool.query("SELECT has_sequence_privilege('bb_admin', $1::oid, 'USAGE') AS ok", [q.oid])).rows[0].ok, true);
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
