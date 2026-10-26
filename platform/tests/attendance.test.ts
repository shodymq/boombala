import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { API_GRANTS, applyRoles } from "../scripts/db-roles.ts";
import { addManualEntry, attendanceSeries, confirmRegistrationEntry, correctEntry, dayFigures, listEntries, listRegistrations } from "../src/core/attendance.ts";
import { almatyToday } from "../src/core/dates.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { ConflictError, DocumentsChangedError, ForbiddenError, NotFoundError, ValidationError } from "../src/core/errors.ts";
import { submitConsent } from "../src/core/intake.ts";
import { approveDocument, createDraft, publishDocument } from "../src/core/legal.ts";
import { attendanceSchemaReady, preflight } from "../src/core/preflight.ts";
import { can } from "../src/core/rbac.ts";
import { migrate } from "../src/core/migrate.ts";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUser, MIGRATIONS_DIR, publishedVersions, startTestDb, submitConsentV, type TestDb } from "./helpers/db.ts";

const API_PW = "api-role-password-0123456789abc";
const ADMIN_PW = "admin-role-password-0123456789";

describe("Attendance: children count in the QR registration and the record of who actually came in", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let manager2: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  const A = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });
  const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
  const scalar = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rows[0].v;
  const TODAY = almatyToday();

  /** A QR registration through the real intake (what the site sends). */
  const register = (name: string, childrenCount: unknown = 1, phone: string | null = null) =>
    submitConsentV(db.pool, { idempotencyKey: randomUUID(), name, phone, childrenCount: childrenCount as number, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.5", ipPepper: "pepper", userAgent: "Test" });
  /** A registration written directly with a chosen creation moment (day-boundary tests). */
  const registrationAt = async (name: string, children: number, at: string) => {
    const c = await q("INSERT INTO bb.contacts (name, name_key, source) VALUES ($1, $2, 'qr') RETURNING id", [name, name.toLowerCase()]);
    const r = await q("INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count, created_at) VALUES ($1, $2, $3, $4) RETURNING id", [randomUUID(), c.rows[0].id, children, at]);
    return String(r.rows[0].id);
  };
  const entered = async (date: string) => (await dayFigures(db.pool, A(owner), date)).childrenEntered;
  const consentFingerprint = async () => createHash("sha256").update(JSON.stringify((await q("SELECT * FROM bb.consent_events ORDER BY id")).rows)).digest("hex");

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    manager = await makeUser(db.pool, "manager");
    manager2 = await makeUser(db.pool, "manager", "manager2@example.test");
    editor = await makeUser(db.pool, "editor");
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
  });
  after(async () => db.stop());

  describe("the number of children in the QR registration", () => {
    it("is stored for 1, 3 and 10 children", async () => {
      for (const n of [1, 3, 10]) {
        const r = await register(`Взрослый ${n}`, n);
        assert.equal(Number(await scalar("SELECT children_count v FROM bb.consent_registrations WHERE id = $1", [r.registrationId])), n);
      }
    });

    it("is required and must be a whole number from 1 to 50 (also as the digits a form sends)", async () => {
      await assert.rejects(async () => submitConsent(db.pool, { idempotencyKey: randomUUID(), name: "Без числа", documentVersions: await publishedVersions(db.pool), acceptRules: true, acceptPersonalData: true } as never), ValidationError, "the number is missing");
      for (const bad of [null, 0, 51, -1, 2.5, "abc", "", "0", "51", "1e1", NaN, [], {}, true]) {
        await assert.rejects(() => register("Плохое число", bad), ValidationError, `rejected: ${JSON.stringify(bad)}`);
      }
      assert.equal((await register("Строка цифр", "7")).duplicate, false);
      assert.equal(Number(await scalar("SELECT children_count v FROM bb.consent_registrations ORDER BY seq DESC LIMIT 1")), 7);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.contacts WHERE name = 'Плохое число'")), 0, "a refused registration leaves no contact behind");
    });

    it("the database refuses what the application would have refused (the bound is not only in the code)", async () => {
      await assert.rejects(() => q("INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count) SELECT $1, id, 51 FROM bb.contacts LIMIT 1", [randomUUID()]), /check/i);
      await assert.rejects(() => q("INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count) SELECT $1, id, 0 FROM bb.contacts LIMIT 1", [randomUUID()]), /check/i);
      await assert.rejects(() => q("INSERT INTO bb.consent_registrations (idempotency_key, contact_id) SELECT $1, id FROM bb.contacts LIMIT 1", [randomUUID()]), /children_required|check/i, "a new registration without the number");
    });

    it("a repeated key keeps the first registration (idempotency), the number of the first request stays", async () => {
      const key = randomUUID();
      const base = { idempotencyKey: key, name: "Повтор", childrenCount: 4, acceptRules: true as const, acceptPersonalData: true as const };
      const results = await Promise.all(Array.from({ length: 6 }, () => submitConsentV(db.pool, base)));
      assert.equal(new Set(results.map((r) => r.registrationId)).size, 1);
      assert.equal(results.filter((r) => !r.duplicate).length, 1);
      const again = await submitConsentV(db.pool, { ...base, childrenCount: 9 });
      assert.equal(again.duplicate, true);
      assert.equal(Number(await scalar("SELECT children_count v FROM bb.consent_registrations WHERE idempotency_key = $1", [key])), 4);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.consent_registrations WHERE idempotency_key = $1", [key])), 1);
    });

    it("no personal data of children can be stored: the schema has no place for it and extra fields are ignored", async () => {
      const cols = async (t: string) => (await q("SELECT column_name c FROM information_schema.columns WHERE table_schema = 'bb' AND table_name = $1 ORDER BY ordinal_position", [t])).rows.map((r) => r.c);
      assert.deepEqual(await cols("consent_registrations"), ["id", "seq", "idempotency_key", "contact_id", "source", "created_at", "children_count"]);
      assert.deepEqual(await cols("attendance_entries"), ["id", "seq", "registration_id", "method", "children_count", "entered_at", "entry_date", "confirmed_by", "idempotency_key", "created_at"]);
      assert.deepEqual(await cols("attendance_corrections"), ["id", "entry_id", "old_count", "new_count", "reason", "corrected_by", "corrected_at"]);
      const input = { idempotencyKey: randomUUID(), name: "Родитель", childrenCount: 2, childrenNames: ["Вася Секретов", "Петя Секретов"], birthDates: ["2019-01-01"], iin: "190101500123", acceptRules: true as const, acceptPersonalData: true as const };
      await submitConsentV(db.pool, input as never);
      const dump = JSON.stringify([(await q("SELECT * FROM bb.consent_registrations")).rows, (await q("SELECT * FROM bb.contacts")).rows, (await q("SELECT * FROM bb.consent_events")).rows, (await q("SELECT * FROM bb.audit_log")).rows]);
      assert.ok(!/Секретов|190101500123|2019-01-01/.test(dump), "nothing about the children's names, IIN or birth dates was kept");
    });
  });

  describe("a registration is not a visit", () => {
    it("an unconfirmed registration adds no actual entry; it is only expected", async () => {
      const before0 = await dayFigures(db.pool, A(owner), TODAY);
      const r = await register("Ожидающий", 3);
      const after = await dayFigures(db.pool, A(owner), TODAY);
      assert.equal(after.childrenEntered, before0.childrenEntered, "entered children did not change");
      assert.equal(after.entries, before0.entries);
      assert.equal(after.adultsRegistered, before0.adultsRegistered + 1);
      assert.equal(after.childrenExpected, before0.childrenExpected + 3);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id = $1", [r.registrationId])), 0, "0 actual entries");
      const row = (await listRegistrations(db.pool, A(manager), TODAY)).find((x) => x.id === r.registrationId)!;
      assert.equal(row.status, "waiting");
      assert.equal(row.declaredChildren, 3);
    });

    it("an old registration without a declared number is listed as such, with nothing invented", async () => {
      // a row as it existed before migration 013 (NULL), created by the owner of the database bypassing the constraint
      await q("ALTER TABLE bb.consent_registrations DISABLE TRIGGER USER");
      const c = await q("INSERT INTO bb.contacts (name, name_key, source) VALUES ('Старая', 'старая', 'qr') RETURNING id");
      await q("ALTER TABLE bb.consent_registrations DROP CONSTRAINT consent_registrations_children_required");
      const id = String((await q("INSERT INTO bb.consent_registrations (idempotency_key, contact_id) VALUES ($1, $2) RETURNING id", [randomUUID(), c.rows[0].id])).rows[0].id);
      await q("ALTER TABLE bb.consent_registrations ADD CONSTRAINT consent_registrations_children_required CHECK (children_count IS NOT NULL) NOT VALID");
      await q("ALTER TABLE bb.consent_registrations ENABLE TRIGGER USER");
      const row = (await listRegistrations(db.pool, A(owner), TODAY)).find((x) => x.id === id)!;
      assert.equal(row.declaredChildren, null);
      const f1 = await dayFigures(db.pool, A(owner), TODAY);
      assert.ok(f1.registrationsWaiting >= 1);
      const r = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: id, childrenCount: 2 });
      assert.equal(r.childrenCount, 2, "staff states the real number");
    });
  });

  describe("confirming an entry", () => {
    it("adds exactly the number staff entered (it may differ from the declared one) and nothing else", async () => {
      const r = await register("Подтверждаемый", 3);
      const before0 = await dayFigures(db.pool, A(manager), TODAY);
      const consentBefore = await consentFingerprint();
      const e = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2 }, { ip: "10.0.0.1", userAgent: "T" });
      assert.equal(e.duplicate, false);
      const after = await dayFigures(db.pool, A(manager), TODAY);
      assert.equal(after.childrenEntered, before0.childrenEntered + 2);
      assert.equal(after.entries, before0.entries + 1);
      assert.equal(after.childrenExpected, before0.childrenExpected - 3, "the registration is no longer expected");
      assert.equal(after.adultsRegistered, before0.adultsRegistered, "registered adults do not change");
      const row = (await listRegistrations(db.pool, A(manager), TODAY)).find((x) => x.id === r.registrationId)!;
      assert.equal(row.status, "confirmed");
      assert.equal(row.enteredChildren, 2);
      const entry = (await q("SELECT method, confirmed_by, children_count, registration_id FROM bb.attendance_entries WHERE id = $1", [e.entryId])).rows[0];
      assert.deepEqual([entry.method, entry.confirmed_by, entry.children_count, entry.registration_id], ["qr", manager.id, 2, r.registrationId]);
      const audit = (await q("SELECT actor_user_id, action, ip FROM bb.audit_log WHERE entity_id = $1", [e.entryId])).rows;
      assert.deepEqual(audit.map((a) => [a.actor_user_id, a.action, a.ip]), [[manager.id, "attendance.confirmed", "10.0.0.1"]]);
      assert.equal(await consentFingerprint(), consentBefore, "the consent history is untouched");
    });

    it("a repeat adds nothing: double tap, network retry, and different staff at the same moment", async () => {
      const r = await register("Повторное нажатие", 4);
      const f0 = await entered(TODAY);
      const first = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 4 });
      const repeat = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 4 });
      const other = await confirmRegistrationEntry(db.pool, A(owner), { registrationId: r.registrationId, childrenCount: 9 });
      assert.equal(first.duplicate, false);
      assert.deepEqual([repeat.duplicate, other.duplicate, repeat.entryId, other.entryId], [true, true, first.entryId, first.entryId]);
      assert.equal(await entered(TODAY), f0 + 4);

      // eight requests at once from separate connections and two different people
      const r2 = await register("Гонка подтверждений", 5);
      const pools = [db.newPool(4), db.newPool(4)];
      const f1 = await entered(TODAY);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => confirmRegistrationEntry(pools[i % 2], A(i % 2 ? manager : manager2), { registrationId: r2.registrationId, childrenCount: 5 })),
      );
      assert.equal(results.filter((x) => !x.duplicate).length, 1, "exactly one of the requests created the entry");
      assert.equal(await entered(TODAY), f1 + 5, "the figure grew once");
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id = $1", [r2.registrationId])), 1);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.audit_log WHERE action = 'attendance.confirmed' AND after->>'registrationId' = $1", [r2.registrationId])), 1, "one audit entry");
    });

    it("refuses a bad number, an unknown registration, and a request without the right", async () => {
      const r = await register("Проверки", 2);
      for (const bad of [0, 51, -1, 2.5, "3", NaN, null, undefined]) {
        await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: bad }), ValidationError, `refused: ${String(bad)}`);
      }
      await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: "not-a-uuid", childrenCount: 1 }), ValidationError);
      await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: randomUUID(), childrenCount: 1 }), NotFoundError);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id = $1", [r.registrationId])), 0);
    });
  });

  describe("manual entry of a visitor without QR", () => {
    it("adds the number to the day, is attributed to the person, and is idempotent", async () => {
      const f0 = await dayFigures(db.pool, A(manager), TODAY);
      const key = randomUUID();
      const a = await addManualEntry(db.pool, A(manager), { childrenCount: 3, idempotencyKey: key }, { ip: "10.0.0.2" });
      const pool2 = db.newPool(4);
      const rest = await Promise.all([addManualEntry(db.pool, A(manager), { childrenCount: 3, idempotencyKey: key }), addManualEntry(pool2, A(manager2), { childrenCount: 3, idempotencyKey: key }), addManualEntry(pool2, A(manager), { childrenCount: 3, idempotencyKey: key })]);
      assert.equal(a.duplicate, false);
      assert.ok(rest.every((x) => x.duplicate && x.entryId === a.entryId));
      const f1 = await dayFigures(db.pool, A(manager), TODAY);
      assert.equal(f1.childrenEntered, f0.childrenEntered + 3);
      assert.equal(f1.entries, f0.entries + 1);
      assert.equal(f1.adultsRegistered, f0.adultsRegistered, "a manual entry is not a registration");
      const e = (await q("SELECT method, registration_id, confirmed_by FROM bb.attendance_entries WHERE id = $1", [a.entryId])).rows[0];
      assert.deepEqual([e.method, e.registration_id, e.confirmed_by], ["manual", null, manager.id]);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.audit_log WHERE entity_id = $1", [a.entryId])), 1);
    });

    it("refuses a bad number or key; the database ties the method to the registration", async () => {
      for (const bad of [0, 51, 1.5, "2", null]) await assert.rejects(() => addManualEntry(db.pool, A(manager), { childrenCount: bad, idempotencyKey: randomUUID() }), ValidationError);
      await assert.rejects(() => addManualEntry(db.pool, A(manager), { childrenCount: 1, idempotencyKey: "x" }), ValidationError);
      await assert.rejects(() => q("INSERT INTO bb.attendance_entries (method, children_count, confirmed_by) VALUES ('qr', 1, $1)", [owner.id]), /attendance_method_matches_registration/);
      const reg = await register("Метод", 1);
      await assert.rejects(() => q("INSERT INTO bb.attendance_entries (registration_id, method, children_count, confirmed_by) VALUES ($1, 'manual', 1, $2)", [reg.registrationId, owner.id]), /attendance_method_matches_registration/);
      await assert.rejects(() => q("INSERT INTO bb.attendance_entries (method, children_count, confirmed_by) VALUES ('manual', 0, $1)", [owner.id]), /at least one child/);
    });
  });

  describe("corrections", () => {
    it("change the number, keep the history, and the database writes the log itself", async () => {
      const r = await register("Исправляемый", 3);
      const e = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 3 });
      const f0 = await entered(TODAY);
      const res = await correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 2, expectedCount: 3, reason: "miscount" }, { ip: "10.0.0.3" });
      assert.deepEqual(res, { changed: true, childrenCount: 2 });
      assert.equal(await entered(TODAY), f0 - 1);
      const log = (await q("SELECT old_count, new_count, reason, corrected_by FROM bb.attendance_corrections WHERE entry_id = $1", [e.entryId])).rows;
      assert.deepEqual(log.map((x) => [x.old_count, x.new_count, x.reason, x.corrected_by]), [[3, 2, "miscount", owner.id]]);
      const audit = (await q("SELECT action, before, after FROM bb.audit_log WHERE entity_id = $1 ORDER BY id", [e.entryId])).rows;
      assert.deepEqual(audit.map((a) => a.action), ["attendance.confirmed", "attendance.corrected"]);
      assert.deepEqual([audit[1].before, audit[1].after], [{ children: 3 }, { children: 2, reason: "miscount" }]);
      const listed = (await listEntries(db.pool, A(manager), TODAY)).find((x) => x.id === e.entryId)!;
      assert.equal(listed.childrenCount, 2);
      assert.deepEqual(listed.corrections.map((k) => [k.oldCount, k.newCount, k.reason]), [[3, 2, "miscount"]]);
      // the same number again changes nothing and writes nothing
      assert.deepEqual(await correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 2, expectedCount: 2, reason: "other" }), { changed: false, childrenCount: 2 });
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_corrections WHERE entry_id = $1", [e.entryId])), 1);
    });

    it("0 cancels an entry: the registration is CANCELLED, not waiting, and its children are not expected any more", async () => {
      const r = await register("Отмена входа", 2);
      const e = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2 });
      const f0 = await dayFigures(db.pool, A(owner), TODAY);
      await correctEntry(db.pool, A(manager), { entryId: e.entryId, newCount: 0, expectedCount: 2, reason: "wrong_registration" });
      const f1 = await dayFigures(db.pool, A(owner), TODAY);
      assert.equal(f1.childrenEntered, f0.childrenEntered - 2);
      assert.equal(f1.entries, f0.entries - 1);
      assert.equal(f1.childrenExpected, f0.childrenExpected, "NOT expected again: a cancelled entry is a decision, not a missing one");
      assert.equal(f1.registrationsWaiting, f0.registrationsWaiting, "waiting is unchanged");
      assert.equal(f1.registrationsCancelled, f0.registrationsCancelled + 1, "cancelled is counted on its own");
      assert.equal(f1.adultsRegistered, f0.adultsRegistered, "registered adults are unchanged");
      assert.equal((await listRegistrations(db.pool, A(owner), TODAY)).find((x) => x.id === r.registrationId)!.status, "cancelled");
      const again = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2 });
      assert.equal(again.duplicate, true, "a cancelled entry is not silently re-created by a button press");
      await correctEntry(db.pool, A(manager), { entryId: e.entryId, newCount: 2, expectedCount: 0, reason: "other" });
      const f2 = await dayFigures(db.pool, A(owner), TODAY);
      assert.equal(f2.childrenEntered, f0.childrenEntered);
      assert.equal(f2.registrationsCancelled, f0.registrationsCancelled, "restored: no longer cancelled");
    });

    it("confirm 3, correct to 0: the figures show those 3 children neither as entered nor as expected", async () => {
      const r = await register("Три и ноль", 3);
      const f0 = await dayFigures(db.pool, A(owner), TODAY);
      assert.equal(f0.childrenExpected >= 3, true);
      const e = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 3 });
      const f1 = await dayFigures(db.pool, A(owner), TODAY);
      assert.deepEqual([f1.childrenEntered - f0.childrenEntered, f1.childrenExpected - f0.childrenExpected], [3, -3], "confirmed: +3 entered, -3 expected");
      await correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 0, expectedCount: 3, reason: "wrong_registration" });
      const f2 = await dayFigures(db.pool, A(owner), TODAY);
      assert.deepEqual([f2.childrenEntered - f0.childrenEntered, f2.childrenExpected - f0.childrenExpected], [0, -3], "cancelled: nothing entered and the 3 are NOT expected");
      assert.deepEqual([f2.registrationsWaiting - f0.registrationsWaiting, f2.registrationsCancelled - f0.registrationsCancelled, f2.adultsRegistered - f0.adultsRegistered], [-1, 1, 0], "registered / waiting / entered / cancelled stay separate");
      const status = (await listRegistrations(db.pool, A(owner), TODAY)).find((x) => x.id === r.registrationId)!.status;
      assert.equal(status, "cancelled");
    });

    it("refuse a stale screen: two people correcting the same number cannot both win blindly", async () => {
      const e = await addManualEntry(db.pool, A(manager), { childrenCount: 6, idempotencyKey: randomUUID() });
      const pools = [db.newPool(3), db.newPool(3)];
      const results = await Promise.allSettled([
        correctEntry(pools[0], A(manager), { entryId: e.entryId, newCount: 5, expectedCount: 6, reason: "miscount" }),
        correctEntry(pools[1], A(manager2), { entryId: e.entryId, newCount: 4, expectedCount: 6, reason: "miscount" }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(loser.reason instanceof ConflictError);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_corrections WHERE entry_id = $1", [e.entryId])), 1);
      await assert.rejects(() => correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 3, expectedCount: 6, reason: "other" }), ConflictError);
    });

    it("refuse a bad number, a missing reason and an unknown entry", async () => {
      const e = await addManualEntry(db.pool, A(manager), { childrenCount: 2, idempotencyKey: randomUUID() });
      for (const bad of [51, -1, 1.5, "3", null]) await assert.rejects(() => correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: bad, expectedCount: 2, reason: "other" }), ValidationError);
      for (const reason of ["", "free text", undefined]) await assert.rejects(() => correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 3, expectedCount: 2, reason }), ValidationError);
      await assert.rejects(() => correctEntry(db.pool, A(owner), { entryId: randomUUID(), newCount: 3, expectedCount: 2, reason: "other" }), NotFoundError);
    });

    it("cannot be bypassed in the database: no silent change, no other column, no delete, no truncate", async () => {
      const e = await addManualEntry(db.pool, A(manager), { childrenCount: 2, idempotencyKey: randomUUID() });
      await assert.rejects(() => q("UPDATE bb.attendance_entries SET children_count = 9 WHERE id = $1", [e.entryId]), /needs the person and the reason/);
      await assert.rejects(() => q("SELECT set_config('bb.actor', 'not-a-uuid', true)").then(() => q("UPDATE bb.attendance_entries SET children_count = 9 WHERE id = $1", [e.entryId])), /needs the person and the reason/);
      for (const sql of ["UPDATE bb.attendance_entries SET method = CASE WHEN method = 'manual' THEN 'qr' ELSE 'manual' END", "UPDATE bb.attendance_entries SET entered_at = now() - interval '3 days'", "UPDATE bb.attendance_entries SET confirmed_by = (SELECT id FROM bb.users WHERE id <> confirmed_by LIMIT 1)", "UPDATE bb.attendance_entries SET idempotency_key = gen_random_uuid()"]) {
        await assert.rejects(() => q(`${sql} WHERE id = $1`, [e.entryId]), /only the number of children/);
      }
      await assert.rejects(() => q("DELETE FROM bb.attendance_entries WHERE id = $1", [e.entryId]), /append-only/);
      await assert.rejects(() => q("TRUNCATE bb.attendance_entries CASCADE"), /append-only/);
      await assert.rejects(() => q("UPDATE bb.attendance_corrections SET reason = 'other'"), /append-only/);
      await assert.rejects(() => q("DELETE FROM bb.attendance_corrections"), /append-only/);
      await assert.rejects(() => q("TRUNCATE bb.attendance_corrections"), /append-only/);
      assert.equal(Number(await scalar("SELECT children_count v FROM bb.attendance_entries WHERE id = $1", [e.entryId])), 2);
    });
  });

  describe("new entries only for today (Asia/Almaty); the past is read-only except audited corrections", () => {
    it("refuses a date other than today, a supplied moment, and a registration of an earlier day, on the server", async () => {
      const r = await register("Только сегодня", 2);
      const yesterday = new Date(`${TODAY}T00:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const Y = yesterday.toISOString().slice(0, 10);
      const tomorrow = new Date(`${TODAY}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const T = tomorrow.toISOString().slice(0, 10);
      const f0 = await dayFigures(db.pool, A(owner), TODAY);
      // a forged "date" of the screen (the admin passes the day its form showed)
      for (const d of [Y, T, "2030-01-01", "not a date", ""]) {
        await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2, onDate: d }), ValidationError, `confirm refused for ${d}`);
        await assert.rejects(() => addManualEntry(db.pool, A(manager), { childrenCount: 2, idempotencyKey: randomUUID(), onDate: d }), ValidationError, `manual refused for ${d}`);
      }
      // a supplied moment is not honoured without the explicit back-fill switch
      await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2, at: new Date(`${Y}T10:00:00Z`) }), ValidationError);
      await assert.rejects(() => addManualEntry(db.pool, A(manager), { childrenCount: 2, idempotencyKey: randomUUID(), at: new Date(`${Y}T10:00:00Z`) }), ValidationError);
      // a registration made on an earlier day is not confirmed now
      const old = await registrationAt("Вчерашняя", 2, `${Y}T08:00:00Z`);
      await assert.rejects(() => confirmRegistrationEntry(db.pool, A(manager), { registrationId: old, childrenCount: 2 }), ValidationError);
      assert.deepEqual(await dayFigures(db.pool, A(owner), TODAY), f0, "nothing changed");
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id IN ($1, $2)", [r.registrationId, old])), 0);
      // today with the matching screen date works
      const ok = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2, onDate: TODAY });
      assert.equal(ok.duplicate, false);
      const man = await addManualEntry(db.pool, A(manager), { childrenCount: 1, idempotencyKey: randomUUID(), onDate: TODAY });
      assert.equal(man.duplicate, false);
    });

    it("past days stay readable and an existing past entry can still be corrected, with the audit trail", async () => {
      const reg = await registrationAt("Прошлый день", 4, "2031-02-03T05:00:00Z");
      const e = await confirmRegistrationEntry(db.pool, A(manager), { registrationId: reg, childrenCount: 4, allowBackfill: true, at: new Date("2031-02-03T06:00:00Z") });
      assert.equal(await entered("2031-02-03"), 4);
      assert.equal((await listEntries(db.pool, A(manager), "2031-02-03")).length, 1, "the historical day can be viewed");
      assert.equal((await listRegistrations(db.pool, A(manager), "2031-02-03")).length, 1);
      await correctEntry(db.pool, A(owner), { entryId: e.entryId, newCount: 3, expectedCount: 4, reason: "miscount" });
      assert.equal(await entered("2031-02-03"), 3);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.audit_log WHERE entity_id = $1 AND action = 'attendance.corrected'", [e.entryId])), 1);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_corrections WHERE entry_id = $1", [e.entryId])), 1);
    });
  });

  describe("the calendar day is the day in Almaty", () => {
    it("an entry at 23:59:59 and one at 00:00:00 Almaty fall on different days", async () => {
      const r1 = await registrationAt("Полночь 1", 2, "2031-03-10T18:59:00Z");
      const r2 = await registrationAt("Полночь 2", 3, "2031-03-10T19:00:00Z");
      // 23:59:59 Almaty (UTC+5) = 18:59:59Z; 00:00:00 Almaty = 19:00:00Z
      await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r1, childrenCount: 2, allowBackfill: true, at: new Date("2031-03-10T18:59:59Z") });
      await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r2, childrenCount: 3, allowBackfill: true, at: new Date("2031-03-10T19:00:00Z") });
      assert.equal(await entered("2031-03-10"), 2);
      assert.equal(await entered("2031-03-11"), 3);
      assert.equal((await dayFigures(db.pool, A(owner), "2031-03-10")).adultsRegistered, 1, "the registration made at 23:59 Almaty belongs to the 10th");
      assert.equal((await dayFigures(db.pool, A(owner), "2031-03-11")).adultsRegistered, 1, "the registration made at 00:00 Almaty belongs to the 11th");
      assert.equal(await scalar("SELECT to_char(entry_date, 'YYYY-MM-DD') v FROM bb.attendance_entries WHERE entered_at = '2031-03-10T19:00:00Z'"), "2031-03-11");
      const series = await attendanceSeries(db.pool, A(owner), "2031-03-09", "2031-03-12");
      assert.deepEqual(series.map((d) => [d.date, d.childrenEntered]), [["2031-03-09", 0], ["2031-03-10", 2], ["2031-03-11", 3], ["2031-03-12", 0]], "days without visits are present with zeros");
    });

    it("a time in the UTC evening of the previous day is already 'tomorrow' in Almaty, and the server's own time zone does not matter", async () => {
      await q("SET TIME ZONE 'America/Los_Angeles'");
      const r = await registrationAt("Часовой пояс", 1, "2031-06-01T20:00:00Z");
      await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r, childrenCount: 1, allowBackfill: true, at: new Date("2031-06-01T20:00:00Z") });
      await q("RESET TIME ZONE");
      assert.equal(await entered("2031-06-02"), 1);
      assert.equal(await entered("2031-06-01"), 0);
    });
  });

  describe("a figure is shown only when it is true: 500 children on a day", () => {
    it("registrations alone never make 500; 500 appears only when the confirmed entries add up to exactly 500", async () => {
      const DAY = "2031-10-24";
      const regs: string[] = [];
      for (let i = 0; i < 10; i++) regs.push(await registrationAt(`Пятьсот ${i}`, 50, `2031-10-24T05:${String(10 + i)}:00Z`));
      const f0 = await dayFigures(db.pool, A(owner), DAY);
      assert.deepEqual([f0.adultsRegistered, f0.childrenExpected, f0.childrenEntered], [10, 500, 0], "500 are EXPECTED, 0 have entered");
      for (let i = 0; i < 9; i++) await confirmRegistrationEntry(db.pool, A(manager), { registrationId: regs[i], childrenCount: 50, allowBackfill: true, at: new Date(`2031-10-24T06:${String(10 + i)}:00Z`) });
      assert.equal(await entered(DAY), 450);
      await confirmRegistrationEntry(db.pool, A(manager), { registrationId: regs[9], childrenCount: 49, allowBackfill: true, at: new Date("2031-10-24T07:00:00Z") });
      assert.equal(await entered(DAY), 499, "49 at the last entry: 499, not 500");
      // pressing buttons again does not move the number
      for (const id of regs) await confirmRegistrationEntry(db.pool, A(manager2), { registrationId: id, childrenCount: 50, allowBackfill: true });
      assert.equal(await entered(DAY), 499);
      const last = (await q("SELECT id FROM bb.attendance_entries WHERE registration_id = $1", [regs[9]])).rows[0].id;
      await correctEntry(db.pool, A(owner), { entryId: last, newCount: 50, expectedCount: 49, reason: "miscount" });
      assert.equal(await entered(DAY), 500, "now the confirmed entries really add up to 500");
      const f1 = await dayFigures(db.pool, A(owner), DAY);
      assert.deepEqual([f1.childrenEntered, f1.childrenExpected, f1.entries], [500, 0, 10]);
      await correctEntry(db.pool, A(owner), { entryId: last, newCount: 40, expectedCount: 50, reason: "miscount" });
      assert.equal(await entered(DAY), 490, "a correction downwards removes the 500 again");
    });
  });

  describe("who may do what", () => {
    it("Owner and Manager work with attendance, the Editor does not", async () => {
      assert.deepEqual([can("owner", "attendance.manage"), can("manager", "attendance.manage"), can("editor", "attendance.manage")], [true, true, false]);
      const r = await register("Права", 1);
      const e = await addManualEntry(db.pool, A(manager), { childrenCount: 1, idempotencyKey: randomUUID() });
      const refusals = [
        () => dayFigures(db.pool, A(editor), TODAY),
        () => attendanceSeries(db.pool, A(editor), TODAY, TODAY),
        () => listRegistrations(db.pool, A(editor), TODAY),
        () => listEntries(db.pool, A(editor), TODAY),
        () => confirmRegistrationEntry(db.pool, A(editor), { registrationId: r.registrationId, childrenCount: 1 }),
        () => addManualEntry(db.pool, A(editor), { childrenCount: 1, idempotencyKey: randomUUID() }),
        () => correctEntry(db.pool, A(editor), { entryId: e.entryId, newCount: 2, expectedCount: 1, reason: "other" }),
      ];
      for (const call of refusals) await assert.rejects(call, ForbiddenError);
      assert.equal(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id = $1", [r.registrationId])), 0);
      assert.equal(Number(await scalar("SELECT children_count v FROM bb.attendance_entries WHERE id = $1", [e.entryId])), 1);
    });

    it("an anonymised adult is shown without a name, and the figures stay", async () => {
      const r = await register("Будет обезличен", 2);
      await confirmRegistrationEntry(db.pool, A(manager), { registrationId: r.registrationId, childrenCount: 2 });
      const cid = String(await scalar("SELECT contact_id v FROM bb.consent_registrations WHERE id = $1", [r.registrationId]));
      const f0 = await dayFigures(db.pool, A(owner), TODAY);
      await q("UPDATE bb.contacts SET name = 'Анонимизировано', name_key = $2, phone_e164 = NULL, anonymized_at = now() WHERE id = $1", [cid, `anon:${cid}`]);
      const row = (await listRegistrations(db.pool, A(owner), TODAY)).find((x) => x.id === r.registrationId)!;
      assert.equal(row.name, "—");
      assert.deepEqual(await dayFigures(db.pool, A(owner), TODAY), f0);
      assert.equal((await listEntries(db.pool, A(owner), TODAY)).find((x) => x.method === "qr" && x.adultName === "—") !== undefined, true);
    });
  });
});

