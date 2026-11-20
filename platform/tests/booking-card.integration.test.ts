import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";
import { applyRoles } from "../scripts/db-roles.ts";
import { createPool, type Pool } from "../src/core/db.ts";
import { almatyToday } from "../src/core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import type { ValidSession } from "../src/core/session.ts";
import { makeUser, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

/**
 * Booking V2 through the typed bridge writers, as the real staff role (bb_admin, no UPDATE on append-only tables):
 * two managers share one event; the first creator is kept; every change lands in the event history; concurrent
 * edits and double bookings are refused by the database; a shared hall holds simultaneous events; a Sheets record can be
 * handed over to the CRM.
 */
register("./helpers/next-stub-hooks.mjs", import.meta.url);
const { bridgeBlock, bridgeCardGet, bridgeCardSave, bridgeConfirm, bridgeCreateRequest, bridgeHandover, bridgePayment, bridgeRelease, bridgeReschedule } = await import("../src/server/legacy-bridge.ts");

const plus = (days: number) => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const key = () => `k-${randomUUID()}`;
const session = (user: { id: string }, role: "manager" | "editor" | "owner", name: string) => ({ user: { id: user.id, role, name, email: `${name}@example.test` }, sessionId: "s" }) as unknown as ValidSession;

type Card = Awaited<ReturnType<typeof bridgeCardGet>>;

describe("Birthday CRM V2: the booking card", () => {
  let db: TestDb;
  let admin: Pool;
  let anna: ValidSession;
  let boris: ValidSession;
  let editor: ValidSession;
  const date = plus(30);

  before(async () => {
    db = await startTestDb();
    await seedFromSite(db.pool);
    await applyRoles(db.pool, { apiPassword: randomBytes(12).toString("hex") + "A1", adminPassword: "adm" + randomBytes(12).toString("hex") + "B2" });
    const password = "adm" + randomBytes(12).toString("hex");
    await db.pool.query(`ALTER ROLE bb_admin PASSWORD '${password}'`);
    const url = new URL(db.url);
    url.username = "bb_admin";
    url.password = password;
    admin = createPool(url.toString(), { max: 12 });
    const named = async (role: "manager" | "editor", email: string, name: string) => {
      const user = await makeUser(db.pool, role, email);
      await db.pool.query("UPDATE bb.users SET name = $2 WHERE id = $1", [user.id, name]);
      return session(user, role, name);
    };
    anna = await named("manager", "anna@example.test", "Анна");
    boris = await named("manager", "boris@example.test", "Борис");
    editor = await named("editor", "ed@example.test", "Ed");
  });
  after(async () => {
    await admin.end();
    await db.stop();
  });

  const request = async (who: ValidSession, phone: string, packageId = "star-party", guests = 9, d = date) =>
    (await bridgeCreateRequest(admin, who, { idempotencyKey: key(), requestedDate: d, customerName: `Клиент ${phone.slice(-4)}`, phone, packageId, guestCount: guests })) as { id: string };
  const prepay = (who: ValidSession, requestId: string) => bridgePayment(admin, who, { requestId, idempotencyKey: key(), amountKzt: 10000, method: "cash" });
  const book = async (who: ValidSession, requestId: string, roomId: string, startTime: string, packageId = "star-party", card?: Record<string, unknown>, d = date) =>
    (await bridgeConfirm(admin, who, { requestId, idempotencyKey: key(), bookingDate: d, roomId, startTime, packageId, agreedPriceKzt: 79900, ...(card ? { card } : {}) })) as { id: string };
  const get = async (id: string) => (await bridgeCardGet(admin, anna, { reservationId: id })) as Card;
  const save = (who: ValidSession, id: string, version: number | null, fields: Record<string, unknown>) =>
    bridgeCardSave(admin, who, { idempotencyKey: key(), reservationId: id, expectedVersion: version, fields }) as Promise<{ version: number; programStatus: string; changed: string[] }>;

  it("V4.2 catalog: three active packages with the specified terms, programs and prices; the old three are archived but kept", async () => {
    const packages = (await db.pool.query("SELECT id, is_active FROM bb.packages ORDER BY id")).rows;
    assert.deepEqual(packages.filter((p) => p.is_active).map((p) => p.id).sort(), ["boom-bala-party", "happy-party", "star-party"]);
    assert.deepEqual(packages.filter((p) => !p.is_active).map((p) => p.id).sort(), ["boom-party", "magic-party", "wow-party"]);
    const prices = (await db.pool.query("SELECT package_id, rule_type, amount_kzt FROM bb.price_rules WHERE note = 'Pricing V4.2' ORDER BY package_id, rule_type")).rows;
    assert.deepEqual(prices.map((p) => `${p.package_id}:${p.rule_type}:${p.amount_kzt}`), [
      "boom-bala-party:base:114900", "boom-bala-party:weekday:80430", "happy-party:base:54900", "happy-party:weekday:38430", "star-party:base:79900", "star-party:weekday:55930",
    ]);
    const terms = (await db.pool.query("SELECT package_id, included_children, included_adults, animators, program_minutes, room_minutes FROM bb.package_versions ORDER BY package_id")).rows;
    assert.deepEqual(terms.map((t) => [t.package_id, t.included_children, t.included_adults, t.animators, t.program_minutes, t.room_minutes]), [
      ["boom-bala-party", 10, 3, 2, 150, 240], ["happy-party", 6, 0, 1, 60, 240], ["star-party", 7, 0, 2, 90, 240],
    ]);
    const rules = (await db.pool.query(
      `SELECT r.package_id, r.kind, r.pick_count, count(o.option_id)::int AS offered FROM bb.package_program_rules r
         LEFT JOIN bb.package_program_options o USING (package_id, version, kind) GROUP BY 1,2,3 ORDER BY 1,2`,
    )).rows.map((r) => `${r.package_id}:${r.kind}:${r.pick_count}/${r.offered}`);
    assert.deepEqual(rules, [
      "boom-bala-party:animation:0/0", "boom-bala-party:challenge:1/4", "boom-bala-party:master_class:1/6", "boom-bala-party:show:2/6",
      "happy-party:animation:1/3", "happy-party:show:1/3",
      "star-party:animation:1/3", "star-party:challenge:1/4", "star-party:show:2/4",
    ]);
    // History is preserved: an archived package is unavailable for new sales only.
    const lead = await request(anna, "+77075550101", "wow-party").catch((e) => e);
    assert.ok(lead instanceof ValidationError, "an archived package cannot be sold");
  });

  it("two managers: creation, program, edit by another manager, move, prepayment, cancellation and the history", async () => {
    const roomA = "roblox-room";
    const lead = await request(anna, "+77075550102");
    await prepay(anna, lead.id);
    // Anna books Star Party with the customer card. 9 children of 7 included, 2 adults.
    const booked = await book(anna, lead.id, roomA, "13:25", "star-party", { childName: "Алия", childAge: 7, childrenTotal: 9, adultsTotal: 2, preferredLanguage: "kk", animators: ["Дино"] });

    const first = await get(booked.id);
    assert.equal(first.exists, true);
    assert.equal(first.createdByName, "Анна", "creator is the first manager");
    assert.equal(first.fields.childName, "Алия");
    assert.equal(first.fields.preferredLanguage, "kk");
    assert.equal(first.termsVersion, "v4.2");
    assert.equal(first.pricing.extraChildren, 2);
    assert.equal(first.pricing.status, "incomplete", "no approved extra-guest tariff exists: the amount is not invented");
    assert.equal(first.pricing.totalKzt, null);
    assert.equal(first.remainingKzt, null);
    assert.equal(first.paidKzt, 10000);
    assert.ok(first.history.some((h) => h.action === "created") && first.history.some((h) => h.action === "prepayment_recorded"));

    // Boris edits the same event without recreating it.
    const v1 = await save(boris, booked.id, first.version, { wishes: "Без орехов", propsStatus: "preparing", responsibleUserId: boris.user.id, selections: [{ kind: "show", optionId: "silver-show" }] });
    assert.equal(v1.version, first.version! + 1);
    // Anna still holds the old version: she is refused instead of overwriting Boris.
    await assert.rejects(save(anna, booked.id, first.version, { wishes: "перезапись" }), (e: unknown) => e instanceof ConflictError && e.message === "card_version_conflict");
    const afterBoris = await get(booked.id);
    assert.equal(afterBoris.fields.wishes, "Без орехов");
    assert.equal(afterBoris.responsibleName, "Борис");
    assert.equal(afterBoris.createdByName, "Анна", "the original creator is preserved");
    assert.equal(afterBoris.updatedByName, "Борис");

    // Program: an out-of-package show is refused; an incomplete program cannot be approved; a complete one can.
    await assert.rejects(save(boris, booked.id, afterBoris.version, { selections: [{ kind: "show", optionId: "beauty-bar" }] }), (e: unknown) => e instanceof ConflictError && e.message === "program_option_not_allowed");
    await assert.rejects(save(boris, booked.id, afterBoris.version, { programStatus: "approved" }), (e: unknown) => e instanceof ConflictError && e.message === "program_incomplete");
    const approved = await save(boris, booked.id, afterBoris.version, {
      selections: [{ kind: "animation", optionId: "board-games" }, { kind: "show", optionId: "silver-show" }, { kind: "show", optionId: "neon-show" }, { kind: "challenge", optionId: "fortune-wheel" }],
      programStatus: "approved",
    });
    assert.equal(approved.programStatus, "approved");
    // Changing an approved program reopens it.
    const reopened = await save(anna, booked.id, approved.version, { selections: [{ kind: "animation", optionId: "board-games" }, { kind: "show", optionId: "silver-show" }, { kind: "show", optionId: "dino-show" }, { kind: "challenge", optionId: "fortune-wheel" }] });
    assert.equal(reopened.programStatus, "draft");

    // The approved tariff arrives later: the amount is computed with the 20% discount on extra children only.
    await db.pool.query("INSERT INTO bb.guest_tariffs (kind, amount_kzt, valid_from) VALUES ('child', 5000, '2020-01-01'), ('adult', 3000, '2020-01-01')");
    const priced = await get(booked.id);
    assert.equal(priced.pricing.extraChildrenKzt, 8000, "2 x 5000 x 0.8");
    assert.equal(priced.pricing.extraAdultsKzt, 6000, "2 adults x 3000 (Star includes none)");
    assert.equal(priced.pricing.totalKzt, 79900 + 8000 + 6000);
    // A catalog change does not change the agreed price of an existing booking.
    await db.pool.query("INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt) VALUES ('star-party', 'base', 99999)");
    assert.equal((await get(booked.id)).pricing.totalKzt, 79900 + 8000 + 6000);

    // Boris moves the event: the same card follows, the creator stays Anna, and the move is in the history.
    const moved = (await bridgeReschedule(admin, boris, { idempotencyKey: key(), reservationId: booked.id, bookingDate: date, roomId: "ice-room", startTime: "15:10" })) as { id: string };
    assert.notEqual(moved.id, booked.id);
    const afterMove = await get(moved.id);
    assert.equal(afterMove.exists, true);
    assert.equal(afterMove.fields.childName, "Алия");
    assert.equal(afterMove.createdByName, "Анна");
    assert.equal(afterMove.history.find((h) => h.action === "rescheduled")?.actorName, "Борис");
    const row = (await db.pool.query("SELECT created_by FROM bb.slot_reservations WHERE id = $1", [moved.id])).rows[0];
    assert.equal(row.created_by, (await db.pool.query("SELECT created_by FROM bb.booking_cards WHERE reservation_id = $1", [moved.id])).rows[0].created_by);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.booking_cards WHERE lead_request_id = $1", [lead.id])).rows[0].n, 1, "no second card was created");

    // Anna cancels: the event shows it, the money fact stays.
    await bridgeRelease(admin, anna, { idempotencyKey: key(), reservationId: moved.id, reason: "семья отказалась" });
    const cancelled = await get(moved.id);
    assert.equal(cancelled.released, true);
    assert.ok(cancelled.history.some((h) => h.action === "cancelled" && h.actorName === "Анна"));
    assert.equal(cancelled.paidKzt, 10000);
    await assert.rejects(save(boris, moved.id, cancelled.version, { wishes: "после отмены" }), ConflictError);
    // History is append-only for the staff role.
    await assert.rejects(admin.query("UPDATE bb.booking_card_events SET action = 'created'"), /permission denied/);
    await assert.rejects(admin.query("DELETE FROM bb.booking_card_events"), /permission denied/);
  });

  it("«по факту», manager-agreed amounts and extra services; the total is never a partial sum", async () => {
    const lead = await request(anna, "+77075550103", "happy-party", 6);
    await prepay(anna, lead.id);
    const booked = await book(anna, lead.id, "magic-room", "13:00", "happy-party");
    const c0 = await get(booked.id);
    const v = await save(anna, booked.id, c0.version, { headcountMode: "by_fact", mealKzt: 20000, services: [{ name: "Декор шарами", amountKzt: 15000 }] });
    const byFact = await get(booked.id);
    assert.equal(byFact.pricing.status, "incomplete");
    assert.deepEqual(byFact.pricing.gaps, ["headcount_by_fact"]);
    assert.equal(byFact.pricing.totalKzt, null);
    await save(boris, booked.id, v.version, { manualExtraChildrenKzt: 0, manualExtraAdultsKzt: 0 });
    const settled = await get(booked.id);
    assert.equal(settled.pricing.status, "complete");
    assert.equal(settled.pricing.totalKzt, 79900 + 20000 + 15000, "agreed price + meal + services");
    assert.equal(settled.remainingKzt, 79900 + 20000 + 15000 - 10000);
    // Online invitation belongs to Boom Bala only.
    await assert.rejects(save(anna, booked.id, settled.version, { invitationStatus: "sent" }), (e: unknown) => e instanceof ConflictError && e.message === "invitation_not_applicable");
  });

  it("Boom Bala: two shows, one master class, one challenge; invitation status; approval validates on the server", async () => {
    const lead = await request(anna, "+77075550104", "boom-bala-party", 10);
    await prepay(anna, lead.id);
    const booked = await book(anna, lead.id, "rapunzel-room", "12:00", "boom-bala-party");
    const c = await get(booked.id);
    assert.equal(c.fields.invitationStatus, "not_started");
    assert.equal(c.terms?.rules.find((r) => r.kind === "show")?.options.length, 6);
    await assert.rejects(save(anna, booked.id, c.version, { selections: [{ kind: "master_class", optionId: "slime" }, { kind: "master_class", optionId: "kapitoshka" }] }), ConflictError, "one master class only");
    const done = await save(anna, booked.id, c.version, {
      selections: [{ kind: "show", optionId: "beauty-bar" }, { kind: "show", optionId: "cotton-candy-show" }, { kind: "master_class", optionId: "keychain-painting" }, { kind: "challenge", optionId: "bottle-challenge" }],
      programStatus: "approved", invitationStatus: "in_progress", animationNote: "Сценарий согласован с организатором",
    });
    assert.equal(done.programStatus, "approved");
    assert.equal((await get(booked.id)).fields.invitationStatus, "in_progress");
  });

  it("double booking is refused and a shared hall holds simultaneous events", async () => {
    const a = await request(anna, "+77075550105", "star-party", 7);
    const b = await request(boris, "+77075550106", "star-party", 7);
    await prepay(anna, a.id);
    await prepay(boris, b.id);
    const settled = await Promise.allSettled([book(anna, a.id, "roblox-room", "16:20"), book(boris, b.id, "roblox-room", "17:00")]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, "an exclusive room has one event at a time");
    const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    assert.ok(loser, "the second manager is told, not silently accepted");
    // The shared hall takes both, at overlapping times, each with its own card.
    const c = await request(anna, "+77075550107", "star-party", 7);
    const d = await request(boris, "+77075550108", "star-party", 7);
    await prepay(anna, c.id);
    await prepay(boris, d.id);
    const one = await book(anna, c.id, "general-hall", "13:00", "star-party", { childName: "Первый" });
    const two = await book(boris, d.id, "general-hall", "14:00", "star-party", { childName: "Второй" });
    assert.notEqual(one.id, two.id);
    assert.equal((await get(one.id)).fields.childName, "Первый");
    assert.equal((await get(two.id)).fields.childName, "Второй");
  });

  it("a Google Sheets record can be handed over to the CRM; sync-managed records stay read-only until then", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    try {
      const block = (await bridgeBlock(admin, anna, { idempotencyKey: key(), bookingDate: plus(40), roomId: "ice-room", startTime: "11:00", reason: "Импортировано" })) as { id: string };
      await db.pool.query(
        `INSERT INTO bb.sheet_sync_records (source_key, fingerprint, legacy_key_prefix, reservation_id, state, source_row_number, source_payload)
         VALUES ($1, $2, $3, $4, 'active', 5, $5::jsonb)`,
        ["a".repeat(64), "b".repeat(64), "c".repeat(20), block.id, JSON.stringify({ child: "Томирис", age: "6", children: "8", adults: "2", animator: "Лабубу", comment: "из таблицы" })],
      );
      await assert.rejects(bridgeRelease(admin, anna, { idempotencyKey: key(), reservationId: block.id, reason: "x" }), /source_managed_read_only/);
      const out = (await bridgeHandover(admin, boris, { idempotencyKey: key(), reservationId: block.id })) as { cardId: string };
      assert.ok(out.cardId);
      const card = await get(block.id);
      assert.equal(card.fields.childName, "Томирис");
      assert.equal(card.fields.childAge, 6);
      assert.equal(card.fields.childrenTotal, 8);
      assert.deepEqual(card.fields.animators, ["Лабубу"]);
      assert.ok(card.history.some((h) => h.action === "handed_over"));
      assert.equal((await db.pool.query("SELECT state FROM bb.sheet_sync_records WHERE reservation_id = $1", [block.id])).rows[0].state, "crm_managed");
      await assert.rejects(bridgeHandover(admin, boris, { idempotencyKey: key(), reservationId: block.id }), /already_handed_over/);
      // The CRM can now move and cancel it.
      const moved = (await bridgeReschedule(admin, boris, { idempotencyKey: key(), reservationId: block.id, bookingDate: plus(40), roomId: "ice-room", startTime: "12:30" })) as { id: string };
      assert.equal((await get(moved.id)).fields.childName, "Томирис", "the card followed the move");
      await bridgeRelease(admin, boris, { idempotencyKey: key(), reservationId: moved.id, reason: "ok" });
    } finally {
      delete process.env.SHEETS_SYNC_ENABLED;
    }
  });

  it("RBAC: a role without bookings.manage cannot read or write a card; bad ids are not found", async () => {
    const lead = await request(anna, "+77075550109");
    await prepay(anna, lead.id);
    const booked = await book(anna, lead.id, "magic-room", "17:10");
    await assert.rejects(bridgeCardGet(admin, editor, { reservationId: booked.id }), ForbiddenError);
    await assert.rejects(bridgeCardSave(admin, editor, { idempotencyKey: key(), reservationId: booked.id, expectedVersion: 1, fields: { wishes: "x" } }), ForbiddenError);
    await assert.rejects(bridgeCardGet(admin, anna, { reservationId: "not-a-uuid" }), /not_found/);
    await assert.rejects(bridgeCardSave(admin, anna, { idempotencyKey: key(), reservationId: booked.id, expectedVersion: 1, fields: { responsibleUserId: "not-a-uuid" } }), ValidationError);
    await assert.rejects(bridgeCardSave(admin, anna, { idempotencyKey: key(), reservationId: booked.id, expectedVersion: 1, fields: { childAge: 500 } }), ValidationError);
  });

  it("a card save is idempotent: the same key replays the answer and writes one history entry", async () => {
    const lead = await request(anna, "+77075550110");
    await prepay(anna, lead.id);
    const booked = await book(anna, lead.id, "roblox-room", "10:00");
    const c = await get(booked.id);
    const k = key();
    const input = { idempotencyKey: k, reservationId: booked.id, expectedVersion: c.version, fields: { wishes: "один раз" } };
    const results = await Promise.all(Array.from({ length: 6 }, () => bridgeCardSave(admin, anna, input) as Promise<{ version: number }>));
    assert.equal(new Set(results.map((r) => r.version)).size, 1);
    const updates = (await get(booked.id)).history.filter((h) => h.action === "updated");
    assert.equal(updates.length, 1);
  });

  it("an older reservation without a card is shown with defaults and gets its card on the first save", async () => {
    const d = plus(50);
    const manager = (await db.pool.query("SELECT id FROM bb.users WHERE email = 'anna@example.test'")).rows[0].id;
    const contact = (await db.pool.query("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ('Старый', 'старый', '+77075550111', 'manual') RETURNING id")).rows[0].id;
    const legacy = (await db.pool.query(
      `INSERT INTO bb.slot_reservations (kind, slot_date, room_id, contact_id, package_id, children, price_kzt, price_source, created_by, starts_at, ends_at)
       VALUES ('booking', $1, 'roblox-room', $2, 'wow-party', 5, 37900, 'base', $3, ($1::date + time '13:00') AT TIME ZONE 'Asia/Almaty', ($1::date + time '17:00') AT TIME ZONE 'Asia/Almaty') RETURNING id`,
      [d, contact, manager],
    )).rows[0].id;
    const view = await get(legacy);
    assert.equal(view.exists, false);
    assert.equal(view.version, null);
    assert.equal(view.pricing.totalKzt, null, "an archived package has no V4.2 terms: nothing is invented");
    assert.deepEqual(view.pricing.gaps, ["terms_missing"]);
    const saved = await save(boris, legacy, null, { childName: "Старый ребёнок", manualExtraChildrenKzt: 0, manualExtraAdultsKzt: 0 });
    assert.ok(saved.version >= 1);
    const after = await get(legacy);
    assert.equal(after.exists, true);
    assert.equal(after.pricing.totalKzt, 37900, "the frozen reservation price is the base");
    assert.equal(after.packageId, "wow-party", "the historic package link is intact");
  });
});
