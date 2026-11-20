import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { registerHooks } from "node:module";
import type { SheetRead } from "../src/core/sheets-import/reader.ts";
import type { RawRow } from "../src/core/sheets-import/types.ts";
import { stableSourceIdentity } from "../src/core/sheets-import/identity.ts";
import { releaseReservation } from "../src/core/bookings.ts";
import { handoverSheetRecord } from "../src/core/booking-card.ts";
import { withTx } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { BOOKING_SHEETS_ID } from "../src/core/sheets-import/production-block-import.ts";
import { startTestDb, type TestDb } from "./helpers/db.ts";

// Node's native ESM resolver does not apply Next's webpack alias for this public entry point.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "next/headers" ? "next/headers.js" : specifier, context);
} });
const { runSheetsLiveSync } = await import("../src/server/sheets-live-sync.ts");

const HMAC = "test-only-hmac-key-that-is-at-least-thirty-two-bytes-long";
const DATE = "2099-02-20";
const NOW = new Date("2026-11-20T08:00:00.000Z");

function event(sourceId: string, date = DATE, time = "13:30", room = "Синтетическая exclusive комната", suffix = sourceId): RawRow {
  return {
    sourceId, date: date.split("-").reverse().join("."), time, room, package: "Синтетический пакет",
    client: `QA клиент ${suffix}`, phone: `+7 700 000 ${suffix.slice(-2).padStart(2, "0")} 01`,
    child: `QA ребёнок ${suffix}`, age: "8", animator: "QA аниматор", children: "3", adults: "2",
    prepayment: "10 000", comment: "Только синтетический интеграционный тест",
  };
}

function sheet(rows: RawRow[]): SheetRead {
  return {
    spreadsheetId: BOOKING_SHEETS_ID, sheetId: 77, sheetTitle: "Лист1", spreadsheetTimeZone: "Europe/Moscow", blankRows: 0,
    rows: rows.map((raw, index) => ({ raw, source: { spreadsheetId: BOOKING_SHEETS_ID, sheetId: 77, rowNumber: index + 3 } })),
  };
}