describe("Attendance and the database roles", () => {
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
  const denied = (p: Pool, sql: string, params: unknown[] = []) => assert.rejects(() => p.query(sql, params), /permission denied|must be owner|row-level security|violates row-level|does not exist|append-only/i, sql);

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    await applyRoles(db.pool, { apiPassword: API_PW, adminPassword: ADMIN_PW });
    api = as("bb_api", API_PW);
    admin = as("bb_admin", ADMIN_PW);
  });
  after(async () => {
    await api.end();
    await admin.end();
    await db.stop();
  });

  it("the public API role has no access to attendance, and none through the table list", async () => {
    assert.ok(!("attendance_entries" in API_GRANTS) && !("attendance_corrections" in API_GRANTS));
    for (const t of ["attendance_entries", "attendance_corrections"]) {
      await denied(api, `SELECT 1 FROM bb.${t}`);
      await denied(api, `INSERT INTO bb.${t} DEFAULT VALUES`);
      await denied(api, `UPDATE bb.${t} SET children_count = 1`);
    }
  });

  it("the intake function accepts a registration only with 1..50 children, and the old two-argument form is gone", async () => {
    const c = String((await api.query("SELECT bb.intake_upsert_contact('Роль Дети', 'роль дети', NULL, 'qr') AS id")).rows[0].id);
    const call = (n: unknown) => api.query("SELECT id FROM bb.intake_insert_registration($1, $2, $3::smallint)", [randomUUID(), c, n]);
    await assert.rejects(() => call(null), /check|null/i);
    await assert.rejects(() => call(0), /check/i);
    await assert.rejects(() => call(51), /check/i);
    assert.equal((await call(50)).rows.length, 1);
    assert.equal((await call(1)).rows.length, 1);
    await assert.rejects(() => api.query("SELECT id FROM bb.intake_insert_registration($1, $2)", [randomUUID(), c]), /does not exist|function/i, "no way to create a registration without the number");
    const fns = (await api.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname LIKE 'intake\\_%'")).rows;
    assert.equal(fns.length, 12);
  });

  it("the staff role works with attendance but cannot delete, truncate or alter it", async () => {
    const e = await addManualEntry(admin, { id: owner.id, role: "owner" }, { childrenCount: 4, idempotencyKey: randomUUID() });
    assert.equal(Number((await admin.query("SELECT children_count FROM bb.attendance_entries WHERE id = $1", [e.entryId])).rows[0].children_count), 4);
    const fixed = await correctEntry(admin, { id: owner.id, role: "owner" }, { entryId: e.entryId, newCount: 5, expectedCount: 4, reason: "late_arrivals" });
    assert.equal(fixed.childrenCount, 5);
    assert.equal(Number((await admin.query("SELECT count(*) AS n FROM bb.attendance_corrections WHERE entry_id = $1", [e.entryId])).rows[0].n), 1, "the log trigger works for the staff role too");
    await denied(admin, "DELETE FROM bb.attendance_entries");
    await denied(admin, "DELETE FROM bb.attendance_corrections");
    await denied(admin, "TRUNCATE bb.attendance_entries");
    await denied(admin, "ALTER TABLE bb.attendance_entries DROP COLUMN method");
    await denied(admin, "UPDATE bb.attendance_corrections SET reason = 'other'");
  });
});

