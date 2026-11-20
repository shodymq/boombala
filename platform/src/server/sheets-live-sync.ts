import "server-only";

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { almatyToday } from "../core/dates.ts";
import { normalizeRow } from "../core/sheets-import/normalize.ts";
import { reviewSourceIdentity, stableSourceIdentity, sheetPayload, sheetRowFingerprint } from "../core/sheets-import/identity.ts";
import { BOOKING_SHEETS_ID } from "../core/sheets-import/production-block-import.ts";
import { googleSheetsClient, readSheet, type SheetRead } from "../core/sheets-import/reader.ts";
import type { RawRow } from "../core/sheets-import/types.ts";
import type { BookingTimeline } from "./fastapi-crm.ts";
import { bridgeBlockFromSheetSync, bridgeRescheduleFromSheetSync } from "./legacy-bridge.ts";
import { getPool } from "./db.ts";
import type { Actor, Role } from "../core/rbac.ts";
import type { Pool } from "../core/db.ts";

const TAB = "Лист1";
const DURATION_MS = 240 * 60_000;
const LOCK_NAME = "boombala-google-sheets-live-sync";
const SERVICE_ACTOR_EMAIL = "sheets-sync@system.invalid";

export type SheetSyncCounts = {
  scanned: number; created: number; updated: number; unchanged: number; conflicts: number;
  errors: number; manualReview: number; sourceMissing: number; historical: number; verified: number;
};
export type SheetSyncResult = {
  runId: number | null;
  mode: "dry_run" | "apply" | "disabled";
  counts: SheetSyncCounts;
  lastUpdated: string | null;
};
export type SheetSyncReviewItem = { rowNumber: number; sourceKey: string | null; status: ItemStatus; safeCode: string | null; reservationId: string | null };

type Room = { id: string; name: string; occupancyMode: "exclusive" | "shared" };
type EventRow = {
  rowNumber: number; raw: RawRow; sourceKey: string; identityKind: "explicit" | "natural";
  legacyIdentityKey: string | null; legacyPrefix: string; fingerprint: string; date: string; time: string; roomId: string;
  roomMode: "exclusive" | "shared"; payload: RawRow;
};
type Reservation = { id: string; roomId: string; startsAt: string; endsAt: string; occupiedEndsAt: string; note: string | null; status: string };
type StoredRecord = {
  source_key: string; fingerprint: string; legacy_key_prefix: string | null; reservation_id: string | null;
  state: "active" | "manual_review" | "source_missing" | "crm_managed"; source_row_number: number | null; source_payload: RawRow;
};
type ItemStatus = "created" | "updated" | "unchanged" | "conflict" | "error" | "manual_review" | "source_missing" | "historical";
type Item = { rowNumber: number; sourceKey?: string; status: ItemStatus; safeCode?: string; reservationId?: string | null; event?: EventRow; raw?: RawRow };

const emptyCounts = (): SheetSyncCounts => ({ scanned: 0, created: 0, updated: 0, unchanged: 0, conflicts: 0, errors: 0, manualReview: 0, sourceMissing: 0, historical: 0, verified: 0 });

function safeCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,60}$/.test(error.message)) return error.message;
  if (error && typeof error === "object") {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    if (code === "23P01" || code === "slot_reservations_active_occupancy_interval_excl") return "room_interval_conflict";
    if (/^[a-z0-9_]{1,60}$/.test(code)) return code;
  }
  return "sync_failed";
}

function sourceKeyFromMarker(note: string | null): string | null {
  const m = /(?:^|\s)(?:sync|src)=([0-9a-f]{64})(?:\s|$)/.exec(note ?? "");
  return m?.[1] ?? null;
}

function isoStart(date: string, time: string): number {
  // Kazakhstan venue wall time is UTC+05:00; this preserves the source HH:MM exactly.
  return Date.parse(`${date}T${time}:00+05:00`);
}