describe("Google Sheets live sync against isolated PostgreSQL", () => {
  let db: TestDb;
  let originalEnabled: string | undefined;
  let originalHmac: string | undefined;
  before(async () => {
    originalEnabled = process.env.SHEETS_SYNC_ENABLED;
    originalHmac = process.env.SHEETS_SYNC_HMAC_KEY;
    process.env.SHEETS_SYNC_HMAC_KEY = HMAC;
    db = await startTestDb();
    await db.pool.query("INSERT INTO rooms (id,name) VALUES ('sync-test-exclusive','Синтетическая exclusive комната')");
    await db.pool.query("INSERT INTO packages (id,name) VALUES ('sync-test-package','Синтетический пакет')");
  });
  after(async () => {
    if (originalEnabled === undefined) delete process.env.SHEETS_SYNC_ENABLED;
    else process.env.SHEETS_SYNC_ENABLED = originalEnabled;
    if (originalHmac === undefined) delete process.env.SHEETS_SYNC_HMAC_KEY;
    else process.env.SHEETS_SYNC_HMAC_KEY = originalHmac;
    await db.stop();
  });

  it("dry-runs without reservations, serializes workers, updates idempotently, and never cancels on source deletion", async () => {
    const source = sheet([event("event-qa-0001")]);
    process.env.SHEETS_SYNC_ENABLED = "0";
    const dry = await runSheetsLiveSync({ mode: "dry_run", trigger: "dry_run", pool: db.pool, now: NOW, readSource: async () => source });
    assert.equal(dry.counts.created, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive'")).rows[0].n, 0);

    process.env.SHEETS_SYNC_ENABLED = "1";
    let entered!: () => void;
    let release!: () => void;
    let secondRead = false;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => { entered(); await gate; return source; } });
    await enteredPromise;
    const second = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => { secondRead = true; return source; } });
    assert.equal(second.runId, null);
    assert.equal(secondRead, false);
    release();
    const applied = await first;
    const appliedReport = await db.pool.query("SELECT outcome,safe_error_code,counts,review_items FROM bb.sheet_sync_runs WHERE id=$1", [applied.runId]);
    assert.equal(applied.counts.created, 1, JSON.stringify({ counts: applied.counts, report: appliedReport.rows[0] }));
    assert.equal(applied.counts.verified, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND released_at IS NULL")).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.manual_payment_facts")).rows[0].n, 0);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.lead_requests")).rows[0].n, 0);
    const syncActor = await db.pool.query<{ id: string }>("SELECT id FROM bb.users WHERE email='sheets-sync@system.invalid'");
    const linked = await db.pool.query<{ reservation_id: string }>("SELECT reservation_id FROM bb.sheet_sync_records WHERE state='active' ORDER BY updated_at DESC LIMIT 1");
    await assert.rejects(() => releaseReservation(db.pool, { id: syncActor.rows[0].id, role: "manager" }, linked.rows[0].reservation_id, "synthetic test"), /source_managed_read_only/);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE id=$1 AND released_at IS NULL", [linked.rows[0].reservation_id])).rows[0].n, 1);

    const repeated = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => source });
    assert.equal(repeated.counts.unchanged, 1);
    assert.equal(repeated.counts.created, 0);

    const moved = sheet([event("event-qa-0001", DATE, "14:00", "Синтетическая exclusive комната")]);
    const movedResult = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => moved });
    assert.equal(movedResult.counts.updated, 1);
    const active = await db.pool.query<{ id: string; starts_at: Date }>("SELECT id,starts_at FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND released_at IS NULL");
    assert.equal(active.rowCount, 1);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(active.rows[0].starts_at), "14:00");

    const returned = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event("event-qa-0001", DATE, "13:30", "Синтетическая exclusive комната")]) });
    assert.equal(returned.counts.updated, 1);
    const movedBack = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => moved });
    assert.equal(movedBack.counts.updated, 1, "returning to a previously-used target needs a new transition idempotency key");
    const finalActive = await db.pool.query<{ id: string; starts_at: Date }>("SELECT id,starts_at FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND released_at IS NULL");
    assert.equal(finalActive.rowCount, 1);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(finalActive.rows[0].starts_at), "14:00");

    const deleted = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([]) });
    assert.equal(deleted.counts.sourceMissing, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND released_at IS NULL")).rows[0].n, 1);
  });

  it("refuses identity-key rotation after a successful dry-run instead of creating a new identity namespace", async () => {
    const original = process.env.SHEETS_SYNC_HMAC_KEY;
    process.env.SHEETS_SYNC_ENABLED = "0";
    process.env.SHEETS_SYNC_HMAC_KEY = HMAC;
    const first = await runSheetsLiveSync({ mode: "dry_run", trigger: "dry_run", pool: db.pool, now: NOW, readSource: async () => sheet([]) });
    assert.equal(first.mode, "dry_run");
    process.env.SHEETS_SYNC_HMAC_KEY = "different-test-only-hmac-key-that-is-long-enough";
    process.env.SHEETS_SYNC_ENABLED = "1";
    const attempted = event("event-qa-key-rotation", "2099-02-28", "13:00", "Синтетическая exclusive комната");
    await assert.rejects(
      () => runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([attempted]) }),
      /sheets_sync_key_changed/,
    );
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-02-28' AND released_at IS NULL")).rows[0].n, 0);
    const failed = await db.pool.query<{ safe_error_code: string }>("SELECT safe_error_code FROM bb.sheet_sync_runs WHERE outcome='failed' ORDER BY id DESC LIMIT 1");
    assert.equal(failed.rows[0].safe_error_code, "sheets_sync_key_changed");
    process.env.SHEETS_SYNC_HMAC_KEY = original ?? HMAC;
  });

  it("records conflicts and allows concurrent events in shared zones without payment facts", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const conflictRows = sheet([
      event("event-qa-conflict-1", "2099-02-21", "10:00", "Синтетическая exclusive комната", "Конфликт 1"),
      event("event-qa-conflict-2", "2099-02-21", "12:00", "Синтетическая exclusive комната", "Конфликт 2"),
    ]);
    const conflicts = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => conflictRows });
    assert.equal(conflicts.counts.conflicts, 2, JSON.stringify(conflicts.counts));
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-02-21' AND released_at IS NULL")).rows[0].n, 0);
    const run = await db.pool.query<{ review_items: unknown }>("SELECT review_items FROM bb.sheet_sync_runs WHERE id=$1", [conflicts.runId]);
    const report = JSON.stringify(run.rows[0].review_items);
    assert.match(report, /source_interval_overlap/);
    assert.equal(report.includes("QA клиент"), false);
    assert.equal(report.includes("+7 700"), false);

    await db.pool.query("INSERT INTO rooms (id,name,occupancy_mode) VALUES ('sync-test-shared','Синтетическая общая зона','shared')");
    const shared = sheet([
      event("event-qa-shared-1", "2099-02-22", "13:00", "Синтетическая общая зона", "Общий 1"),
      event("event-qa-shared-2", "2099-02-22", "13:30", "Синтетическая общая зона", "Общий 2"),
    ]);
    const sharedResult = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => shared });
    assert.equal(sharedResult.counts.created, 2, JSON.stringify(sharedResult.counts));
    assert.equal(sharedResult.counts.conflicts, 0);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-shared' AND released_at IS NULL")).rows[0].n, 2);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.manual_payment_facts")).rows[0].n, 0);
  });

  it("keeps rows without stable party identity in manual review rather than booking them", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const row = event("", "2099-02-23", "13:00", "Синтетическая exclusive комната", "Без идентификатора");
    delete row.phone;
    const result = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([row]) });
    assert.equal(result.counts.manualReview, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-02-23'")).rows[0].n, 0);
    const stored = await db.pool.query<{ source_payload: RawRow }>("SELECT source_payload FROM bb.sheet_sync_records WHERE source_row_number=3 AND safe_review_code='stable_id_missing'");
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].source_payload.phone, undefined);

    const outside = event("event-qa-outside", "2099-02-24", "18:01", "Синтетическая exclusive комната", "Вне часов");
    const hours = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([outside]) });
    assert.equal(hours.counts.manualReview, 1);
    const sourceKey = stableSourceIdentity(outside, HMAC);
    assert.notEqual(sourceKey.sourceKey, null);
    const report = await db.pool.query<{ safe_review_code: string }>("SELECT safe_review_code FROM bb.sheet_sync_records WHERE source_key=$1", [sourceKey.sourceKey]);
    assert.equal(report.rows[0].safe_review_code, "outside_working_hours");
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-02-24'")).rows[0].n, 0);
  });

  it("adopts one matching legacy block after adding a fixed ID, but holds new natural-only rows for review", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const legacyDate = "2099-02-27";
    const legacyRaw = event("", legacyDate, "12:00", "Синтетическая exclusive комната", "legacy-11");
    delete legacyRaw.sourceId;
    const legacyIdentity = stableSourceIdentity(legacyRaw, HMAC);
    assert.notEqual(legacyIdentity.sourceKey, null);
    const actor = await db.pool.query<{ id: string }>("SELECT id FROM bb.users WHERE email='sheets-sync@system.invalid'");
    const cells = ["", legacyRaw.date ?? "", legacyRaw.time ?? "", legacyRaw.package ?? "", legacyRaw.animator ?? "", legacyRaw.room ?? "", legacyRaw.client ?? "", legacyRaw.phone ?? "", legacyRaw.child ?? "", legacyRaw.age ?? "", legacyRaw.prepayment ?? "", "", legacyRaw.children ?? "", legacyRaw.adults ?? ""];
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at)
       VALUES ('block',$1,NULL,'sync-test-exclusive',$2,$3,$4::timestamptz,$5::timestamptz) RETURNING id`,
      [legacyDate, `Google Sheets «Банкеты», строка 7; A:N=${JSON.stringify(cells)}; предоплата не подтверждена; src=legacy-test`, actor.rows[0].id, `${legacyDate}T12:00:00+05:00`, `${legacyDate}T16:00:00+05:00`],
    );
    const legacyId = inserted.rows[0].id;

    // The newly-added explicit source ID changes the current key; the importer must still find the one old snapshot.
    const identified = event("sync-event-fixed-legacy-001", legacyDate, "14:00", "Синтетическая exclusive комната", "legacy-11");
    const migrated = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([identified]) });
    assert.equal(migrated.counts.updated, 1, JSON.stringify(migrated.counts));
    const reservations = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>(
      "SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND slot_date=$1 ORDER BY created_at", [legacyDate]);
    const activeRows = reservations.rows.filter((row) => !row.released_at);
    assert.equal(reservations.rowCount, 2, "atomic reschedule retains the old row as history");
    assert.equal(activeRows.length, 1, "only one active reservation exists after update");
    assert.notEqual(activeRows[0].id, legacyId, "the writer creates the replacement and preserves the released source row");
    assert.equal(reservations.rows.find((row) => row.id === legacyId)?.released_at instanceof Date, true);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(activeRows[0].starts_at), "14:00");

    const naturalOnly = event("", "2099-02-26", "13:00", "Синтетическая exclusive комната", "new-22");
    delete naturalOnly.sourceId;
    const held = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([naturalOnly]) });
    assert.equal(held.counts.manualReview, 1, JSON.stringify(held.counts));
    const heldSource = stableSourceIdentity(naturalOnly, HMAC);
    assert.notEqual(heldSource.sourceKey, null);
    const review = await db.pool.query<{ safe_review_code: string }>("SELECT safe_review_code FROM bb.sheet_sync_records WHERE source_key=$1", [heldSource.sourceKey]);
    assert.equal(review.rows[0].safe_review_code, "explicit_source_id_required");
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-02-26' AND released_at IS NULL")).rows[0].n, 0);

    for (const day of ["2099-03-01", "2099-03-02"]) {
      const repeatedParty = event("", day, "10:00", "Синтетическая exclusive комната", "repeat-77");
      delete repeatedParty.sourceId;
      const snapshot = ["", repeatedParty.date ?? "", repeatedParty.time ?? "", repeatedParty.package ?? "", repeatedParty.animator ?? "", repeatedParty.room ?? "", repeatedParty.client ?? "", repeatedParty.phone ?? "", repeatedParty.child ?? "", repeatedParty.age ?? "", repeatedParty.prepayment ?? "", "", repeatedParty.children ?? "", repeatedParty.adults ?? ""];
      await db.pool.query(
        `INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at)
         VALUES ('block',$1,NULL,'sync-test-exclusive',$2,$3,$4::timestamptz,$5::timestamptz)`,
        [day, `Google Sheets «Банкеты», строка 9; A:N=${JSON.stringify(snapshot)}; предоплата не подтверждена; src=legacy-repeat`, actor.rows[0].id, `${day}T10:00:00+05:00`, `${day}T14:00:00+05:00`],
      );
    }
    const ambiguousEvent = event("sync-repeated-party-fixed-id", "2099-03-03", "10:00", "Синтетическая exclusive комната", "repeat-77");
    const ambiguous = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([ambiguousEvent]) });
    assert.equal(ambiguous.counts.manualReview, 1, JSON.stringify(ambiguous.counts));
    const ambiguousKey = stableSourceIdentity(ambiguousEvent, HMAC);
    assert.notEqual(ambiguousKey.sourceKey, null);
    const ambiguousRow = await db.pool.query<{ safe_review_code: string }>("SELECT safe_review_code FROM bb.sheet_sync_records WHERE source_key=$1", [ambiguousKey.sourceKey]);
    assert.equal(ambiguousRow.rows[0].safe_review_code, "legacy_source_match_ambiguous");
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE slot_date='2099-03-03' AND released_at IS NULL")).rows[0].n, 0);
  });

  it("a record handed over to the CRM is ignored by sync: not moved, not released, not marked missing", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const handoverDate = "2099-04-10";
    const created = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event("event-qa-handover", handoverDate, "13:30", "Синтетическая exclusive комната", "handover-41")]) });
    assert.equal(created.counts.created, 1);
    const record = (await db.pool.query<{ reservation_id: string }>("SELECT reservation_id FROM bb.sheet_sync_records WHERE reservation_id IN (SELECT id FROM bb.slot_reservations WHERE slot_date=$1)", [handoverDate])).rows[0];
    const manager = await createUser(db.pool, null, { email: "handover.manager@example.test", name: "Передача", role: "manager", password: "correct horse battery staple" });
    await withTx(db.pool, (tx) => handoverSheetRecord(tx, manager.id, record.reservation_id));

    // The sheet row now says 14:00 and later disappears: the CRM owns the record, sync must not touch it.
    const changed = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event("event-qa-handover", handoverDate, "14:00", "Синтетическая exclusive комната", "handover-41")]) });
    assert.equal(changed.counts.updated, 0);
    assert.equal(changed.counts.unchanged, 1);
    const still = await db.pool.query<{ id: string; released_at: Date | null; starts_at: Date }>("SELECT id, released_at, starts_at FROM bb.slot_reservations WHERE slot_date=$1", [handoverDate]);
    assert.equal(still.rowCount, 1, "no second reservation");
    assert.equal(still.rows[0].id, record.reservation_id);
    assert.equal(still.rows[0].released_at, null);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(still.rows[0].starts_at), "13:30", "the time was not changed by the sheet");

    const gone = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([]) });
    assert.equal((await db.pool.query("SELECT state FROM bb.sheet_sync_records WHERE reservation_id=$1", [record.reservation_id])).rows[0].state, "crm_managed", "an absent row does not flip a handed-over record to source_missing");
    assert.ok(gone.counts.sourceMissing >= 0);
    const card = await db.pool.query("SELECT child_name, children_total, responsible_user_id FROM bb.booking_cards WHERE reservation_id=$1", [record.reservation_id]);
    assert.equal(card.rows[0].child_name, "QA ребёнок handover-41");
    assert.equal(card.rows[0].children_total, 3);
    assert.equal(card.rows[0].responsible_user_id, manager.id);
  });
});