describe("Deployment order: migrations 001-013 -> roles -> verification", () => {
  let db: TestDb;
  let dir: string;
  const as = (user: string, password: string) => {
    const u = new URL(db.url);
    u.username = user;
    u.password = password;
    return createPool(u.toString(), { max: 2 });
  };

  before(async () => {
    db = await startTestDb({ migrate: false });
    // a database as it is BEFORE this release: migrations 001..012 only
    dir = mkdtempSync(join(tmpdir(), "bb-mig12-"));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x < "013")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.stop();
  });

  it("without migration 013 the preflight names the problem and the pages' check says 'not ready'", async () => {
    await migrate(db.pool, dir);
    assert.equal(await attendanceSchemaReady(db.pool), false);
    const r = await preflight(db.pool, MIGRATIONS_DIR);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.startsWith("migration_missing: 013_attendance.sql")), r.problems.join("; "));
    assert.ok(r.problems.some((p) => p.startsWith("attendance_schema_missing")));
    assert.ok(r.problems.some((p) => p.startsWith("intake_insert_registration_without_children_count_missing")));
  });

  it("roles applied BEFORE 013 and 013 applied after: bb_api loses the function until the roles are applied again (the order matters), and the preflight sees it", async () => {
    const owner = await makeUser(db.pool, "owner");
    await applyRoles(db.pool, { apiPassword: API_PW, adminPassword: ADMIN_PW });
    await migrate(db.pool, MIGRATIONS_DIR); // 013
    assert.equal(await attendanceSchemaReady(db.pool), true);
    const api = as("bb_api", API_PW);
    try {
      const c = String((await db.pool.query("SELECT bb.intake_upsert_contact('Порядок', 'порядок', NULL, 'qr') AS id")).rows[0].id);
      const call = () => api.query("SELECT id FROM bb.intake_insert_registration($1, $2, 2::smallint)", [randomUUID(), c]);
      await assert.rejects(call, /permission denied/i, "as bb_api, not as the database owner: no EXECUTE yet");
      const r = await preflight(db.pool, MIGRATIONS_DIR);
      assert.equal(r.ok, false);
      assert.ok(r.problems.some((p) => p.startsWith("bb_api_cannot_execute_intake_insert_registration")), r.problems.join("; "));
      // the documented order: roles again, then verification, then start
      await applyRoles(db.pool, { apiPassword: API_PW, adminPassword: ADMIN_PW });
      const ok = await preflight(db.pool, MIGRATIONS_DIR);
      assert.deepEqual(ok, { ok: true, problems: [] });
      assert.equal((await call()).rows.length, 1, "bb_api registers a visitor now");
      assert.equal(Number((await db.pool.query("SELECT count(*) AS n FROM bb.consent_registrations")).rows[0].n), 1);
      assert.ok(owner.id);
    } finally {
      await api.end();
    }
  });

  it("the preflight also catches an edited migration, a missing one and a role that may too much", async () => {
    const edited = mkdtempSync(join(tmpdir(), "bb-mig-edited-"));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(edited, f));
      const { writeFileSync, readFileSync } = await import("node:fs");
      writeFileSync(join(edited, "013_attendance.sql"), readFileSync(join(edited, "013_attendance.sql"), "utf8") + "\n-- edited\n");
      const r1 = await preflight(db.pool, edited);
      assert.ok(r1.problems.some((p) => p.startsWith("migration_changed_after_apply: 013_attendance.sql")));
      writeFileSync(join(edited, "014_future.sql"), "SELECT 1;");
      assert.ok((await preflight(db.pool, edited)).problems.some((p) => p.startsWith("migration_missing: 014_future.sql")));
    } finally {
      rmSync(edited, { recursive: true, force: true });
    }
    await db.pool.query("GRANT SELECT ON bb.attendance_entries TO bb_api");
    try {
      assert.ok((await preflight(db.pool, MIGRATIONS_DIR)).problems.some((p) => p.startsWith("bb_api_has_table_privilege: attendance_entries")));
    } finally {
      await db.pool.query("REVOKE ALL ON bb.attendance_entries FROM bb_api");
    }
    assert.equal((await preflight(db.pool, MIGRATIONS_DIR)).ok, true);
  });
});