function almatyDateTime(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

function hasOverlap(start: number, end: number, reservation: Reservation): boolean {
  const otherStart = Date.parse(reservation.startsAt);
  const otherEnd = Date.parse(reservation.occupiedEndsAt || reservation.endsAt);
  return reservation.status !== "released" && Number.isFinite(otherStart) && Number.isFinite(otherEnd) && start < otherEnd && otherStart < end;
}

function serviceAccountKey(): { client_email: string; private_key: string } {
  const filename = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim() ?? "";
  if (!isAbsolute(filename)) throw new Error("google_key_file_not_configured");
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.geteuid === "function" && stat.uid !== process.geteuid())) {
    throw new Error("google_key_file_permissions");
  }
  const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object" || !("client_email" in value) || !("private_key" in value) ||
      typeof value.client_email !== "string" || typeof value.private_key !== "string") throw new Error("google_key_file_invalid");
  return { client_email: value.client_email, private_key: value.private_key };
}

async function readCatalog(pool: Pool): Promise<{ rooms: Room[]; packages: Array<{ id: string; name: string }> }> {
  const [rooms, packages] = await Promise.all([
    pool.query<{ id: string; name: string; occupancy_mode: string }>("SELECT id,name,occupancy_mode FROM bb.rooms WHERE is_active ORDER BY sort_order,id"),
    pool.query<{ id: string; name: string }>("SELECT id,name FROM bb.packages WHERE is_active ORDER BY sort_order,id"),
  ]);
  return {
    rooms: rooms.rows.map((r) => ({ id: r.id, name: r.name, occupancyMode: r.occupancy_mode === "shared" ? "shared" : "exclusive" })),
    packages: packages.rows,
  };
}

async function loadTimeline(pool: Pool, date: string): Promise<BookingTimeline> {
  const [roomRows, rows] = await Promise.all([
    pool.query<{ id: string; name: string; occupancy_mode: string }>("SELECT id,name,occupancy_mode FROM bb.rooms WHERE is_active ORDER BY sort_order,id"),
    pool.query<{ id: string; kind: "booking" | "block"; room_id: string; starts_at: Date; ends_at: Date; note: string | null; released_at: Date | null }>(
      "SELECT id,kind,room_id,starts_at,ends_at,note,released_at FROM bb.slot_reservations WHERE slot_date=$1 ORDER BY starts_at", [date]),
  ]);
  return {
    branchId: "almaty", date, timezone: "Asia/Almaty", bufferMinutes: 0,
    rooms: roomRows.rows.map((r) => ({ id: r.id, name: r.name, occupancyMode: r.occupancy_mode === "shared" ? "shared" : "exclusive" })),
    reservations: rows.rows.map((r) => ({ id: r.id, kind: r.kind, status: r.released_at ? "released" : r.kind === "block" ? "blocked" : "confirmed", roomId: r.room_id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), occupiedEndsAt: new Date(r.ends_at).toISOString(), slotId: null, packageName: null, priceKzt: null, priceSource: null, paidKzt: 0, paymentStatus: "unpaid", note: r.note, requestId: null, customerName: null, customerPhone: null, createdByAdminId: null, createdByName: null, releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null })),
  };
}

async function loadReservation(pool: Pool, id: string): Promise<Reservation | undefined> {
  const { rows } = await pool.query<{ id: string; room_id: string; starts_at: Date; ends_at: Date; note: string | null; released_at: Date | null }>(
    "SELECT id,room_id,starts_at,ends_at,note,released_at FROM bb.slot_reservations WHERE id=$1", [id]);
  const r = rows[0];
  return r ? { id: r.id, roomId: r.room_id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), occupiedEndsAt: new Date(r.ends_at).toISOString(), note: r.note, status: r.released_at ? "released" : "blocked" } : undefined;
}

async function loadLegacySheetBlocks(pool: Pool, hmacKey: string): Promise<Map<string, Reservation[]>> {
  const { rows } = await pool.query<{ id: string; room_id: string; starts_at: Date; ends_at: Date; note: string | null; released_at: Date | null }>(
    "SELECT id,room_id,starts_at,ends_at,note,released_at FROM bb.slot_reservations WHERE kind='block' AND note LIKE '%Google Sheets «Банкеты»%' ORDER BY created_at");
  const result = new Map<string, Reservation[]>();
  for (const row of rows) {
    const json = /A:N=(\[[^\n]*?\]);\s*предоплата не подтверждена/.exec(row.note ?? "")?.[1];
    if (!json) continue;
    let cells: unknown;
    try { cells = JSON.parse(json); } catch { continue; }
    if (!Array.isArray(cells) || cells.length < 14 || cells.some((v) => typeof v !== "string")) continue;
    const raw: RawRow = { date: cells[1], time: cells[2], package: cells[3], animator: cells[4], room: cells[5], client: cells[6], phone: cells[7], child: cells[8], age: cells[9], prepayment: cells[10], children: cells[12], adults: cells[13] };
    const identity = stableSourceIdentity(raw, hmacKey);
    if (!identity.sourceKey) continue;
    const reservations = result.get(identity.sourceKey) ?? [];
    reservations.push({ id: row.id, roomId: row.room_id, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), occupiedEndsAt: new Date(row.ends_at).toISOString(), note: row.note, status: row.released_at ? "released" : "blocked" });
    result.set(identity.sourceKey, reservations);
  }
  return result;
}

