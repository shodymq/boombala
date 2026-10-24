import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { addManualEntry, confirmRegistrationEntry, correctEntry, dayFigures, searchRegistrations } from "../src/core/attendance.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { approveDocument, createDraft, publishDocument } from "../src/core/legal.ts";
import { makeUser, startTestDb, submitConsentV, type TestDb } from "./helpers/db.ts";

describe("Front desk: finding a registration and confirming the entry (100 families)", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let cashier: Awaited<ReturnType<typeof makeUser>>;
  let cashier2: Awaited<ReturnType<typeof makeUser>>;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  const A = (u: { id: string; role: "owner" | "manager" | "editor" }) => ({ id: u.id, role: u.role });
  const TODAY = almatyToday();
  const ids: Array<{ id: string; seq: number; name: string }> = [];
  const register = async (name: string, children: number, phone: string | null) => {
    const r = await submitConsentV(db.pool, { idempotencyKey: randomUUID(), name, phone, childrenCount: children, acceptRules: true, acceptPersonalData: true }, { ip: "203.0.113.5", ipPepper: "pepper-for-tests-0123456789" });
    const seq = Number((await db.pool.query("SELECT seq FROM bb.consent_registrations WHERE id = $1", [r.registrationId])).rows[0].seq);
    ids.push({ id: r.registrationId, seq, name });
    return { id: r.registrationId, seq };
  };
  const find = (q: string, filter: "waiting" | "confirmed" | "all" = "all", limit = 500) => searchRegistrations(db.pool, A(cashier), TODAY, { q, filter, limit });

  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    cashier = await makeUser(db.pool, "manager");
    cashier2 = await makeUser(db.pool, "manager", "cashier2@example.test");
    editor = await makeUser(db.pool, "editor");
    for (const kind of ["personal_data_consent", "visit_rules"] as const) {
      const d = await createDraft(db.pool, owner, { kind, title: kind, body: `Текст ${kind}` });
      await approveDocument(db.pool, owner, d.id);
      await publishDocument(db.pool, owner, d.id);
    }
    // 100 registrations: 30 families with the SAME name, parents with and without a phone, a few awkward names
    for (let i = 0; i < 30; i++) await register("Айгерим Сериккызы", 1 + (i % 4), null);
    for (let i = 0; i < 20; i++) await register("Нурлан Ахметов", 2, `+7701555${String(1000 + i)}`);
    for (let i = 0; i < 45; i++) await register(`Семья Номер${i}`, 1 + (i % 3), i % 2 ? null : `+7702555${String(2000 + i)}`);
    await register("Иван_100%", 1, null);
    await register("Ёжик  Ежов", 2, null);
    await register("O'Neil", 1, null);
    await register("ТЕСТ Заглавные", 3, null);
    await register("Мария-Анна Иванова", 1, null);
    assert.equal(ids.length, 100);
  });
  after(async () => db.stop());

  it("finds any part of a name in any letter case, and the registration number", async () => {
    assert.equal((await find("айгерим")).matched, 30);
    assert.equal((await find("АЙГЕРИМ СЕРИККЫЗЫ")).matched, 30);
    assert.equal((await find("серикк")).matched, 30);
    assert.equal((await find("нурлан")).matched, 20);
    assert.equal((await find("ёжик ежов")).matched, 1, "double spaces are normalised");
    assert.equal((await find("заглавные")).matched, 1);
    assert.equal((await find("мария-анна")).matched, 1);
    assert.equal((await find("o'neil")).matched, 1);
    const one = ids[57];
    for (const q of [String(one.seq), `#${one.seq}`, `№ ${one.seq}`, ` № ${one.seq} `]) {
      const r = await find(q);
      assert.equal(r.matched, 1, q);
      assert.equal(r.rows[0].seq, one.seq);
    }
    assert.equal((await find("999999999")).matched, 0);
    assert.equal((await find("такого нет")).matched, 0);
  });

  it("treats % and _ as ordinary characters (a typed % must not match everything)", async () => {
    assert.equal((await find("%")).matched, 1);
    assert.equal((await find("_100%")).matched, 1);
    assert.equal((await find("_")).matched, 1);
    assert.equal((await find("и_н")).matched, 0);
  });

  it("is limited: only the first rows are returned, the rest is counted", async () => {
    const r = await find("", "all", 20);
    assert.equal(r.rows.length, 20);
    assert.equal(r.matched, 100);
    assert.equal(r.counts.all, 100);
    assert.deepEqual(r.rows.map((x) => x.seq), ids.slice(-20).reverse().map((x) => x.seq), "newest first");
    const capped = await searchRegistrations(db.pool, A(cashier), TODAY, { limit: 99999 });
    assert.equal(capped.rows.length, 100, "the limit is capped, not unlimited");
  });

  it("returns names and numbers only: never a phone, never the contact id", async () => {
    const r = await find("нурлан");
    const text = JSON.stringify(r);
    assert.ok(!/\+7701555|phone|contact/i.test(text));
    assert.deepEqual(Object.keys(r.rows[0]).sort(), ["createdAt", "declaredChildren", "enteredAt", "enteredChildren", "entryId", "id", "name", "seq", "status"]);
  });

  it("parents without a phone are listed like everyone else", async () => {
    const r = await find("айгерим", "waiting");
    assert.equal(r.rows.length, 30);
    assert.ok(r.rows.every((x) => x.status === "waiting" && x.name === "Айгерим Сериккызы"));
  });

  it("the filter: waiting by default, confirmed, all; a cancelled entry is only in «all»", async () => {
    const a = ids.filter((x) => x.name === "Айгерим Сериккызы");
    await confirmRegistrationEntry(db.pool, A(cashier), { registrationId: a[0].id, childrenCount: 1 });
    await confirmRegistrationEntry(db.pool, A(cashier), { registrationId: a[1].id, childrenCount: 2 });
    const c = await confirmRegistrationEntry(db.pool, A(cashier), { registrationId: a[2].id, childrenCount: 1 });
    await correctEntry(db.pool, A(cashier), { entryId: c.entryId, newCount: 0, expectedCount: 1, reason: "wrong_registration" });
    const def = await searchRegistrations(db.pool, A(cashier), TODAY, { q: "айгерим" });
    assert.equal(def.matched, 27, "default filter = waiting");
    const conf = await find("айгерим", "confirmed");
    assert.deepEqual(conf.rows.map((x) => x.seq).sort(), [a[0].seq, a[1].seq].sort());
    assert.ok(conf.rows.every((x) => x.status === "confirmed" && x.enteredChildren! > 0));
    const all = await find("айгерим", "all");
    assert.equal(all.matched, 30);
    assert.equal(all.rows.filter((x) => x.status === "cancelled").length, 1);
    assert.deepEqual(all.counts, { waiting: 97, confirmed: 2, cancelled: 1, all: 100 });
    assert.equal((await dayFigures(db.pool, A(cashier), TODAY)).childrenEntered, 3, "figures: 1 + 2 entered, the cancelled one counts 0");
  });

  it("repeat confirmation and two cashiers at the same moment: one entry, the second one is told it already exists", async () => {
    const r = await register("Гонка кассиров", 3, null);
    const [x, y] = await Promise.all([
      confirmRegistrationEntry(db.pool, A(cashier), { registrationId: r.id, childrenCount: 2 }),
      confirmRegistrationEntry(db.pool, A(cashier2), { registrationId: r.id, childrenCount: 3 }),
    ]);
    assert.deepEqual([x.duplicate, y.duplicate].sort(), [false, true]);
    assert.equal(x.entryId, y.entryId);
    assert.equal(x.registrationSeq, r.seq);
    const again = await confirmRegistrationEntry(db.pool, A(cashier), { registrationId: r.id, childrenCount: 9 });
    assert.equal(again.duplicate, true);
    assert.equal(Number((await db.pool.query("SELECT count(*) v FROM bb.attendance_entries WHERE registration_id = $1", [r.id])).rows[0].v), 1);
    const winner = Number((await db.pool.query("SELECT children_count v FROM bb.attendance_entries WHERE registration_id = $1", [r.id])).rows[0].v);
    assert.ok(winner === 2 || winner === 3, "the first confirmation wins, a repeat changes nothing");
    assert.equal(winner, again.childrenCount);
  });

  it("a correction after the entry moves the family between the filters and keeps the figures right", async () => {
    const r = await register("Исправление Семья", 2, null);
    const e = await confirmRegistrationEntry(db.pool, A(cashier), { registrationId: r.id, childrenCount: 1 });
    assert.equal((await find("исправление семья", "confirmed")).rows[0].enteredChildren, 1);
    await correctEntry(db.pool, A(cashier2), { entryId: e.entryId, newCount: 2, expectedCount: 1, reason: "late_arrivals" });
    const row = (await find("исправление семья", "confirmed")).rows[0];
    assert.equal(row.enteredChildren, 2);
    assert.equal((await find("исправление семья", "waiting")).matched, 0);
  });

  it("a registration of another day is not in today's list; an entry without QR does not appear in the list at all", async () => {
    const c = await db.pool.query("INSERT INTO bb.contacts (name, name_key, source) VALUES ('Вчерашний Гость', 'вчерашний гость', 'qr') RETURNING id");
    await db.pool.query("INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count, created_at) VALUES ($1, $2, 1, now() - interval '30 hours')", [randomUUID(), c.rows[0].id]);
    assert.equal((await find("вчерашний")).matched, 0);
    const before = (await find("")).counts.all;
    await addManualEntry(db.pool, A(cashier), { childrenCount: 1, idempotencyKey: randomUUID() });
    assert.equal((await find("")).counts.all, before);
  });

  it("only staff with attendance rights may search; a wrong date is refused", async () => {
    await assert.rejects(() => searchRegistrations(db.pool, A(editor), TODAY, { q: "айгерим" }), ForbiddenError);
    await assert.rejects(() => searchRegistrations(db.pool, A(cashier), "31-12-2026", {}), ValidationError);
    assert.equal((await searchRegistrations(db.pool, A(owner), TODAY, { q: "нурлан" })).matched, 20);
  });
});
