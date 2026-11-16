import type { Queryable } from "../db.ts";
import { nameKey } from "../phone.ts";
import type { Catalog, CrmSnapshot, NormalizedRow } from "./types.ts";

/**
 * Staging lives in its OWN schema (`sheet_import`) of a staging/scratch database. It is deliberately not a `bb` migration:
 * the production preflight compares migration files with applied ones, and this stage must not touch production.
 * It holds no booking, no payment and no FK into `bb`: the only way a row becomes a booking is the reviewed final import.
 */
export const STAGING_DDL = `
CREATE SCHEMA IF NOT EXISTS sheet_import;
CREATE TABLE IF NOT EXISTS sheet_import.rows (
  spreadsheet_id text NOT NULL,
  source_key     text NOT NULL,
  sheet_id       bigint NOT NULL,
  row_number     integer NOT NULL,
  fingerprint    text NOT NULL,
  booking_date   date,
  start_time     text,
  room_id        text,
  room_raw       text NOT NULL,
  package_id     text,
  package_raw    text NOT NULL,
  customer_name  text NOT NULL,
  phone_e164     text,
  child_name     text NOT NULL,
  child_age      smallint,
  children       smallint,
  adults         smallint,
  animator       text NOT NULL,
  prepayment_candidate_kzt integer,
  time_semantics text NOT NULL DEFAULT 'venue_wall_clock_asia_almaty',
  status         text NOT NULL CHECK (status IN ('CANDIDATE','NEEDS_REVIEW','ALREADY_IN_CRM','ARCHIVE_ONLY')),
  reasons        text[] NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  changed_at     timestamptz NOT NULL DEFAULT now(),
  missing_since  timestamptz,
  PRIMARY KEY (spreadsheet_id, source_key)
);`;

export async function ensureStaging(db: Queryable): Promise<void> {
  await db.query(STAGING_DDL);
}

export async function loadCatalog(db: Queryable): Promise<Catalog> {
  const [rooms, packages] = await Promise.all([
    db.query<{ id: string; name: string }>("SELECT id, name FROM bb.rooms WHERE is_active ORDER BY sort_order, id"),
    db.query<{ id: string; name: string }>("SELECT id, name FROM bb.packages WHERE is_active ORDER BY sort_order, id"),
  ]);
  return { rooms: rooms.rows, packages: packages.rows };
}

/** Read-only: no payment, token or credential column is selected. */
export async function loadCrmSnapshot(db: Queryable): Promise<CrmSnapshot> {
  const leads = await db.query<{ id: string; d: string; phone: string; name_key: string; children: number | null; package_id: string | null; room_id: string | null; status: string }>(
    `SELECT l.id, to_char(l.requested_date,'YYYY-MM-DD') AS d, c.phone_e164 AS phone, c.name_key, l.children, l.package_id, l.room_id, l.status
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id`);
  const res = await db.query<{ id: string; d: string; t: string; room_id: string; phone: string | null; children: number | null; package_id: string | null }>(
    `SELECT r.id, to_char(r.starts_at AT TIME ZONE 'Asia/Almaty','YYYY-MM-DD') AS d, to_char(r.starts_at AT TIME ZONE 'Asia/Almaty','HH24:MI') AS t,
            r.room_id, c.phone_e164 AS phone, r.children, r.package_id
       FROM bb.slot_reservations r LEFT JOIN bb.contacts c ON c.id = r.contact_id
      WHERE r.released_at IS NULL AND r.kind = 'booking'`);
  return {
    leads: leads.rows.map((l) => ({ id: l.id, date: l.d, phoneE164: l.phone, nameKey: l.name_key ?? nameKey(""), children: l.children, packageId: l.package_id, roomId: l.room_id, status: l.status })),
    reservations: res.rows.map((r) => ({ id: r.id, date: r.d, startTime: r.t, roomId: r.room_id, phoneE164: r.phone, children: r.children, packageId: r.package_id })),
  };
}

export interface StageResult { inserted: number; updated: number; unchanged: number; movedRows: number; disappeared: number }

/**
 * Idempotent upsert keyed by (spreadsheet, sourceKey). A second run with the same data changes nothing; a moved row only
 * updates row_number; an edited row updates its values; a row that vanished is marked missing, never deleted.
 */
export async function stageRows(db: Queryable, spreadsheetId: string, rows: NormalizedRow[]): Promise<StageResult> {
  const out: StageResult = { inserted: 0, updated: 0, unchanged: 0, movedRows: 0, disappeared: 0 };
  for (const r of rows) {
    const cur = (await db.query<{ fingerprint: string; row_number: number; status: string; reasons: string[] }>(
      "SELECT fingerprint, row_number, status, reasons FROM sheet_import.rows WHERE spreadsheet_id = $1 AND source_key = $2", [spreadsheetId, r.sourceKey])).rows[0];
    const values = [spreadsheetId, r.sourceKey, r.source.sheetId, r.source.rowNumber, r.fingerprint, r.date, r.time, r.roomId, r.roomRaw, r.packageId, r.packageRaw,
      r.customerName, r.phoneE164, r.childName, r.childAge, r.children, r.adults, r.animator, r.prepaymentCandidateKzt, r.status, r.reasons];
    if (!cur) {
      await db.query(
        `INSERT INTO sheet_import.rows (spreadsheet_id, source_key, sheet_id, row_number, fingerprint, booking_date, start_time, room_id, room_raw, package_id, package_raw,
           customer_name, phone_e164, child_name, child_age, children, adults, animator, prepayment_candidate_kzt, status, reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, values);
      out.inserted++;
    } else if (cur.fingerprint !== r.fingerprint || cur.status !== r.status || cur.reasons.join() !== r.reasons.join()) {
      await db.query(
        `UPDATE sheet_import.rows SET sheet_id=$3,row_number=$4,fingerprint=$5,booking_date=$6,start_time=$7,room_id=$8,room_raw=$9,package_id=$10,package_raw=$11,
           customer_name=$12,phone_e164=$13,child_name=$14,child_age=$15,children=$16,adults=$17,animator=$18,prepayment_candidate_kzt=$19,status=$20,reasons=$21,
           last_seen_at=now(), changed_at=now(), missing_since=NULL WHERE spreadsheet_id=$1 AND source_key=$2`, values);
      out.updated++;
    } else {
      if (cur.row_number !== r.source.rowNumber) out.movedRows++;
      await db.query("UPDATE sheet_import.rows SET row_number=$3, last_seen_at=now(), missing_since=NULL WHERE spreadsheet_id=$1 AND source_key=$2", [spreadsheetId, r.sourceKey, r.source.rowNumber]);
      out.unchanged++;
    }
  }
  const gone = await db.query(
    "UPDATE sheet_import.rows SET missing_since = now() WHERE spreadsheet_id = $1 AND source_key <> ALL($2::text[]) AND missing_since IS NULL", [spreadsheetId, rows.map((r) => r.sourceKey)]);
  out.disappeared = gone.rowCount ?? 0;
  return out;
}