describe("Consent editions are checked inside the platform transaction", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
  const scalar = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rows[0].v;
  const versions = async () => Object.fromEntries((await q("SELECT kind, version FROM bb.legal_documents WHERE status = 'published'")).rows.map((r) => [r.kind, r.version]));
  const counts = async () => ({
    contacts: Number(await scalar("SELECT count(*) v FROM bb.contacts")),
    registrations: Number(await scalar("SELECT count(*) v FROM bb.consent_registrations")),
    events: Number(await scalar("SELECT count(*) v FROM bb.consent_events")),
  });
  const publishNew = async (kind: "personal_data_consent" | "visit_rules" | "companion_duties") => {
    const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Новая редакция ${kind} ${randomUUID()}` });
    await approveDocument(db.pool, owner, d.id);
    await publishDocument(db.pool, owner, d.id);
  };
  const submit = (name: string, documentVersions?: Record<string, number>, key = randomUUID()) =>
    submitConsentV(db.pool, { idempotencyKey: key, name, childrenCount: 1, acceptRules: true, acceptPersonalData: true, documentVersions }, { ip: "203.0.113.9", ipPepper: "p", userAgent: "T" });

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    for (const kind of ["personal_data_consent", "visit_rules", "companion_duties"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
  });
  after(async () => db.stop());

  it("a registration for the editions the visitor saw is recorded against exactly those editions", async () => {
    const v = await versions();
    const r = await submit("Видел редакции", v);
    assert.equal(r.duplicate, false);
    const rec = (await q("SELECT d.kind, d.version FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id WHERE e.registration_id = $1 ORDER BY d.kind", [r.registrationId])).rows;
    assert.deepEqual(Object.fromEntries(rec.map((x) => [x.kind, x.version])), v);
  });

  it("an edition the visitor did not see is never recorded: nothing at all is written", async () => {
    const shown = await versions();
    await publishNew("personal_data_consent"); // published after the page was rendered
    const before = await counts();
    await assert.rejects(() => submit("Не видел новую", shown), DocumentsChangedError);
    assert.deepEqual(await counts(), before, "no contact, no registration, no consent event");
    // an incomplete or invented list is refused the same way
    await assert.rejects(async () => submit("Неполный список", { personal_data_consent: (await versions()).personal_data_consent }), DocumentsChangedError);
    await assert.rejects(async () => submit("Выдуманная версия", { ...(await versions()), visit_rules: 999 }), DocumentsChangedError);
    assert.deepEqual(await counts(), before);
    // the visitor who re-reads the new texts is accepted
    assert.equal((await submit("Прочитал новую", await versions())).duplicate, false);
  });

  it("a repeat with the same idempotency key creates nothing new, even after the editions changed", async () => {
    const key = randomUUID();
    const first = await submit("Повтор ключа", await versions(), key);
    await publishNew("visit_rules");
    const before = await counts();
    const repeat = await submit("Повтор ключа", { personal_data_consent: 1, visit_rules: 1, companion_duties: 1 }, key);
    assert.deepEqual([repeat.duplicate, repeat.registrationId], [true, first.registrationId]);
    assert.deepEqual(await counts(), before);
  });

  it("the editions are MANDATORY: a request without them records nothing, and so does an empty or foreign list; the platform never picks 'the current ones' itself", async () => {
    const before = await counts();
    const base = { idempotencyKey: randomUUID(), name: "Без редакций", childrenCount: 1, acceptRules: true as const, acceptPersonalData: true as const };
    await assert.rejects(() => submitConsent(db.pool, base as never), ValidationError, "missing");
    await assert.rejects(() => submitConsent(db.pool, { ...base, documentVersions: null } as never), ValidationError, "null");
    await assert.rejects(() => submitConsent(db.pool, { ...base, documentVersions: "x" } as never), ValidationError, "not an object");
    await assert.rejects(() => submitConsent(db.pool, { ...base, documentVersions: { visit_rules: "1" } } as never), ValidationError, "not numbers");
    await assert.rejects(() => submitConsent(db.pool, { ...base, documentVersions: {} } as never), DocumentsChangedError, "an empty list can never equal the published set");
    assert.deepEqual(await counts(), before, "no contact, registration or consent event was written");
    // the same body WITH the editions is accepted, so the refusals above were about the editions and nothing else
    assert.equal((await submitConsent(db.pool, { ...base, documentVersions: await publishedVersions(db.pool) })).duplicate, false);
  });

  it("a publication racing with submissions can never put an unseen edition into a consent", async () => {
    const shown = await versions();
    const pools = Array.from({ length: 4 }, () => db.newPool(6));
    const names = Array.from({ length: 24 }, (_, i) => `Гонка редакций ${i}`);
    const run = names.map((n, i) => submitConsentV(pools[i % 4], { idempotencyKey: randomUUID(), name: n, childrenCount: 1, acceptRules: true, acceptPersonalData: true, documentVersions: shown }));
    const publisher = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      await publishNew("personal_data_consent");
    })();
    const results = await Promise.allSettled([...run, publisher]);
    for (const r of results.slice(0, 24)) {
      if (r.status === "rejected") assert.ok(r.reason instanceof DocumentsChangedError, `only an edition conflict may refuse: ${String(r.reason)}`);
    }
    // every recorded consent names the editions that were shown
    const bad = await q(
      `SELECT count(*) v FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id JOIN bb.consent_registrations r ON r.id = e.registration_id JOIN bb.contacts c ON c.id = r.contact_id
        WHERE c.name LIKE 'Гонка редакций %' AND ((d.kind = 'personal_data_consent' AND d.version <> $1) OR (d.kind = 'visit_rules' AND d.version <> $2))`,
      [shown.personal_data_consent, shown.visit_rules],
    );
    assert.equal(Number(bad.rows[0].v), 0, "no consent for an unseen edition");
    // and a registration is complete or absent: every one has its full set of documents
    const partial = await q(`SELECT count(*) v FROM bb.consent_registrations r JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name LIKE 'Гонка редакций %' AND (SELECT count(*) FROM bb.consent_events e WHERE e.registration_id = r.id) <> 3`);
    assert.equal(Number(partial.rows[0].v), 0);
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  });
});
