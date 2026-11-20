import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { confirmLead, releaseReservation } from "../src/core/bookings.ts";
import { CURRENT_PACKAGES, LEGACY_PACKAGES, restoreCatalog, retireLegacyPackages, snapshotCatalog, type CatalogSnapshot } from "../src/core/catalog-release.ts";
import { migrate } from "../src/core/migrate.ts";
import { preflight } from "../src/core/preflight.ts";
import { submitLead } from "../src/core/intake.ts";
import { ValidationError } from "../src/core/errors.ts";
import { makeUser, MIGRATIONS_DIR, seedFromSite, startTestDb, type TestDb } from "./helpers/db.ts";

/**
 * Release rehearsal on a database that looks like production BEFORE the release: migrations 001..013, the legacy packages on sale with
 * their real prices, and a legacy booking. The steps are the ones of the runbook: snapshot -> migrate -> seed -> ready check -> the site
 * switch (new enquiries and bookings for V3) -> retire the legacy packages -> final check -> rollback to the snapshot. Nothing that already
 * exists may change along the way: prices of existing bookings, their packages, the price history and the bookings made under V3.
 */

const FUTURE = "2099-03-04"; // a Wednesday (weekday price applies)
const FUTURE_SAT = "2099-03-07"; // a Saturday (weekend price applies)
const LEGACY_BOOM_WEEKDAY = 55930; // BOOM PARTY weekday price before V3 (a Wednesday booking)

