import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { confirmLead, createManualBooking, releaseReservation, setLeadStatus } from "../src/core/bookings.ts";
import { getContact, listContacts } from "../src/core/crm.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ConflictError, ForbiddenError, NotFoundError, RetentionDisabledError, ValidationError } from "../src/core/errors.ts";
import { exportContacts } from "../src/core/export.ts";
import { hashIp, submitLead } from "../src/core/intake.ts";
import { approveDocument, createDraft, publishDocument } from "../src/core/legal.ts";
import {
  ANONYMIZED_NAME,
  anonymizeContact,
  assessContact,
  getRetentionSettings,
  retentionReport,
  revokeConsent,
  runRetention,
  updateRetentionSettings,
} from "../src/core/privacy.ts";
import { makeUser, seedFromSite, startTestDb, submitConsentV, syntheticPhone, type TestDb } from "./helpers/db.ts";

const FUTURE = (() => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 40);
  return d.toISOString().slice(0, 10);
})();

describe("Privacy: withdrawal of consent, anonymisation, retention", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  const meta = { ip: "198.51.100.9", userAgent: "TestBrowser/1.0" };
  const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
  const scalar = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rows[0].v;
  const visitorPhoneFragments = new Set<string>();
  const visitorNames = new Set<string>();
  const rememberName = (name: string | null | undefined) => {
    const value = (name ?? "").trim();
    if (value) visitorNames.add(value);
  };
  const rememberPhone = (phone: string | null | undefined) => {
    const digits = (phone ?? "").replace(/\D/g, "");
    if (phone && digits.length >= 8) {
      visitorPhoneFragments.add(phone);
      visitorPhoneFragments.add(digits);
      visitorPhoneFragments.add(digits.slice(-8));
    }
  };

  /** A QR registration with an IP hash and a browser string, as the real route records them. */
  const register = (name: string, phone?: string | null) => {
    rememberName(name);
    rememberPhone(phone);
    return submitConsentV(db.pool, { idempotencyKey: randomUUID(), name, phone, childrenCount: 1, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.5", ipPepper: "pepper", userAgent: "Mozilla/5.0 (Test)" });
  };
  const contactOf = async (registrationId: string) => String(await scalar("SELECT contact_id v FROM bb.consent_registrations WHERE id = $1", [registrationId]));
  const lead = (name: string, phone: string) => {
    rememberName(name);
    rememberPhone(phone);
    return { idempotencyKey: randomUUID(), name, phone, date: FUTURE, children: 5, consent: true as const };
  };
  const manualBooking = (input: Parameters<typeof createManualBooking>[2]) => {
    rememberName(input.name);
    rememberPhone(input.phone);
    return createManualBooking(db.pool, owner, input);
  };
  const events = async (contactId: string) => (await q("SELECT event, note, ip_hash, user_agent, document_id FROM bb.consent_events WHERE contact_id = $1 ORDER BY id", [contactId])).rows;
  const auditText = async () => JSON.stringify((await q("SELECT action, entity_type, entity_id, before, after, ip, user_agent FROM bb.audit_log")).rows);

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    owner = await makeUser(db.pool, "owner");
    manager = await makeUser(db.pool, "manager");
    editor = await makeUser(db.pool, "editor");
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
  });
  after(async () => db.stop());

  describe("who may do it", () => {
    it("only the Owner can withdraw consent, anonymise, read the report or change the settings", async () => {
      const c = await contactOf((await register("Права Проверка")).registrationId);
      for (const who of [manager, editor]) {
        await assert.rejects(() => revokeConsent(db.pool, who, c), ForbiddenError);
        await assert.rejects(() => anonymizeContact(db.pool, who, c), ForbiddenError);
        await assert.rejects(() => assessContact(db.pool, who, c), ForbiddenError);
        await assert.rejects(() => retentionReport(db.pool, who), ForbiddenError);
        await assert.rejects(() => runRetention(db.pool, who, { dryRun: false }), ForbiddenError);
        await assert.rejects(() => getRetentionSettings(db.pool, who), ForbiddenError);
        await assert.rejects(() => updateRg�|��$z{-���jםd"], "QR + enquiry: reported as untouchable");
      assert.ok(!late.eligible.some((i) => i.contactId === withLead));
      assert.ok(late.totals.outsideQrRule >= 1, "enquiry/booking-only contacts are outside the QR rule");

      const text = JSON.stringify(late);
      for (const secret of ["Срок", qrOnlyPhone, withLeadPhone, "Одиночный"]) assert.ok(!text.includes(secret), `the report must not contain ${secret}`);

      const dry = await runRetention(db.pool, owner, { now: plusMonths(reg, 12, 1000) });
      assert.deepEqual({ dryRun: dry.dryRun, processed: dry.processed }, { dryRun: true, processed: 0 });
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.contacts WHERE anonymized_at IS NOT NULL")), anonymisedBefore, "a dry run changes nothing");
    });

    it("a real run is refused while automatic processing is off or not legally confirmed; the settings cannot skip the confirmation", async () => {
      const now = plusMonths(new Date(), 13);
      await assert.rejects(() => runRetention(db.pool, owner, { dryRun: false, now }), RetentionDisabledError);
      await assert.rejects(() => updateRetentionSettings(db.pool, owner, { autoEnabled: true }), (e: unknown) => e instanceof ValidationError && "autoEnabled" in e.fields);
      await assert.rejects(() => q("UPDATE bb.retention_settings SET auto_enabled = true"), /check constraint/i, "the database enforces it too");
      for (const bad of [0, 121, 1.5, Number.NaN]) await assert.rejects(() => updateRetentionSettings(db.pool, owner, { qrMonths: bad }), ValidationError);
      assert.deepEqual(await getRetentionSettings(db.pool, owner), { qrMonths: 12, autoEnabled: false, legalConfirmedAt: null });
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'retention.run'"), 0);
    });

    it("after the Owner records the confirmation and enables it, a run processes only eligible QR contacts and is repeatable", async () => {
      const keepPhone = syntheticPhone();
      const gonePhone = syntheticPhone();
      const tiedPhone = syntheticPhone();
      const keep = await contactOf((await register("Срок Свежий", keepPhone)).registrationId); // registered "today"
      const gone = await contactOf((await register("Срок Истёк", gonePhone)).registrationId);
      const tied = await contactOf((await register("Срок Связан", tiedPhone)).registrationId);
      await submitLead(db.pool, lead("Срок Связан", tiedPhone));
      const settings = await updateRetentionSettings(db.pool, owner, { legalConfirmed: true, autoEnabled: true, qrMonths: 12 }, meta);
      assert.equal(settings.autoEnabled, true);
      assert.ok(settings.legalConfirmedAt);

      // time machine: 13 months from "today" makes everything registered so far expired
      const now = plusMonths(new Date(), 13);
      const preview = await retentionReport(db.pool, owner, now);
      const wouldTouch = preview.eligible.map((i) => i.contactId);
      assert.ok(wouldTouch.includes(gone) && wouldTouch.includes(keep), "both are past the period at that date");
      assert.ok(!wouldTouch.includes(tied));

      const run = await runRetention(db.pool, owner, { dryRun: false, now }, meta);
      assert.equal(run.processed, wouldTouch.length);
      for (const id of wouldTouch) {
        assert.equal(await scalar("SELECT anonymized_at IS NOT NULL v FROM bb.contacts WHERE id = $1", [id]), true);
        const ev = await events(id);
        assert.ok(ev.some((e) => e.event === "revoked" && e.note === "retention_expired"), "the revocation is part of the history");
        assert.ok(ev.every((e) => e.ip_hash === null && e.user_agent === null));
      }
      assert.equal(await scalar("SELECT anonymized_at IS NULL v FROM bb.contacts WHERE id = $1", [tied]), true, "the contact with an enquiry was left alone");
      assert.equal(await scalar("SELECT phone_e164 v FROM bb.contacts WHERE id = $1", [tied]), tiedPhone);

      const again = await runRetention(db.pool, owner, { dryRun: false, now }, meta);
      assert.equal(again.processed, 0, "repeatable: nothing left to do");
      const audit = await auditText();
      assert.ok(audit.includes("retention.run") && audit.includes("retention.settings_changed"));
      for (const secret of ["Срок Истёк", gonePhone, "Срок Связан", tiedPhone]) assert.ok(!audit.includes(secret));

      // withdrawing the confirmation switches automatic processing off again
      const off = await updateRetentionSettings(db.pool, owner, { legalConfirmed: false });
      assert.deepEqual({ auto: off.autoEnabled, confirmed: off.legalConfirmedAt }, { auto: false, confirmed: null });
      await assert.rejects(() => runRetention(db.pool, owner, { dryRun: false, now }), RetentionDisabledError);
    });
  });

  describe("what a withdrawal covers, and what is left afterwards", () => {
    it("one button withdraws EVERY personal-data consent of the contact: the QR one and the one given with the enquiry, also under another document version", async () => {
      const name = "Раиса Обаесогласия";
      const phone = syntheticPhone();
      const c = await contactOf((await register(name, phone)).registrationId); // QR under the current version
      const oldDoc = String(await scalar("SELECT id v FROM bb.legal_documents WHERE kind = 'personal_data_consent' AND status = 'published'"));
      const next = await createDraft(db.pool, owner, { kind: "personal_data_consent", title: "новая редакция", body: "Текст personal_data_consent 2" });
      await approveDocument(db.pool, owner, next.id);
      await publishDocument(db.pool, owner, next.id);
      const l = await submitLead(db.pool, lead(name, phone)); // the enquiry is accepted under the NEW version
      assert.equal(String(await scalar("SELECT contact_id v FROM bb.lead_requests WHERE id = $1", [l.leadId])), c);

      const given = (await events(c)).filter((e) => e.event === "given" && e.document_id);
      const docs = new Set(given.map((e) => String(e.document_id)));
      assert.ok(docs.has(oldDoc) && docs.has(String(next.id)), "the contact holds consents under two document versions");

      const rev = await revokeConsent(db.pool, owner, c, meta);
      assert.equal(rev.revokedDocuments, 2, "both versions are withdrawn");
      assert.equal(rev.assessment.consentActive, false);

      const card = (await getContact(db.pool, owner, c))!;
      const consents = card.consents;
      assert.deepEqual(consents.filter((e) => e.event === "revoked").map((e) => e.origin), ["staff", "staff"]);
      assert.ok(consents.some((e) => e.event === "given" && e.origin === "qr"), "the history says which consent came from the QR registration");
      assert.ok(consents.some((e) => e.event === "given" && e.origin === "enquiry" && e.enquirySeq !== null), "and which one came with an enquiry (with its number)");
      // the withdrawal changed nothing else: the enquiry and the contact stay
      assert.equal(await scalar("SELECT phone_e164 v FROM bb.contacts WHERE id = $1", [c]), phone);
      assert.equal(await scalar("SELECT status v FROM bb.lead_requests WHERE id = $1", [l.leadId]), "new");
      assert.deepEqual((await assessContact(db.pool, owner, c))!.blockers, ["open_enquiry", "enquiry_record"]);
    });

    it("after anonymisation no table of the schema still holds the name, the phone, the address or the browser of the visitor", async () => {
      const name = "Реидент Проверкин";
      const phone = syntheticPhone();
      // values that exist nowhere else in this database, so the search below can only find this visitor's traces
      const reg = await submitConsentV(db.pool, { idempotencyKey: randomUUID(), name, phone, childrenCount: 1, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.77", ipPepper: "pepper-reident", userAgent: "UniqueBrowser/9.99-reident" });
      const c = await contactOf(reg.registrationId);
      const ipHash = hashIp("203.0.113.77", "pepper-reident")!;
      assert.ok(JSON.stringify((await q("SELECT ip_hash, user_agent FROM bb.consent_events WHERE contact_id = $1", [c])).rows).includes(ipHash), "before: the hash and the browser string are stored");
      await revokeConsent(db.pool, owner, c, meta);
      await anonymizeContact(db.pool, owner, c, meta);
      const tables = (await q("SELECT table_name t FROM information_schema.tables WHERE table_schema = 'bb' AND table_type = 'BASE TABLE'")).rows.map((r) => String(r.t));
      assert.ok(tables.includes("consent_events") && tables.includes("audit_log") && tables.includes("export_log"));
      let dump = "";
      for (const t of tables) dump += JSON.stringify((await q(`SELECT x::text AS row FROM bb."${t}" x`)).rows);
      for (const needle of ["Реидент", "Проверкин", phone, phone.replace(/\D/g, ""), "203.0.113.77", ipHash, "UniqueBrowser"]) {
        assert.ok(!dump.includes(needle), `no table may contain ${needle}`);
      }
      // what remains about the contact: an id, the times of its registrations and the document versions, nothing that names a person
      const row = (await q("SELECT name, name_key, phone_e164, source, marketing_opt_in, phone_verification FROM bb.contacts WHERE id = $1", [c])).rows[0];
      assert.deepEqual(row, { name: ANONYMIZED_NAME, name_key: `anon:${c}`, phone_e164: null, source: "qr", marketing_opt_in: false, phone_verification: "unverified" });
    });
  });

  describe("where personal data may remain", () => {
    it("the CRM and exports show an anonymised contact without its old name or phone", async () => {
      const phone = syntheticPhone();
      const c = await contactOf((await register("Видимость Проверка", phone)).registrationId);
      await revokeConsent(db.pool, owner, c);
      await anonymizeContact(db.pool, owner, c);
      const list = await listContacts(db.pool, owner, { q: "Видимость" });
      assert.equal(list.total, 0, "it can no longer be found by the old name");
      const card = await getContact(db.pool, owner, c);
      assert.equal(card!.contact.name, ANONYMIZED_NAME);
      assert.equal(card!.contact.phone, null);
      const csv = (await exportContacts(db.pool, owner, { format: "csv", columns: ["name", "phone"] })).body.toString("utf8");
      assert.ok(!csv.includes("Видимость") && !csv.includes(phone));
    });

    it("the export log keeps the fact that a search was used, not what was typed (it is append-only)", async () => {
      const searchPhone = syntheticPhone();
      await exportContacts(db.pool, owner, { format: "csv", columns: ["name"], filters: { q: searchPhone } });
      const row = (await q("SELECT filters FROM bb.export_log ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(row.filters.q, "[redacted]");
      assert.ok(!JSON.stringify((await q("SELECT filters, columns FROM bb.export_log")).rows).includes(searchPhone));
    });

    it("nothing in the audit log or the Telegram outbox names a visitor", async () => {
      // Opaque UUIDs may coincidentally contain a short phone fragment. Inspect content fields, not entity/ref IDs.
      const audit = JSON.stringify((await q("SELECT action, entity_type, before, after, ip, user_agent FROM bb.audit_log")).rows);
      const outbox = JSON.stringify((await q("SELECT to_jsonb(o) - 'id' - 'ref_id' AS content FROM bb.outbox o")).rows);
      for (const secret of visitorNames) {
        assert.ok(!audit.includes(secret), "audit content must not contain a visitor name");
        assert.ok(!outbox.includes(secret), "outbox content must not contain a visitor name");
      }
      for (const fragment of visitorPhoneFragments) {
        assert.ok(!audit.includes(fragment), "audit content must not contain a visitor phone or its 8-digit suffix");
        assert.ok(!outbox.includes(fragment), "outbox content must not contain a visitor phone or its 8-digit suffix");
      }
    });
  });
});