function eventsFromSheet(sheet: Awaited<ReturnType<typeof readSheet>>, rooms: Room[], packages: Array<{ id: string; name: string }>, hmacKey: string): { events: EventRow[]; unresolved: Item[]; scanned: number } {
  // `readSheet` has already mapped the header and canonical fields. Row numbers remain informational only.
  const events: EventRow[] = [];
  const unresolved: Item[] = [];
  const occurrences = new Map<string, number>();
  const interim = sheet.rows.map(({ raw, source }) => {
    const identity = stableSourceIdentity(raw, hmacKey);
    const sourceKey = identity.sourceKey ?? reviewSourceIdentity(raw, hmacKey);
    occurrences.set(sourceKey, (occurrences.get(sourceKey) ?? 0) + 1);
    return { raw, source, identity, sourceKey };
  });
  const catalog = { rooms, packages };
  for (const { raw, source, identity, sourceKey } of interim) {
    if (!identity.sourceKey) {
      unresolved.push({ rowNumber: source.rowNumber, sourceKey, status: "manual_review", safeCode: "reason" in identity ? identity.reason : "stable_id_missing", raw });
      continue;
    }
    if ((occurrences.get(sourceKey) ?? 0) > 1) {
      unresolved.push({ rowNumber: source.rowNumber, sourceKey, status: "manual_review", safeCode: "duplicate_source_identity", raw });
      continue;
    }
    const normalized = normalizeRow(raw, source, catalog);
    if (!normalized.date || !normalized.time || !normalized.roomId) {
      unresolved.push({ rowNumber: source.rowNumber, sourceKey: identity.sourceKey, status: "manual_review", safeCode: "date_time_or_room_unresolved", raw });
      continue;
    }
    const startMinutes = Number(normalized.time.slice(0, 2)) * 60 + Number(normalized.time.slice(3, 5));
    if (startMinutes < 600 || startMinutes + 240 > 1320) {
      unresolved.push({ rowNumber: source.rowNumber, sourceKey: identity.sourceKey, status: "manual_review", safeCode: "outside_working_hours", raw });
      continue;
    }
    const room = rooms.find((r) => r.id === normalized.roomId);
    if (!room) {
      unresolved.push({ rowNumber: source.rowNumber, sourceKey: identity.sourceKey, status: "manual_review", safeCode: "room_unresolved", raw });
      continue;
    }
    events.push({
      rowNumber: source.rowNumber, raw, sourceKey: identity.sourceKey, identityKind: identity.kind,
      legacyIdentityKey: stableSourceIdentity({ ...raw, sourceId: "" }, hmacKey).sourceKey,
      legacyPrefix: normalized.sourceKey.slice(0, 20), fingerprint: sheetRowFingerprint(raw, hmacKey),
      date: normalized.date, time: normalized.time, roomId: normalized.roomId, roomMode: room.occupancyMode,
      payload: sheetPayload(raw),
    });
  }
  return { events, unresolved, scanned: sheet.rows.length };
}

function countItems(counts: SheetSyncCounts, items: Item[]): void {
  for (const item of items) counts[item.status === "manual_review" ? "manualReview" : item.status === "source_missing" ? "sourceMissing" : item.status === "conflict" ? "conflicts" : item.status === "error" ? "errors" : item.status]++;
}