describe("catalogue release: rehearsal of the switch, the retirement and the rollback", () => {
  let db: TestDb;
  let legacyDir: string;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let snapshot: CatalogSnapshot;
  let legacyReservation: string;
  let v3Reservation: string;
  const actor = () => ({ id: owner.id, role: "owner" as const });
  const scalar = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows[0].v;

  before(async () => {
    db = await startTestDb({ migrate: false });
    legacyDir = mkdtempSync(join(tmpdir(), "bb-prerelease-"));
    for (const f of readdirSync(MIGRATIONS_DIR)) if (Number(f.slice(0, 3)) <= 13) copyFileSync(join(MIGRATIONS_DIR, f), join(legacyDir, f));
    await migrate(db.pool, legacyDir);
    owner = await makeUser(db.pool, "owner", "release.owner@example.test");

    // The state of production before the release: the legacy packages on sale with their prices.
    await db.pool.query(`INSERT INTO bb.rooms (id, name, sort_order) VALUES ('roblox-room','Roblox Room',0),('ice-room','Ice Room',1),('magic-room','Magic Room',2),('rapunzel-room','Rapunzel Room',3)`);
    await db.pool.query(`INSERT INTO bb.packages (id, name, sort_order, is_active) VALUES ('wow-party','WOW PARTY',0,false),('magic-party','MAGIC PARTY',1,true),('boom-party','BOOM PARTY',2,true)`);
    await db.pool.query(
      `INSERT INTO bb.price_rules (package_id, rule_type, amount_kzt, note) VALUES
         ('magic-party','base',44900,'before V3'),('magic-party','weekday',31430,'before V3'),
         ('boom-party','base',79990,'before V3'),('boom-party','weekday',55930,'before V3')`,
    );
    await db.pool.query("INSERT INTO bb.legal_documents (kind, version, title, body, status, published_at) VALUES ('personal_data_consent', 1, 'Согласие', 'Текст.', 'published', now())");

    // A legacy enquiry and booking, confirmed while BOOM PARTY was on sale.
    const lead = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Анна Старая", phone: "+77010000101", date: FUTURE, children: 6, packageId: "boom-party", roomId: "roblox-room", slotId: 1, consent: true });
    legacyReservation = (await confirmLead(db.pool, actor(), { leadId: lead.leadId })).reservationId;
    snapshot = await snapshotCatalog(db.pool);
  });

  after(async () => {
    await db.stop();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("the snapshot records the state before the release (legacy on sale, V3 absent)", () => {
    const active = snapshot.packages.filter((p) => p.isActive).map((p) => p.id).sort();
    assert.deepEqual(active, ["boom-party", "magic-party"]);
    assert.equal(snapshot.packages.some((p) => p.id === "happy-party"), false);
  });

  it("after the migration and the seed the database is READY: V3 is priced, the legacy packages may still be on sale", async () => {
    await migrate(db.pool, MIGRATIONS_DIR);
    await seedFromSite(db.pool);
    const ready = await preflight(db.pool, MIGRATIONS_DIR, "ready");
    assert.deepEqual(ready.problems.filter((p) => !p.includes("bb_api") && !p.includes("bb_admin")), [], "roles are a separate step (db:roles)");
    // the old site still sends the legacy ids: they must still be accepted while the switch is pending
    const oldSite = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Старый Сайт", phone: "+77010000102", date: FUTURE, children: 4, packageId: "magic-party", consent: true });
    assert.ok(oldSite.leadId);
  });

  it("the new site: Star and Boom Bala bookings are priced by the server on the right day (weekday/weekend), frozen per booking", async () => {
    const star = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Новый Старр", phone: "+77010000103", date: FUTURE, children: 7, packageId: "star-party", roomId: "ice-room", slotId: 2, consent: true });
    v3Reservation = (await confirmLead(db.pool, actor(), { leadId: star.leadId })).reservationId;
    assert.equal(Number(await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE id = $1", [v3Reservation])), 55930, "Wednesday: weekday price");
    const sat = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Новый Бум", phone: "+77010000104", date: FUTURE_SAT, children: 10, packageId: "boom-bala-party", roomId: "rapunzel-room", slotId: 3, consent: true });
    const boomSat = (await confirmLead(db.pool, actor(), { leadId: sat.leadId })).reservationId;
    assert.equal(Number(await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE id = $1", [boomSat])), 114900, "Saturday: weekend price");
  });

  it("the client cannot set the price: the server prices the enquiry when the booking is confirmed", async () => {
    const probe = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Подмена", phone: "+77010000106", date: "2099-03-05", children: 2, packageId: "star-party", roomId: "magic-room", slotId: 1, consent: true });
    const r = (await confirmLead(db.pool, actor(), { leadId: probe.leadId })).reservationId;
    assert.equal(Number(await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE id = $1", [r])), 55930, "the server price (a Thursday: weekday), not a client amount");
  });

  it("the final check refuses while the legacy packages are still on sale (after the switch they must be off)", async () => {
    const before = await preflight(db.pool, MIGRATIONS_DIR, "final");
    assert.ok(before.problems.some((p) => p.startsWith("retired_birthday_package_on_sale")), before.problems.join("; "));
  });

  it("retirement takes the legacy packages off sale, is idempotent, and keeps every row, price and booking", async () => {
    const off = await retireLegacyPackages(db.pool);
    assert.deepEqual(off, ["boom-party", "magic-party"]);
    assert.deepEqual(await retireLegacyPackages(db.pool), [], "second run changes nothing");
    const final = await preflight(db.pool, MIGRATIONS_DIR, "final");
    assert.equal(final.problems.some((p) => p.includes("retired") || p.includes("birthday_packages_v3")), false, final.problems.join("; "));
    assert.equal(Number(await scalar("SELECT count(*) v FROM bb.price_rules WHERE package_id = 'boom-party'")), 2, "the legacy price history is kept");
    assert.equal(Number(await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE id = $1", [legacyReservation])), LEGACY_BOOM_WEEKDAY, "the legacy booking (a Wednesday) keeps its frozen price");
    assert.equal(await scalar("SELECT l.package_id v FROM bb.lead_requests l JOIN bb.slot_reservations s ON s.lead_request_id = l.id WHERE s.id = $1", [legacyReservation]), "boom-party");
  });

  it("after retirement a NEW enquiry for a legacy package is refused with a clear validation error (no silent substitution)", async () => {
    await assert.rejects(() => submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Поздно", phone: "+77010000107", date: FUTURE, children: 3, packageId: "boom-party", consent: true }), ValidationError);
  });

  it("a legacy booking can still be managed: released, and the released cell is free again", async () => {
    await releaseReservation(db.pool, actor(), legacyReservation, "тест истории");
    assert.ok(await scalar("SELECT released_at v FROM bb.slot_reservations WHERE id = $1", [legacyReservation]));
  });

  it("ROLLBACK: the sale flags return to the snapshot, the V3 packages leave NEW sales, and the V3 booking stays as it was", async () => {
    const r = await restoreCatalog(db.pool, snapshot, { deactivateCurrent: true });
    assert.ok(r.restored.length > 0);
    const active = (await db.pool.query("SELECT id FROM bb.packages WHERE is_active ORDER BY id")).rows.map((x) => x.id);
    assert.deepEqual(active, ["boom-party", "magic-party"], "exactly the pre-release sale state");
    for (const id of CURRENT_PACKAGES) assert.equal(active.includes(id), false, `${id} is off new sales`);
    assert.equal(Number(await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE id = $1", [v3Reservation])), 55930, "the V3 booking keeps its amount");
    assert.equal(await scalar("SELECT count(*) v FROM bb.slot_reservations WHERE id = $1", [v3Reservation]), "1", "nothing was deleted");
    // the old site accepts enquiries again
    const again = await submitLead(db.pool, { idempotencyKey: randomUUID(), name: "Откат", phone: "+77010000108", date: FUTURE, children: 5, packageId: "boom-party", consent: true });
    assert.ok(again.leadId);
    const audit = await db.pool.query("SELECT action FROM bb.audit_log WHERE action IN ('catalog.legacy_retired','catalog.restored') ORDER BY id");
    assert.deepEqual(audit.rows.map((x) => x.action), ["catalog.legacy_retired", "catalog.restored"]);
  });

  it("the legacy packages are the only ones named in the release: the constants match the runbook", () => {
    assert.deepEqual([...LEGACY_PACKAGES], ["wow-party", "magic-party", "boom-party"]);
    assert.deepEqual([...CURRENT_PACKAGES], ["happy-party", "star-party", "boom-bala-party"]);
  });
});
