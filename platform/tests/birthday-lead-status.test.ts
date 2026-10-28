import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setLeadStatus } from "../src/core/bookings.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ConflictError, ConsentUnavailableError, ForbiddenError, IntakeMisconfiguredError, ValidationError } from "../src/core/errors.ts";
import { externalLeadStatus, submitExternalLead } from "../src/core/intake.ts";
import { intakeSourceFromBearer } from "../src/core/intake-auth.ts";
import { approveDocument, createDraft, publishDocument } from "../src/core/legal.ts";
import { canManagerTransition, LEAD_STATUSES, MANAGER_TARGETS, type LeadStatus, type ManagerTarget } from "../src/core/lead-status.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

const FUTURE = (() => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
})();

/** Synthetic data only. */
const NAME = "Тестовая Заявка";
const PHONE = "+77010000042";
const FINGERPRINT_SECRET = "fingerprint-secret-0123456789abcdef";
const meta = { fingerprintSecret: FINGERPRINT_SECRET, ip: "198.51.100.23", userAgent: "node-test", ipPepper: "pepper-0123456789abcdef0123" };
const mobile = (over: Record<string, unknown> = {}) => ({ external_request_id: randomUUID(), name: NAME, phone: PHONE, date: FUTURE, children: 12, consent: true, ...over });