async function upsertRecord(pool: Pool, event: EventRow, reservationId: string | null, state: StoredRecord["state"], reviewCode: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO bb.sheet_sync_records (source_key,fingerprint,legacy_key_prefix,reservation_id,state,safe_review_code,source_row_number,source_payload,last_seen_at,missing_since,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now(),NULL,now())
     ON CONFLICT (source_key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,legacy_key_prefix=EXCLUDED.legacy_key_prefix,
       reservation_id=COALESCE(EXCLUDED.reservation_id,bb.sheet_sync_records.reservation_id),state=EXCLUDED.state,
       safe_review_code=EXCLUDED.safe_review_code,source_row_number=EXCLUDED.source_row_number,source_payload=EXCLUDED.source_payload,
       last_seen_at=now(),missing_since=NULL,updated_at=now()`,
    [event.sourceKey, event.fingerprint, event.legacyPrefix, reservationId, state, reviewCode, event.rowNumber, JSON.stringify(event.payload)],
  );
}

async function upsertManualReview(pool: Pool, item: Item): Promise<void> {
  if (!item.sourceKey || !item.raw) return;
  await pool.query(
    `INSERT INTO bb.sheet_sync_records (source_key,fingerprint,state,safe_review_code,source_row_number,source_payload,last_seen_at,updated_at)
     VALUES ($1,$2,'manual_review',$3,$4,$5::jsonb,now(),now())
     ON CONFLICT (source_key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,state='manual_review',safe_review_code=EXCLUDED.safe_review_code,
       source_row_number=EXCLUDED.source_row_number,source_payload=EXCLUDED.source_payload,last_seen_at=now(),missing_since=NULL,updated_at=now()`,
    [item.sourceKey, sheetRowFingerprint(item.raw, process.env.SHEETS_SYNC_HMAC_KEY ?? ""), item.safeCode ?? "manual_review", item.rowNumber, JSON.stringify(sheetPayload(item.raw))],
  );
}

async function persistReview(pool: Pool, event: EventRow, reservationId: string | null, code: string): Promise<void> {
  await upsertRecord(pool, event, reservationId, "manual_review", code);
}

function marker(sourceKey: string): string { return `Google Sheets sync=${sourceKey}`; }
function operationKey(sourceKey: string, fingerprint: string, action: string, currentReservationId?: string): string {
  return `sheets-sync-v1:${action}:${sourceKey}:${fingerprint.slice(0, 24)}${currentReservationId ? `:${currentReservationId}` : ""}`;
}

async function saveRun(pool: Pool, id: number, outcome: "completed" | "failed", counts: SheetSyncCounts, code?: string, items: Item[] = []): Promise<void> {
  const reviewItems: SheetSyncReviewItem[] = items.map((item) => ({
    rowNumber: item.rowNumber, sourceKey: item.sourceKey ? item.sourceKey.slice(0, 12) : null,
    status: item.status, safeCode: item.safeCode ?? null, reservationId: item.reservationId ?? null,
  }));
  await pool.query("UPDATE bb.sheet_sync_runs SET outcome=$2,finished_at=now(),counts=$3::jsonb,review_items=$4::jsonb,safe_error_code=$5 WHERE id=$1", [id, outcome, JSON.stringify(counts), JSON.stringify(reviewItems), code ?? null]);
}

export async function getLatestSheetSyncStatus(pool: Pool = getPool()): Promise<{ lastUpdated: string | null; counts: SheetSyncCounts | null; reviewItems: SheetSyncReviewItem[]; outcome: string | null; safeErrorCode: string | null; enabled: boolean; manualReview: number; sourceMissing: number }>{
  try {
    const [run, records] = await Promise.all([
      pool.query<{ finished_at: Date | null; outcome: string; counts: SheetSyncCounts; review_items: SheetSyncReviewItem[]; safe_error_code: string | null }>("SELECT finished_at,outcome,counts,review_items,safe_error_code FROM bb.sheet_sync_runs ORDER BY id DESC LIMIT 1"),
      pool.query<{ manual_review: number; source_missing: number }>("SELECT count(*) FILTER (WHERE state='manual_review')::int manual_review,count(*) FILTER (WHERE state='source_missing')::int source_missing FROM bb.sheet_sync_records"),
    ]);
    return { lastUpdated: run.rows[0]?.finished_at?.toISOString() ?? null, counts: run.rows[0]?.counts ?? null, reviewItems: run.rows[0]?.review_items ?? [], outcome: run.rows[0]?.outcome ?? null, safeErrorCode: run.rows[0]?.safe_error_code ?? null, enabled: process.env.SHEETS_SYNC_ENABLED === "1", manualReview: records.rows[0]?.manual_review ?? 0, sourceMissing: records.rows[0]?.source_missing ?? 0 };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") return { lastUpdated: null, counts: null, reviewItems: [], outcome: "migration_required", safeErrorCode: "migration_required", enabled: false, manualReview: 0, sourceMissing: 0 };
    throw error;
  }
}

/** One serialized read/plan/apply pass. Dry-run records only safe run metadata; booking rows are never touched. */
export async function runSheetsLiveSync(options: { mode?: "auto" | "dry_run" | "apply"; trigger?: "timer" | "manual" | "dry_run"; pool?: Pool; now?: Date; readSource?: () => Promise<SheetRead> } = {}): Promise<SheetSyncResult> {
  const pool = options.pool ?? getPool();
  const enabled = process.env.SHEETS_SYNC_ENABLED === "1";
  const requestedMode = options.mode ?? "auto";
  const apply = requestedMode === "apply" || (requestedMode === "auto" && enabled);
  if (apply && !enabled) throw new Error("sheets_sync_disabled");
  const mode = apply ? "apply" : requestedMode === "auto" && !enabled && options.trigger === "timer" ? "disabled" : "dry_run";
  const counts = emptyCounts();
  const lock = await pool.connect();
  let runId: number | null = null;
  let locked = false;
  try {
    const got = await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked", [LOCK_NAME]);
    locked = got.rows[0]?.locked === true;
    if (!locked) return { runId: null, mode, counts, lastUpdated: null };
    const hmacKey = process.env.SHEETS_SYNC_HMAC_KEY ?? "";
    const identityKeyFingerprint = mode !== "disabled" && Buffer.byteLength(hmacKey, "utf8") >= 32
      ? createHash("sha256").update(hmacKey).digest("hex") : null;
    const createdRun = await lock.query<{ id: number }>("INSERT INTO bb.sheet_sync_runs (trigger_kind,outcome,identity_key_fingerprint) VALUES ($1,'running',$2) RETURNING id", [options.trigger ?? (mode === "dry_run" ? "dry_run" : "timer"), identityKeyFingerprint]);
    runId = Number(createdRun.rows[0].id);
    if (mode === "disabled") {
      await saveRun(pool, runId, "completed", counts);
      return { runId, mode, counts, lastUpdated: new Date().toISOString() };
    }
    if (Buffer.byteLength(hmacKey, "utf8") < 32) throw new Error("sheets_sync_key_invalid");
    const previousKey = await lock.query<{ fingerprint: string }>("SELECT identity_key_fingerprint fingerprint FROM bb.sheet_sync_runs WHERE outcome='completed' AND identity_key_fingerprint IS NOT NULL ORDER BY id LIMIT 1");
    if (previousKey.rows[0] && previousKey.rows[0].fingerprint !== identityKeyFingerprint) throw new Error("sheets_sync_key_changed");
    const worker = apply ? await syncActor(pool) : null;
    const sheet = options.readSource
      ? await options.readSource()
      : await readSheet(googleSheetsClient(serviceAccountKey()), BOOKING_SHEETS_ID, { sheetTitle: TAB });
    if (sheet.spreadsheetId !== BOOKING_SHEETS_ID || sheet.sheetTitle !== TAB) throw new Error("sheet_identity_mismatch");
    const catalog = await readCatalog(pool);
    const { events, unresolved, scanned } = eventsFromSheet(sheet, catalog.rooms, catalog.packages, hmacKey);
    counts.scanned = scanned;
    const allRecords = await pool.query<StoredRecord>("SELECT source_key,fingerprint,legacy_key_prefix,reservation_id,state,source_row_number,source_payload FROM bb.sheet_sync_records");
    const stored = new Map(allRecords.rows.map((record) => [record.source_key, record]));
    const legacyBlocks = await loadLegacySheetBlocks(pool, hmacKey);
    const items: Item[] = [...unresolved];
    const seen = new Set<string>(unresolved.flatMap((item) => item.sourceKey ? [item.sourceKey] : []));
    const byDate = new Map<string, BookingTimeline>();
    const dates = [...new Set(events.map((event) => event.date))];
    for (const date of dates) byDate.set(date, await loadTimeline(pool, date));

    const today = almatyToday(options.now ?? new Date());
    const eligible: EventRow[] = [];
    const dryRunMoves: Array<{ event: EventRow; reservationId: string; item: Item }> = [];
    const written: Array<{ event: EventRow; id: string }> = [];
    for (const event of events) {
      seen.add(event.sourceKey);
      if (event.date < today) { items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: "historical" }); continue; }
      const timeline = byDate.get(event.date)!;
      const prior = stored.get(event.sourceKey);
      // A record handed over to the CRM is managed there from now on: the sheet row is ignored, never moved or released by sync.
      if (prior?.state === "crm_managed") { items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: prior.reservation_id ?? undefined, status: "unchanged" }); continue; }
      const existingMapped = prior?.reservation_id ? await loadReservation(pool, prior.reservation_id) : undefined;
      const legacyCandidates = [...new Map([...new Set([event.legacyIdentityKey, event.sourceKey].filter((key): key is string => !!key))]
        .flatMap((key) => legacyBlocks.get(key) ?? []).filter((item) => item.status !== "released").map((item) => [item.id, item])).values()];
      const legacyExact = legacyCandidates.filter((item) => {
        const local = almatyDateTime(item.startsAt);
        return local.date === event.date && local.time === event.time && item.roomId === event.roomId;
      });
      const legacyMatch = legacyExact.length === 1 ? legacyExact[0] : legacyCandidates.length === 1 ? legacyCandidates[0] : undefined;
      const sourceExisting = timeline.reservations.find((item) => item.status !== "released" && (sourceKeyFromMarker(item.note) === event.sourceKey || item.note?.includes(`src=${event.legacyPrefix}`)));
      if (!sourceExisting && !existingMapped && legacyCandidates.length > 1 && legacyExact.length !== 1) {
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: "manual_review", safeCode: "legacy_source_match_ambiguous" });
        if (apply) await upsertRecord(pool, event, null, "manual_review", "legacy_source_match_ambiguous");
        continue;
      }
      const existing = sourceExisting ?? legacyMatch ?? existingMapped;
      if (existing) {
        const active = existing.status !== "released";
        if (!active) { items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: existing.id, status: "manual_review", safeCode: "source_reservation_released" }); if (apply) await upsertRecord(pool, event, existing.id, "manual_review", "source_reservation_released"); continue; }
        const local = almatyDateTime(existing.startsAt);
        const sameInterval = local.date === event.date && local.time === event.time && existing.roomId === event.roomId;
        if (sameInterval && prior?.fingerprint === event.fingerprint && prior.state === "active") {
          items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: existing.id, status: "unchanged" });
          if (apply) await upsertRecord(pool, event, existing.id, "active", null);
          continue;
        }
        if (!sameInterval) {
          if (!apply) {
            const item: Item = { rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: existing.id, status: "updated" };
            items.push(item);
            dryRunMoves.push({ event, reservationId: existing.id, item });
            continue;
          }
          try {
            const response = await bridgeRescheduleFromSheetSync(pool, worker!, {
              reservationId: existing.id, bookingDate: event.date, startTime: event.time, roomId: event.roomId,
              note: marker(event.sourceKey), idempotencyKey: operationKey(event.sourceKey, event.fingerprint, "move", existing.id),
            }, { sourceKey: event.sourceKey, fingerprint: event.fingerprint, legacyKeyPrefix: event.legacyPrefix, sourceRowNumber: event.rowNumber, sourcePayload: event.payload });
            const nextId = response && typeof response === "object" && "id" in response && typeof response.id === "string" ? response.id : null;
            if (!nextId) throw new Error("writer_missing_reservation_id");
            await upsertRecord(pool, event, nextId, "active", null);
            written.push({ event, id: nextId });
            items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: nextId, status: "updated" });
          } catch (error) {
            const code = safeCode(error);
            await persistReview(pool, event, existing.id, code);
            items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: existing.id, status: code === "room_interval_conflict" ? "conflict" : "error", safeCode: code });
          }
          continue;
        }
        if (apply) await upsertRecord(pool, event, existing.id, "active", null);
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: existing.id, status: prior?.fingerprint === event.fingerprint ? "unchanged" : "updated" });
        continue;
      }
      if (prior?.state === "active" && prior.reservation_id) {
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: prior.reservation_id, status: "manual_review", safeCode: "mapped_reservation_not_found" });
        if (apply) await upsertRecord(pool, event, prior.reservation_id, "manual_review", "mapped_reservation_not_found");
        continue;
      }
      // Read-only Sheets has no immutable row ID. Party-derived identity is sufficient only to adopt a unique
      // one-shot legacy block; new events require a manager-maintained fixed ID so edits cannot create duplicates.
      if (event.identityKind !== "explicit") {
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: "manual_review", safeCode: "explicit_source_id_required" });
        if (apply) await persistReview(pool, event, null, "explicit_source_id_required");
        continue;
      }
      eligible.push(event);
    }

    // A dry-run must simulate the final schedule, including existing reservations that are moving. Otherwise it
    // reports an unsafe move as "updated" and can miss move-vs-move or move-vs-create collisions.
    const dryRunMovingIds = new Set(dryRunMoves.map((move) => move.reservationId));
    const dryRunConflicts = new Map<string, { code: "room_interval_occupied" | "source_interval_overlap"; reservationId?: string }>();
    if (!apply) {
      const candidates = [
        ...dryRunMoves.map((move) => ({ event: move.event, item: move.item })),
        ...eligible.map((event) => ({ event, item: undefined })),
      ];
      for (const candidate of candidates) {
        const { event } = candidate;
        if (event.roomMode === "shared") continue;
        const start = isoStart(event.date, event.time);
        const blocking = byDate.get(event.date)!.reservations.find((reservation) =>
          reservation.roomId === event.roomId && !dryRunMovingIds.has(reservation.id) && hasOverlap(start, start + DURATION_MS, reservation),
        );
        if (blocking) dryRunConflicts.set(event.sourceKey, { code: "room_interval_occupied", reservationId: blocking.id });
      }
      for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i].event, b = candidates[j].event;
        if (a.sourceKey === b.sourceKey || a.roomMode === "shared" || b.roomMode === "shared" || a.date !== b.date || a.roomId !== b.roomId) continue;
        const aStart = isoStart(a.date, a.time), bStart = isoStart(b.date, b.time);
        if (aStart < bStart + DURATION_MS && bStart < aStart + DURATION_MS) {
          dryRunConflicts.set(a.sourceKey, { code: "source_interval_overlap" });
          dryRunConflicts.set(b.sourceKey, { code: "source_interval_overlap" });
        }
      }
      for (const move of dryRunMoves) {
        const conflict = dryRunConflicts.get(move.event.sourceKey);
        if (conflict) {
          move.item.status = "conflict";
          move.item.safeCode = conflict.code;
          if (conflict.reservationId) move.item.reservationId = conflict.reservationId;
        }
      }
    }

    // Refuse every overlapping exclusive source pair as a set; shared zones intentionally permit concurrent events.
    const conflicted = new Set<string>();
    for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i], b = eligible[j];
      if (a.roomMode === "shared" || b.roomMode === "shared" || a.date !== b.date || a.roomId !== b.roomId) continue;
      const aStart = isoStart(a.date, a.time), bStart = isoStart(b.date, b.time);
      if (aStart < bStart + DURATION_MS && bStart < aStart + DURATION_MS) { conflicted.add(a.sourceKey); conflicted.add(b.sourceKey); }
    }
    for (const event of eligible) {
      const plannedConflict = dryRunConflicts.get(event.sourceKey);
      if (plannedConflict) {
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: plannedConflict.reservationId ?? null, status: "conflict", safeCode: plannedConflict.code });
        continue;
      }
      if (conflicted.has(event.sourceKey)) {
        if (apply) await persistReview(pool, event, null, "source_interval_overlap");
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: "conflict", safeCode: "source_interval_overlap" }); continue;
      }
      const timeline = byDate.get(event.date)!;
      const start = isoStart(event.date, event.time);
      if (event.roomMode !== "shared" && timeline.reservations.some((r) => r.roomId === event.roomId && !dryRunMovingIds.has(r.id) && hasOverlap(start, start + DURATION_MS, r))) {
        const blocking = timeline.reservations.find((r) => r.roomId === event.roomId && !dryRunMovingIds.has(r.id) && hasOverlap(start, start + DURATION_MS, r));
        if (apply) await persistReview(pool, event, null, "room_interval_occupied");
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: blocking?.id ?? null, status: "conflict", safeCode: "room_interval_occupied" }); continue;
      }
      if (!apply) { items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: "created" }); continue; }
      try {
        const result = await bridgeBlockFromSheetSync(pool, worker!, {
          bookingDate: event.date, startTime: event.time, roomId: event.roomId,
          reason: marker(event.sourceKey), idempotencyKey: operationKey(event.sourceKey, event.fingerprint, "create"),
        }, { sourceKey: event.sourceKey, fingerprint: event.fingerprint, legacyKeyPrefix: event.legacyPrefix, sourceRowNumber: event.rowNumber, sourcePayload: event.payload });
        const id = result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id : null;
        if (!id) throw new Error("writer_missing_reservation_id");
        await upsertRecord(pool, event, id, "active", null);
        written.push({ event, id });
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, reservationId: id, status: "created" });
      } catch (error) {
        const code = safeCode(error);
        await persistReview(pool, event, null, code);
        items.push({ rowNumber: event.rowNumber, sourceKey: event.sourceKey, status: code === "room_interval_conflict" ? "conflict" : "error", safeCode: code });
      }
    }

    if (apply) {
      for (const item of unresolved) await upsertManualReview(pool, item);
      const absent = allRecords.rows.filter((record) => record.state !== "source_missing" && record.state !== "crm_managed" && !seen.has(record.source_key));
      for (const record of absent) {
        await pool.query("UPDATE bb.sheet_sync_records SET state='source_missing',safe_review_code='source_row_missing',missing_since=COALESCE(missing_since,now()),updated_at=now() WHERE source_key=$1", [record.source_key]);
        items.push({ rowNumber: record.source_row_number ?? 0, sourceKey: record.source_key, reservationId: record.reservation_id, status: "source_missing", safeCode: "source_row_missing" });
      }
    } else {
      const absent = allRecords.rows.filter((record) => record.state !== "source_missing" && record.state !== "crm_managed" && !seen.has(record.source_key));
      for (const record of absent) items.push({ rowNumber: record.source_row_number ?? 0, sourceKey: record.source_key, reservationId: record.reservation_id, status: "source_missing", safeCode: "source_row_missing" });
    }

    countItems(counts, items);
    if (apply && written.length) {
      const verify = new Map<string, BookingTimeline>();
      for (const date of [...new Set(written.map(({ event }) => event.date))]) verify.set(date, await loadTimeline(pool, date));
      for (const { event, id } of written) {
        const found = verify.get(event.date)?.reservations.find((r) => r.id === id && r.status !== "released" && sourceKeyFromMarker(r.note) === event.sourceKey);
        const item = items.find((candidate) => candidate.sourceKey === event.sourceKey && (candidate.status === "created" || candidate.status === "updated"));
        if (found) counts.verified++;
        else if (item) { item.status = "error"; item.safeCode = "readback_verification_failed"; }
      }
      // Recompute after readback failures.
      const scanned = counts.scanned;
      for (const key of Object.keys(counts) as Array<keyof SheetSyncCounts>) counts[key] = 0;
      countItems(counts, items);
      counts.scanned = scanned;
      counts.verified = written.filter(({ event, id }) => verify.get(event.date)?.reservations.some((r) => r.id === id && r.status !== "released" && sourceKeyFromMarker(r.note) === event.sourceKey)).length;
    }
    await saveRun(pool, runId, "completed", counts, undefined, items);
    return { runId, mode, counts, lastUpdated: new Date().toISOString() };
  } catch (error) {
    counts.errors++;
    if (runId !== null) await saveRun(pool, runId, "failed", counts, safeCode(error));
    throw new Error(safeCode(error));
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [LOCK_NAME]).catch(() => undefined);
    lock.release();
  }
}

async function syncActor(pool: Pool): Promise<Actor> {
  const { rows } = await pool.query<{ id: string; role: Role }>("SELECT id,role FROM bb.users WHERE email=$1 AND is_active=false", [SERVICE_ACTOR_EMAIL]);
  const actor = rows[0];
  if (!actor || actor.role !== "manager") throw new Error("sheets_sync_actor_missing");
  return { id: actor.id, role: actor.role };
}
