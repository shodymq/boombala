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
        await assert.rejects(() => updateRetentionSettings(db.pool, who, { qrMonths: 6 }), ForbiddenError);
      }
      assert.equal((await events(c)).filter((e) => e.event === "revoked").length, 0);
      assert.equal(await scalar("SELECT anonymized_at IS NULL v FROM bb.contacts WHERE id = $1", [c]), true);
    });
  });

  describe("QR registration only", () => {
    it("name only: revoke, then anonymise; the consent history stays, indirect identifiers go, the audit holds no personal data", async () => {
      const r = await register("Айдана Безномера");
      const c = await contactOf(r.registrationId);
      const before = await assessContact(db.pool, owner, c);
      assert.deepEqual({ consent: before!.consentActive, blockers: before!.blockers, regs: before!.registrations }, { consent: true, blockers: [], regs: 1 });
      assert.ok((await events(c)).every((e) => e.ip_hash && e.user_agent), "the registration recorded the indirect identifiers");

      await assert.rejects(() => anonymizeContact(db.pool, owner, c), (e: unknown) => e instanceof ConflictError && e.message === "consent_not_revoked");

      const rev = await revokeConsent(db.pool, owner, c, meta);
      assert.equal(rev.revokedDocuments, 1);
      assert.equal(rev.assessment.consentActive, false);
      const ev = await events(c);
      assert.equal(ev.filter((e) => e.event === "given").length, 3, "the three 'given' rows are untouched");
      assert.deepEqual(ev.filter((e) => e.event === "revoked").map((e) => e.note), ["subject_request"]);

      const done = await anonymizeContact(db.pool, owner, c, meta);
      assert.deepEqual({ a: done.anonymized, already: done.already, erased: done.erasedEventIdentifiers }, { a: true, already: false, erased: 3 });
      const row = (await q("SELECT name, name_key, phone_e164, marketing_opt_in, anonymized_at FROM bb.contacts WHERE id = $1", [c])).rows[0];
      assert.equal(row.name, ANONYMIZED_NAME);
      assert.equal(row.phone_e164, null);
      assert.ok(row.name_key.startsWith("anon:") && row.anonymized_at);
      const after = await events(c);
      assert.equal(after.length, 4, "no consent row was deleted");
      assert.ok(after.every((e) => e.ip_hash === null && e.user_agent === null), "indirect identifiers are erased");
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.consent_registrations WHERE contact_id = $1", [c]), 1);

      const audit = await auditText();
      assert.ok(!audit.includes("Айдана") && !audit.includes("Безномера"), "the audit never carries the name");
      assert.ok(!audit.includes("203.0.113.5") && !audit.includes("Mozilla"), "nor the visitor's address or browser");
      assert.ok(audit.includes(c), "but it names the contact by id (needed to re-apply the erasure after a restore)");
    });

    it("with a phone: the number is removed too, and a later registration with the same number is a NEW contact", async () => {
      const phone = syntheticPhone();
      const formattedPhone = phone.replace(/(\+\d)(\d{3})(\d{3})(\d{4})/, "$1 $2 $3 $4");
      const digits = phone.replace(/\D/g, "");
      const r = await register("Серик Сномером", formattedPhone);
      const c = await contactOf(r.registrationId);
      await revokeConsent(db.pool, owner, c);
      await anonymizeContact(db.pool, owner, c);
      assert.equal(await scalar("SELECT phone_e164 IS NULL v FROM bb.contacts WHERE id = $1", [c]), true);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.contacts WHERE phone_e164 = $1", [phone]), 0);
      const again = await register("Серик Сномером", formattedPhone);
      const c2 = await contactOf(again.registrationId);
      assert.notEqual(c2, c, "the anonymised contact is not brought back to life");
      assert.equal(await scalar("SELECT phone_e164 v FROM bb.contacts WHERE id = $1", [c2]), phone);
      const audit = await auditText();
      assert.ok(!audit.includes(digits) && !audit.includes("Серик"));
    });

    it("a repeated withdrawal changes nothing; a repeated anonymisation is reported as already done; parallel calls make one change", async () => {
      const c = await contactOf((await register("Повторов Повтор")).registrationId);
      const results = await Promise.all(Array.from({ length: 5 }, () => revokeConsent(db.pool, owner, c)));
      assert.equal(results.filter((r) => r.revokedDocuments === 1).length, 1);
      assert.equal((await events(c)).filter((e) => e.event === "revoked").length, 1);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'consent.revoked' AND entity_id = $1", [c]), 1);
      const again = await revokeConsent(db.pool, owner, c);
      assert.equal(again.nothingToRevoke, true);

      const anon = await Promise.all(Array.from({ length: 4 }, () => anonymizeContact(db.pool, owner, c)));
      assert.equal(anon.filter((a) => a.anonymized).length, 1);
      assert.equal(anon.filter((a) => a.already).length, 3);
      assert.equal(await scalar("SELECT count(*)::int v FROM bb.audit_log WHERE action = 'contact.anonymized' AND entity_id = $1", [c]), 1);
      assert.equal((await revokeConsent(db.pool, owner, c)).nothingToRevoke, true, "an anonymised contact has nothing left to revoke");
    });

    it("errors: unknown and malformed ids", async () => {
      await assert.rejects(() => revokeConsent(db.pool, owner, randomUUID()), NotFoundError);
      await assert.rejects(() => anonymizeContact(db.pool, owner, randomUUID()), NotFoundError);
      await assert.rejects(() => revokeConsent(db.pool, owner, "not-an-id"), NotFoundError);
      assert.equal(await assessContact(db.pool, owner, "x'; DROP TABLE bb.contacts; --"), null);
    });
  });

  describe("QR + birthday enquiry on one contact", () => {
    it("the consent can be withdrawn, but the contact is kept while the enquiry exists (open, then closed)", async () => {
      const name = "Мадина Сзаявкой";
      const phone = syntheticPhone();
      const c = await contactOf((await register(name, phone)).registrationId);
      const l = await submitLead(db.pool, lead(name, phone));
      assert.equal(String(await scalar("SELECT contact_id v FROM bb.lead_requests WHERE id = $1", [l.leadId])), c, "same phone and name: one contact");

      let a = (await assessContact(db.pool, owner, c))!;
      assert.deepEqual(a.blockers, ["open_enquiry", "enquiry_record"]);
      const rev = await revokeConsent(db.pool, owner, c, meta);
      assert.equal(rev.revokedDocuments >= 1, true, "withdrawal is recorded even though the data must stay");
      await assert.rejects(() => anonymizeContact(db.pool, owner, c), (e: unknown) => e instanceof ConflictError && e.message === "blocked:open_enquiry,enquiry_record");

      await setLeadStatus(db.pool, owner, l.leadId, "cancelled");
      a = (await assessContact(db.pool, owner, c))!;
      assert.deepEqual(a.blockers, ["enquiry_record"], "a closed enquiry is still a record whose retention period is undecided");
      await assert.rejects(() => anonymizeContact(db.pool, owner, c), (e: unknown) => e instanceof ConflictError && e.message === "blocked:enquiry_record");
      const row = (await q("SELECT name, phone_e164, anonymized_at FROM bb.contacts WHERE id = $1", [c])).rows[0];
      assert.deepEqual({ name: row.name, phone: row.phone_e164, anon: row.anonymized_at }, { name, phone, anon: null });
      assert.ok((await events(c)).filter((e) => e.event === "given").every((e) => e.ip_hash || e.document_id), "nothing was erased");
    });
  });

  describe("bookings", () => {
    it("an active booking blocks anonymisation, also at the database level; after release the booking record still blocks; the double-booking guard is intact", async () => {
      const name = "Бахыт Сбронью";
      const phone = syntheticPhone();
      const c = await contactOf((await register(name, phone)).registrationId);
      const l = await submitLead(db.pool, lead(name, phone));
      const { reservationId } = await confirmLead(db.pool, owner, { leadId: l.leadId, date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "happy-party" });
      await revokeConsent(db.pool, owner, c);

      assert.deepEqual((await assessContact(db.pool, owner, c))!.blockers, ["active_booking", "open_enquiry", "booking_record", "enquiry_record"], "a confirmed enquiry is still open");
      await assert.rejects(() => anonymizeContact(db.pool, owner, c), (e: unknown) => e instanceof ConflictError && String(e.message).startsWith("blocked:active_booking"));
      // The database refuses it even if the application is bypassed.
      await assert.rejects(
        () => q("UPDATE bb.contacts SET name = 'x', name_key = 'x', phone_e164 = NULL, marketing_opt_in = false, anonymized_at = now() WHERE id = $1", [c]),
        /active booking or an open enquiry/,
      );
      assert.equal(await scalar("SELECT anonymized_at IS NULL v FROM bb.contacts WHERE id = $1", [c]), true);

      // the cell stays protected against a second active reservation
      await assert.rejects(
        () => manualBooking({ date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "happy-party", name: "Другой Гость", phone: syntheticPhone() }),
        (e: unknown) => e instanceof ConflictError,
      );

      await releaseReservation(db.pool, owner, reservationId, "ТЕСТ");
      assert.deepEqual((await assessContact(db.pool, owner, c))!.blockers, ["booking_record", "enquiry_record"], "a released booking is still a record");
      await assert.rejects(() => anonymizeContact(db.pool, owner, c), ConflictError);
      const r = (await q("SELECT price_kzt, contact_id, released_at FROM bb.slot_reservations WHERE id = $1", [reservationId])).rows[0];
      assert.ok(r.price_kzt > 0 && String(r.contact_id) === c && r.released_at, "the booking row and its price snapshot are untouched");
      // the freed cell can be booked again (protection intact in both directions)
      await manualBooking({ date: FUTURE, slotId: 1, roomId: "roblox-room", packageId: "happy-party", name: "Следующий Гость", phone: syntheticPhone() });
    });

    it("a contact created from a manual booking (not QR) is never anonymised by this mechanism while the booking exists", async () => {
      const phone = syntheticPhone();
      await manualBooking({ date: FUTURE, slotId: 2, roomId: "ice-room", packageId: "happy-party", name: "Ручной Клиент", phone });
      const c = String(await scalar("SELECT id v FROM bb.contacts WHERE phone_e164 = $1", [phone]));
      await revokeConsent(db.pool, owner, c);
      await assert.rejects(() => anonymizeContact(db.pool, owner, c), ConflictError);
    });
  });

  describe("the database itself", () => {
    it("consent history cannot be deleted or rewritten; only erasing indirect identifiers of an anonymised contact is allowed", async () => {
      const live = await contactOf((await register("Живой Контакт")).registrationId);
      await assert.rejects(() => q("DELETE FROM bb.consent_events WHERE contact_id = $1", [live]), /append-only/);
      await assert.rejects(() => q("UPDATE bb.consent_events SET event = 'revoked' WHERE contact_id = $1", [live]), /append-only/);
      await assert.rejects(() => q("UPDATE bb.consent_events SET ip_hash = NULL, user_agent = NULL WHERE contact_id = $1", [live]), /only for an anonymised contact/);
      await assert.rejects(() => q("UPDATE bb.consent_events SET ip_hash = 'abc' WHERE contact_id = $1", [live]), /append-only|erased, never rewritten|anonymised/);
      await assert.rejects(() => q("INSERT INTO bb.consent_events (contact_id, document_id, event, method, note) SELECT $1, document_id, 'revoked', 'staff', 'free text with a name' FROM bb.consent_events WHERE contact_id = $1 LIMIT 1", [live]), /consent_events_note_code/);

      await revokeConsent(db.pool, owner, live);
      await anonymizeContact(db.pool, owner, live);
      await assert.rejects(() => q("UPDATE bb.consent_events SET occurred_at = now() WHERE contact_id = $1", [live]), /append-only/);
      await assert.rejects(() => q("DELETE FROM bb.consent_events WHERE contact_id = $1", [live]), /append-only/);
      await assert.rejects(() => q("UPDATE bb.contacts SET name = 'Вернули' WHERE id = $1", [live]), /cannot be changed or restored/);
      await assert.rejects(() => q("UPDATE bb.contacts SET anonymized_at = NULL WHERE id = $1", [live]), /cannot be changed or restored/);
      await assert.rejects(() => q("UPDATE bb.contacts SET phone_e164 = $1 WHERE id = $2", [syntheticPhone(), live]), /cannot be changed or restored/);
    });

    it("anonymisation cannot leave a phone or a marketing consent behind; other sources still need a phone", async () => {
      const c = await contactOf((await register("Хвост Номера", syntheticPhone())).registrationId);
      await assert.rejects(() => q("UPDATE bb.contacts SET anonymized_at = now() WHERE id = $1", [c]), /keeps no phone/);
      await assert.rejects(() => q("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('x', 'x', NULL, 'birthday_form')"), /contacts_phone_required_unless_qr/);
    });
  });

  describe("retention report and run", () => {
    const plusMonths = (d: Date, months: number, extraMs = 0) => {
      const x = new Date(d);
      x.setUTCMonth(x.getUTCMonth() + months);
      return new Date(x.getTime() + extraMs);
    };

    it("defaults: 12 months, automatic processing OFF, no legal confirmation", async () => {
      assert.deepEqual(await getRetentionSettings(db.pool, owner), { qrMonths: 12, autoEnabled: false, legalConfirmedAt: null });
    });

    it("dry run reports who would be processed and who must be left alone, changes nothing and shows no names or phones", async () => {
      const qrOnlyPhone = syntheticPhone();
      const withLeadPhone = syntheticPhone();
      const qrOnly = await contactOf((await register("Срок Одиночный", qrOnlyPhone)).registrationId);
      const qrNoPhone = await contactOf((await register("Срок Безномера")).registrationId);
      const withLead = await contactOf((await register("Срок Сзаявкой", withLeadPhone)).registrationId);
      await submitLead(db.pool, lead("Срок Сзаявкой", withLeadPhone));
      const reg = (await q("SELECT max(created_at) v FROM bb.consent_registrations WHERE contact_id = $1", [qrOnly])).rows[0].v as Date;
      const anonymisedBefore = Number(await scalar("SELECT count(*) v FROM bb.contacts WHERE anonymized_at IS NOT NULL"));

      // today: nothing has expired
      const today = await retentionReport(db.pool, owner);
      assert.equal(today.totals.eligible, 0);
      assert.equal(today.totals.blocked, 0);
      assert.ok(today.totals.notExpired >= 3);

      // exactly at the boundary (+ a second): expired; a second before: not yet
      const late = await retentionReport(db.pool, owner, plusMonths(reg, 12, 1000));
      const early = await retentionReport(db.pool, owner, plusMonths(reg, 12, -1000));
      assert.ok(late.eligible.some((i) => i.contactId === qrOnly), "QR with a phone, 12 months passed: eligible");
      assert.ok(late.eligible.some((i) => i.contactId === qrNoPhone), "QR without a phone: eligible");
      assert.ok(!early.eligible.some((i) => i.contactId === qrOnly), "one second before the boundary: not eligible");
      const blocked = late.blocked.find((i) => i.contactId === withLead);
      assert.deepEqual(blocked?.blockers, ["open_enquiry", "enquiry_record"], "QR + enquiry: reported as untouchable");
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