describe("birthday enquiries from the mobile app", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    owner = await makeUser(db.pool, "owner");
    manager = await makeUser(db.pool, "manager");
    editor = await makeUser(db.pool, "editor");
  });
  after(async () => {
    await db.stop();
  });

  async function publishConsent() {
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
  }
  const count = async (sql: string, params: unknown[] = []) => (await db.pool.query<{ n: number }>(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n;

  it("refuses to collect personal data while the consent text is not published, and stores nothing", async () => {
    const before = await count("bb.lead_requests WHERE source = 'mobile_app'");
    await assert.rejects(() => submitExternalLead(db.pool, mobile(), meta), ConsentUnavailableError);
    assert.equal(await count("bb.lead_requests WHERE source = 'mobile_app'"), before);
  });

  it("refuses to run without a fingerprint secret, and refuses a weak one", async () => {
    await publishConsent();
    await assert.rejects(() => submitExternalLead(db.pool, mobile(), { ...meta, fingerprintSecret: undefined }), IntakeMisconfiguredError);
    await assert.rejects(() => submitExternalLead(db.pool, mobile(), { ...meta, fingerprintSecret: "short" }), IntakeMisconfiguredError);
    assert.equal(await count("bb.lead_requests WHERE source = 'mobile_app'"), 0);
  });

  it("requires a UUID external_request_id", async () => {
    await assert.rejects(() => submitExternalLead(db.pool, mobile({ external_request_id: "not-a-uuid" }), meta), (e: unknown) => e instanceof ValidationError && "external_request_id" in (e as ValidationError).fields);
    await assert.rejects(() => submitExternalLead(db.pool, { ...mobile(), external_request_id: undefined }, meta), ValidationError);
  });

  let firstId = "";
  let firstExternal = "";
  it("creates a new enquiry once, with its consent event, notification task and audit record", async () => {
    const body = mobile();
    const r = await submitExternalLead(db.pool, body, meta);
    firstId = r.leadId;
    firstExternal = body.external_request_id;
    assert.equal(r.duplicate, false);
    const row = (await db.pool.query("SELECT source, external_request_id, request_fingerprint, status, status_changed_at FROM bb.lead_requests WHERE id = $1", [r.leadId])).rows[0];
    assert.equal(row.source, "mobile_app");
    assert.equal(row.external_request_id, firstExternal);
    assert.equal(row.status, "new");
    assert.match(row.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(row.status_changed_at instanceof Date);
    assert.equal(await count("bb.consent_events WHERE lead_request_id = $1 AND event = 'given'", [r.leadId]), 1);
    assert.equal(await count("bb.outbox WHERE topic = 'telegram.lead' AND ref_id = $1", [r.leadId]), 1);
    assert.equal(await count("bb.audit_log WHERE action = 'lead.created' AND entity_id = $1", [r.leadId]), 1);
  });

  it("the same request again returns the first result and creates nothing", async () => {
    const before = await count("bb.lead_requests");
    const body = mobile({ external_request_id: firstExternal });
    const r = await submitExternalLead(db.pool, body, meta);
    assert.equal(r.leadId, firstId);
    assert.equal(r.duplicate, true);
    assert.equal(await count("bb.lead_requests"), before);
    assert.equal(await count("bb.consent_events WHERE lead_request_id = $1", [firstId]), 1);
  });

  it("the same id with a different body is a conflict, and the stored enquiry is left unchanged", async () => {
    const before = await count("bb.lead_requests");
    await assert.rejects(() => submitExternalLead(db.pool, mobile({ external_request_id: firstExternal, children: 3 }), meta), (e: unknown) => e instanceof ConflictError && e.message === "idempotency_conflict");
    assert.equal(await count("bb.lead_requests"), before);
    assert.equal((await db.pool.query("SELECT children FROM bb.lead_requests WHERE id = $1", [firstId])).rows[0].children, 12);
  });

  it("parallel requests with the same id create exactly one enquiry", async () => {
    const id = randomUUID();
    const body = mobile({ external_request_id: id });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => submitExternalLead(db.pool, body, meta)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof submitExternalLead>>> => r.status === "fulfilled");
    assert.equal(ok.length, 6, "every parallel request gets the same answer, none fails");
    assert.equal(new Set(ok.map((r) => r.value.leadId)).size, 1);
    assert.equal(ok.filter((r) => r.value.duplicate === false).length, 1);
    assert.equal(await count("bb.lead_requests WHERE source = 'mobile_app' AND external_request_id = $1", [id]), 1);
  });

  it("the database refuses a mobile enquiry without the external id and a site enquiry with one", async () => {
    const c = (await db.pool.query("SELECT bb.intake_upsert_contact($1, $2, $3, 'birthday_form') AS id", ["Тест Ограничения", "тест ограничения", "+77010000777"])).rows[0].id;
    await assert.rejects(
      () => db.pool.query("INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, source) VALUES ($1, $2, $3, 'mobile_app')", [randomUUID(), c, FUTURE]),
      /lead_requests_external_id_by_source/,
    );
    await assert.rejects(
      () => db.pool.query("INSERT INTO bb.lead_requests (idempotency_key, contact_id, requested_date, source, external_request_id) VALUES ($1, $2, $3, 'birthday_form', $4)", [randomUUID(), c, FUTURE, randomUUID()]),
      /lead_requests_external_id_by_source/,
    );
  });

  describe("status read (bearer source, read-only)", () => {
    it("returns the status and the time of the last change, and nothing personal", async () => {
      const s = await externalLeadStatus(db.pool, "mobile_app", firstExternal);
      assert.ok(s);
      assert.equal(s.status, "new");
      assert.ok(s.statusChangedAt instanceof Date);
      assert.deepEqual(Object.keys(s).sort(), ["status", "statusChangedAt"]);
    });

    it("IDOR: an enquiry of the mobile source is not found with the site source, and an unknown id is not found either", async () => {
      assert.equal(await externalLeadStatus(db.pool, "birthday_form", firstExternal), null);
      assert.equal(await externalLeadStatus(db.pool, "mobile_app", randomUUID()), null);
    });
  });

  describe("manager status change (session, requests.manage, explicit matrix, audit)", () => {
    const actor = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });

    it("the transition matrix is explicit: every (from, to) pair is decided as written", () => {
      const expected: Record<LeadStatus, readonly ManagerTarget[]> = {
        new: ["in_progress", "cancelled"],
        in_progress: ["new", "cancelled"],
        confirmed: [],
        cancelled: [],
        completed: [],
      };
      for (const from of LEAD_STATUSES) for (const to of MANAGER_TARGETS) assert.equal(canManagerTransition(from, to), expected[from].includes(to), `${from} -> ${to}`);
    });

    it("an editor (no requests.manage) is refused and the status is unchanged", async () => {
      const { leadId } = await submitExternalLead(db.pool, mobile(), meta);
      await assert.rejects(() => setLeadStatus(db.pool, actor(editor), leadId, "in_progress"), ForbiddenError);
      assert.equal((await db.pool.query("SELECT status FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0].status, "new");
    });

    it("a manager moves new -> in_progress -> cancelled; a cancelled request cannot be re-opened", async () => {
      const { leadId } = await submitExternalLead(db.pool, mobile(), meta);
      await setLeadStatus(db.pool, actor(manager), leadId, "in_progress");
      await setLeadStatus(db.pool, actor(manager), leadId, "cancelled");
      await assert.rejects(() => setLeadStatus(db.pool, actor(manager), leadId, "in_progress"), (e: unknown) => e instanceof ConflictError && e.message === "lead_not_open");
      assert.equal((await db.pool.query("SELECT status FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0].status, "cancelled");
    });

    it("each change is written to the audit log with the actor and the before/after status, in the same transaction", async () => {
      const { leadId } = await submitExternalLead(db.pool, mobile(), meta);
      await setLeadStatus(db.pool, actor(manager), leadId, "in_progress");
      const rows = (await db.pool.query("SELECT actor_user_id, entity_type, entity_id, before, after FROM bb.audit_log WHERE action = 'lead.status_changed' AND entity_id = $1 ORDER BY id", [leadId])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].actor_user_id, manager.id);
      assert.equal(rows[0].entity_type, "lead_request");
      assert.deepEqual(rows[0].before, { status: "new" });
      assert.deepEqual(rows[0].after, { status: "in_progress" });
    });

    it("status_changed_at moves on a real change and not on a no-op", async () => {
      const { leadId } = await submitExternalLead(db.pool, mobile(), meta);
      const at0 = (await db.pool.query("SELECT status_changed_at FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0].status_changed_at as Date;
      await new Promise((r) => setTimeout(r, 15));
      await setLeadStatus(db.pool, actor(manager), leadId, "new");
      assert.equal(((await db.pool.query("SELECT status_changed_at FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0].status_changed_at as Date).getTime(), at0.getTime());
      await setLeadStatus(db.pool, actor(manager), leadId, "in_progress");
      assert.ok(((await db.pool.query("SELECT status_changed_at FROM bb.lead_requests WHERE id = $1", [leadId])).rows[0].status_changed_at as Date).getTime() > at0.getTime());
    });
  });

  describe("bearer source", () => {
    const req = (token?: string) => new Request("http://test/api/intake/lead", { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const SITE = "site-token-0123456789abcdefgh";
    const MOBILE = "mobile-token-0123456789abcdefg";

    it("the token selects the source; a token of one source is never the other source", () => {
      const env = { PLATFORM_INTAKE_TOKEN: SITE, PLATFORM_MOBILE_INTAKE_TOKEN: MOBILE };
      assert.equal(intakeSourceFromBearer(req(SITE), env), "birthday_form");
      assert.equal(intakeSourceFromBearer(req(MOBILE), env), "mobile_app");
      assert.equal(intakeSourceFromBearer(req("wrong-token-0123456789abcdefgh"), env), null);
      assert.equal(intakeSourceFromBearer(req(), env), null);
    });

    it("a missing or short secret fails closed", () => {
      assert.equal(intakeSourceFromBearer(req(MOBILE), {}), null);
      assert.equal(intakeSourceFromBearer(req("short"), { PLATFORM_MOBILE_INTAKE_TOKEN: "short" }), null);
    });

    it("two equal secrets accept nothing", () => {
      assert.equal(intakeSourceFromBearer(req(SITE), { PLATFORM_INTAKE_TOKEN: SITE, PLATFORM_MOBILE_INTAKE_TOKEN: SITE }), null);
    });

    it("the secret is compared with timingSafeEqual over digests", () => {
      const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "intake-auth.ts"), "utf8");
      assert.match(src, /timingSafeEqual\(a, b\)/);
      assert.doesNotMatch(src, /authorization.*===|=== *secret|secret *===/);
    });
  });

  it("nothing personal reaches the logs: a success and a refusal print no name or phone", async () => {
    const captured: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const sink = (...args: unknown[]) => captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    console.log = sink;
    console.info = sink;
    console.warn = sink;
    console.error = sink;
    try {
      const body = mobile({ name: "Секретная Фамилия", phone: "+77019998877" });
      await submitExternalLead(db.pool, body, meta);
      await assert.rejects(() => submitExternalLead(db.pool, { ...body, children: 99 }, meta));
      await assert.rejects(() => submitExternalLead(db.pool, { ...body, external_request_id: body.external_request_id, children: 4 }, meta), ConflictError);
    } finally {
      Object.assign(console, originals);
    }
    const text = captured.join("\n");
    assert.doesNotMatch(text, /Секретная|998877|\+7701/);
  });
});
