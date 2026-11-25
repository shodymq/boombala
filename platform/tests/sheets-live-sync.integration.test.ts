import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerHooks } from "node:module";
import type { SheetRead } from "../src/core/sheets-import/types.ts";
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
const { processSignedSheetsWebhook, readBoundedRequestBody, SheetsWebhookError } = await import("../src/server/sheets-webhook.ts");

const HMAC = "test-only-hmac-key-that-is-at-least-thirty-two-bytes-long";
const DATE = "2099-02-20";
const NOW = new Date("2026-11-20T08:00:00.000Z");

function event(sourceId: string, date = DATE, time = "13:00", room = "Синтетическая exclusive комната", suffix = sourceId): RawRow {
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

function signedRequest(payload: Record<string, unknown>, options: { timestamp?: string; nonce?: string; signature?: string } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const nonce = options.nonce ?? randomUUID();
  const signature = options.signature ?? createHmac("sha256", HMAC).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
  return { timestamp, nonce, signature, rawBody };
}

describe("Google Sheets live sync against isolated PostgreSQL", () => {
  let db: TestDb;
  let originalEnabled: string | undefined;
  let originalHmac: string | undefined;
  let originalWebhookEnabled: string | undefined;
  let originalWebhookHmac: string | undefined;
  before(async () => {
    originalEnabled = process.env.SHEETS_SYNC_ENABLED;
    originalHmac = process.env.SHEETS_SYNC_HMAC_KEY;
    originalWebhookEnabled = process.env.SHEETS_WEBHOOK_ENABLED;
    originalWebhookHmac = process.env.SHEETS_WEBHOOK_HMAC_KEY;
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
    if (originalWebhookEnabled === undefined) delete process.env.SHEETS_WEBHOOK_ENABLED;
    else process.env.SHEETS_WEBHOOK_ENABLED = originalWebhookEnabled;
    if (originalWebhookHmac === undefined) delete process.env.SHEETS_WEBHOOK_HMAC_KEY;
    else process.env.SHEETS_WEBHOOK_HMAC_KEY = originalWebhookHmac;
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

    const returned = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event("event-qa-0001", DATE, "13:00", "Синтетическая exclusive комната")]) });
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

  it("dry-run reports an existing reservation move into an occupied interval without changing either block", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const date = "2099-02-25";
    const id = "event-qa-dry-move-blocked";
    const initial = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event(id, date, "10:00", "Синтетическая exclusive комната")]) });
    assert.equal(initial.counts.created, 1);
    const actor = await db.pool.query<{ id: string }>("SELECT id FROM bb.users WHERE email='sheets-sync@system.invalid'");
    await db.pool.query(
      `INSERT INTO bb.slot_reservations (kind,slot_date,slot_id,room_id,note,created_by,starts_at,ends_at)
       VALUES ('block',$1,NULL,'sync-test-exclusive','Синтетическая независимая блокировка',$2,$3::timestamptz,$4::timestamptz)`,
      [date, actor.rows[0].id, `${date}T17:00:00+05:00`, `${date}T21:00:00+05:00`],
    );
    const before = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>("SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE slot_date=$1 ORDER BY id", [date]);
    const moved = await runSheetsLiveSync({ mode: "dry_run", trigger: "dry_run", pool: db.pool, now: NOW, readSource: async () => sheet([event(id, date, "14:00", "Синтетическая exclusive комната")]) });
    assert.equal(moved.counts.conflicts, 1, JSON.stringify(moved.counts));
    assert.equal(moved.counts.updated, 0);
    const report = await db.pool.query<{ review_items: Array<{ status: string; safeCode: string | null }> }>("SELECT review_items FROM bb.sheet_sync_runs WHERE id=$1", [moved.runId]);
    assert.equal(report.rows[0].review_items[0].status, "conflict");
    assert.equal(report.rows[0].review_items[0].safeCode, "room_interval_occupied");
    const after = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>("SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE slot_date=$1 ORDER BY id", [date]);
    assert.deepEqual(after.rows, before.rows);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.manual_payment_facts")).rows[0].n, 0);
  });

  it("dry-run detects overlapping moves as a set and keeps both original reservations untouched", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const date = "2099-05-26";
    const firstId = "event-qa-dry-move-pair-1";
    const secondId = "event-qa-dry-move-pair-2";
    const newId = "event-qa-dry-move-pair-new";
    const initial = await runSheetsLiveSync({
      mode: "apply", trigger: "manual", pool: db.pool, now: NOW,
      readSource: async () => sheet([
        event(firstId, date, "10:00", "Синтетическая exclusive комната"),
        event(secondId, date, "18:00", "Синтетическая exclusive комната"),
      ]),
    });
    assert.equal(initial.counts.created, 2);
    const before = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>("SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE slot_date=$1 ORDER BY id", [date]);
    const moved = await runSheetsLiveSync({
      mode: "dry_run", trigger: "dry_run", pool: db.pool, now: NOW,
      readSource: async () => sheet([
        event(firstId, date, "14:00", "Синтетическая exclusive комната"),
        event(secondId, date, "13:00", "Синтетическая exclusive комната"),
        event(newId, date, "17:00", "Синтетическая exclusive комната"),
      ]),
    });
    assert.equal(moved.counts.conflicts, 3, JSON.stringify(moved.counts));
    assert.equal(moved.counts.updated, 0);
    assert.equal(moved.counts.created, 0);
    const report = await db.pool.query<{ review_items: Array<{ status: string; safeCode: string | null }> }>("SELECT review_items FROM bb.sheet_sync_runs WHERE id=$1", [moved.runId]);
    assert.equal(report.rows[0].review_items.length, 3);
    assert.ok(report.rows[0].review_items.every((item) => item.status === "conflict" && item.safeCode === "source_interval_overlap"));
    const after = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>("SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE slot_date=$1 ORDER BY id", [date]);
    assert.deepEqual(after.rows, before.rows);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.manual_payment_facts")).rows[0].n, 0);
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
      event("event-qa-shared-2", "2099-02-22", "14:00", "Синтетическая общая зона", "Общий 2"),
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

    const outside = event("event-qa-outside", "2099-02-24", "19:00", "Синтетическая exclusive комната", "Вне часов");
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
    const created = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event("event-qa-handover", handoverDate, "13:00", "Синтетическая exclusive комната", "handover-41")]) });
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
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(still.rows[0].starts_at), "13:00", "the time was not changed by the sheet");

    const gone = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([]) });
    assert.equal((await db.pool.query("SELECT state FROM bb.sheet_sync_records WHERE reservation_id=$1", [record.reservation_id])).rows[0].state, "crm_managed", "an absent row does not flip a handed-over record to source_missing");
    assert.ok(gone.counts.sourceMissing >= 0);
    const card = await db.pool.query("SELECT child_name, children_total, responsible_user_id FROM bb.booking_cards WHERE reservation_id=$1", [record.reservation_id]);
    assert.equal(card.rows[0].child_name, "QA ребёнок handover-41");
    assert.equal(card.rows[0].children_total, 3);
    assert.equal(card.rows[0].responsible_user_id, manager.id);
  });

  it("preserves CRM ownership through invalid, valid, changed, and missing source rows", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const date = "2099-04-11";
    const sourceId = "event-qa-handover-sequence";
    const original = event(sourceId, date, "13:00", "Синтетическая exclusive комната", "handover-sequence");
    const created = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([original]) });
    assert.equal(created.counts.created, 1);
    const sourceKey = stableSourceIdentity(original, HMAC).sourceKey!;
    const reservationId = (await db.pool.query<{ reservation_id: string }>("SELECT reservation_id FROM bb.sheet_sync_records WHERE source_key=$1", [sourceKey])).rows[0].reservation_id;
    const manager = await createUser(db.pool, null, { email: "handover-sequence@example.test", name: "Менеджер sequence", role: "manager", password: "correct horse battery staple" });
    await withTx(db.pool, (tx) => handoverSheetRecord(tx, manager.id, reservationId));
    const before = await db.pool.query<{ id: string; room_id: string; starts_at: Date; ends_at: Date; released_at: Date | null; state: string; source_key: string; responsible_user_id: string | null }>(
      `SELECT r.id,r.room_id,r.starts_at,r.ends_at,r.released_at,s.state,s.source_key,c.responsible_user_id
         FROM bb.slot_reservations r JOIN bb.sheet_sync_records s ON s.reservation_id=r.id
         JOIN bb.booking_cards c ON c.reservation_id=r.id WHERE r.id=$1`, [reservationId]);

    const assertPreserved = async () => {
      const current = await db.pool.query<{ id: string; room_id: string; starts_at: Date; ends_at: Date; released_at: Date | null; state: string; source_key: string; responsible_user_id: string | null }>(
        `SELECT r.id,r.room_id,r.starts_at,r.ends_at,r.released_at,s.state,s.source_key,c.responsible_user_id
           FROM bb.slot_reservations r JOIN bb.sheet_sync_records s ON s.reservation_id=r.id
           JOIN bb.booking_cards c ON c.reservation_id=r.id WHERE r.id=$1`, [reservationId]);
      assert.deepEqual(current.rows, before.rows);
      assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND slot_date=$1 AND released_at IS NULL", [date])).rows[0].n, 1);
    };

    const invalid = { ...original, time: "13:45" };
    const invalidRun = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([invalid]) });
    assert.equal(invalidRun.counts.manualReview, 1);
    await assertPreserved();

    const valid = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([original]) });
    assert.equal(valid.counts.unchanged, 1);
    await assertPreserved();

    const changed = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([event(sourceId, date, "14:00", "Синтетическая exclusive комната", "handover-sequence")]) });
    assert.equal(changed.counts.unchanged, 1);
    await assertPreserved();

    const missing = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([]) });
    assert.equal(missing.counts.sourceMissing, 0);
    await assertPreserved();
  });

  it("fences a stale sync snapshot when CRM handover commits concurrently", async () => {
    process.env.SHEETS_SYNC_ENABLED = "1";
    const date = "2099-04-12";
    const sourceId = "event-qa-handover-race";
    const original = event(sourceId, date, "13:00", "Синтетическая exclusive комната", "handover-race");
    const created = await runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: db.pool, now: NOW, readSource: async () => sheet([original]) });
    assert.equal(created.counts.created, 1);
    const sourceKey = stableSourceIdentity(original, HMAC).sourceKey!;
    const mapped = await db.pool.query<{ source_key: string; reservation_id: string }>("SELECT source_key,reservation_id FROM bb.sheet_sync_records WHERE source_key=$1", [sourceKey]);
    const manager = await createUser(db.pool, null, { email: "handover-race@example.test", name: "Менеджер race", role: "manager", password: "correct horse battery staple" });

    let snapshotRead!: () => void;
    let continueSync!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const gate = new Promise<void>((resolve) => { continueSync = resolve; });
    let paused = false;
    const racingPool = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === "query") return async (...args: Parameters<typeof target.query>) => {
          const result = await target.query(...args);
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as unknown as { text: string }).text;
          if (!paused && sql.startsWith("SELECT source_key,fingerprint,legacy_key_prefix,reservation_id,state,source_row_number,source_payload FROM bb.sheet_sync_records")) {
            paused = true;
            snapshotRead();
            await gate;
          }
          return result;
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sync = runSheetsLiveSync({ mode: "apply", trigger: "manual", pool: racingPool, now: NOW, readSource: async () => sheet([event(sourceId, date, "14:00", "Синтетическая exclusive комната", "handover-race")]) });
    await snapshotReady;
    await withTx(db.pool, (tx) => handoverSheetRecord(tx, manager.id, mapped.rows[0].reservation_id));
    continueSync();
    const result = await sync;
    assert.equal(result.counts.unchanged, 1);
    const state = await db.pool.query<{ state: string; reservation_id: string }>("SELECT state,reservation_id FROM bb.sheet_sync_records WHERE source_key=$1", [mapped.rows[0].source_key]);
    assert.equal(state.rows[0].state, "crm_managed");
    assert.equal(state.rows[0].reservation_id, mapped.rows[0].reservation_id);
    const active = await db.pool.query<{ id: string; starts_at: Date; released_at: Date | null }>("SELECT id,starts_at,released_at FROM bb.slot_reservations WHERE slot_date=$1 AND room_id='sync-test-exclusive' AND released_at IS NULL", [date]);
    assert.equal(active.rowCount, 1);
    assert.equal(active.rows[0].id, mapped.rows[0].reservation_id);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(active.rows[0].starts_at), "13:00");
  });

  it("authenticates private Apps Script snapshots, rejects replay/tampering, and deduplicates dry-run and apply", async () => {
    process.env.SHEETS_WEBHOOK_ENABLED = "1";
    process.env.SHEETS_WEBHOOK_HMAC_KEY = HMAC;
    process.env.SHEETS_SYNC_ENABLED = "0";
    const oldVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    await assert.rejects(() => processSignedSheetsWebhook({ ...signedRequest({}), pool: db.pool, now: NOW }), (error) => error instanceof SheetsWebhookError && error.status === 404);
    if (oldVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = oldVercel;
    await assert.rejects(() => readBoundedRequestBody(new Request("https://example.invalid/", { method: "POST", body: "{}" })), (error) => error instanceof SheetsWebhookError && error.status === 400);
    const source = event("event-webhook-dry-run", "2099-04-18", "10:00", "Синтетическая exclusive комната", "webhook-dry");
    const payload = {
      requestId: randomUUID(), spreadsheetId: BOOKING_SHEETS_ID, sheetId: 77, sheetTitle: "Лист1",
      spreadsheetTimeZone: "Asia/Almaty", mode: "dry_run", blankRows: 0,
      rows: [{ rowNumber: 3, raw: source }],
    };
    await assert.rejects(() => processSignedSheetsWebhook({ ...signedRequest(payload, { signature: "0".repeat(64) }), pool: db.pool, now: NOW }), (error) => error instanceof SheetsWebhookError && error.status === 401);
    await assert.rejects(() => processSignedSheetsWebhook({ ...signedRequest(payload, { timestamp: String(Math.floor(NOW.getTime() / 1000) - 301) }), pool: db.pool, now: NOW }), (error) => error instanceof SheetsWebhookError && error.status === 401);

    const request = signedRequest(payload);
    const dry = await processSignedSheetsWebhook({ ...request, pool: db.pool, now: NOW });
    assert.equal(dry.ok, true);
    if (!dry.ok) throw new Error("expected_dry_run_result");
    assert.equal(dry.result.mode, "dry_run");
    assert.equal(dry.result.counts.created, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND slot_date='2099-04-18' AND released_at IS NULL")).rows[0].n, 0);
    const replay = await processSignedSheetsWebhook({ ...request, pool: db.pool, now: NOW });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replay, true);
    const requestRow = await db.pool.query<{ status: string; result: object; body_hash: string }>("SELECT status,result,body_hash FROM bb.sheet_sync_webhook_requests WHERE request_id=$1", [payload.requestId]);
    assert.equal(requestRow.rows[0].status, "completed");
    assert.ok(!JSON.stringify(requestRow.rows[0]).includes("QA клиент"), "persistent webhook audit stores no source PII");

    const modified = { ...payload, rows: [{ rowNumber: 3, raw: { ...source, time: "11:00" } }] };
    await assert.rejects(() => processSignedSheetsWebhook({ ...signedRequest(modified, { nonce: randomUUID() }), pool: db.pool, now: NOW }), (error) => error instanceof SheetsWebhookError && error.status === 409);
    const replayedNoncePayload = { ...payload, requestId: randomUUID() };
    await assert.rejects(() => processSignedSheetsWebhook({ ...signedRequest(replayedNoncePayload, { nonce: request.nonce }), pool: db.pool, now: NOW }), (error) => error instanceof SheetsWebhookError && error.status === 409);

    process.env.SHEETS_SYNC_ENABLED = "1";
    const applyPayload = { ...payload, requestId: randomUUID(), mode: "apply", rows: [{ rowNumber: 4, raw: event("event-webhook-apply", "2099-04-18", "14:00", "Синтетическая exclusive комната", "webhook-apply") }] };
    const applyRequest = signedRequest(applyPayload);
    const applied = await processSignedSheetsWebhook({ ...applyRequest, pool: db.pool, now: NOW });
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.result.counts.created, 1);
    const retried = await processSignedSheetsWebhook({ ...applyRequest, pool: db.pool, now: NOW });
    assert.equal(retried.ok, true);
    if (retried.ok) assert.equal(retried.replay, true);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.slot_reservations WHERE room_id='sync-test-exclusive' AND slot_date='2099-04-18' AND released_at IS NULL")).rows[0].n, 1);
    delete process.env.SHEETS_WEBHOOK_ENABLED;
    delete process.env.SHEETS_WEBHOOK_HMAC_KEY;
  });
});
