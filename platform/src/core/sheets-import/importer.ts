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

/** Production may still be on the pre-015 schema (slot_date + slot_id -> time_slots) or already on post-015 (exact starts_at). */
export type SchemaVersion = "pre-015" | "post-015";

/**
 * Detected from pg_attribute, not information_schema: information_schema hides columns the role cannot read, and a
 * grant that forgot `starts_at` must show up as "missing privilege", not as "pre-015".
 */
export async function detectSchemaVersion(db: Queryable): Promise<SchemaVersion> {
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'bb.slot_reservations'::regclass AND attname = 'starts_at' AND NOT attisdropped) AS ok`);
  return r.rows[0]?.ok ? "post-015" : "pre-015";
}

/** Every column the importer reads, per schema version. The grant SQL (scripts/sql/sheets-ro-grant.sql) must match this. */
export const REQUIRED_COLUMNS: Record<SchemaVersion, Record<string, string[]>> = {
  "pre-015": {
    rooms: ["id", "name", "is_active", "sort_order"],
    packages: ["id", "name", "is_active", "sort_order"],
    lead_requests: ["id", "contact_id", "requested_date", "children", "package_id", "room_id", "status"],
    contacts: ["id", "phone_e164", "name_key"],
    slot_reservations: ["id", "kind", "room_id", "contact_id", "slot_date", "slot_id", "released_at", "children", "package_id"],
    time_slots: ["id", "starts_at"],
  },
  "post-015": {
    rooms: ["id", "name", "is_active", "sort_order"],
    packages: ["id", "name", "is_active", "sort_order"],
    lead_requests: ["id", "contact_id", "requested_date", "children", "package_id", "room_id", "status"],
    contacts: ["id", "phone_e164", "name_key"],
    slot_reservations: ["id", "kind", "room_id", "contact_id", "starts_at", "released_at", "children", "package_id"],
  },
};

export interface AccessReport {
  schema: SchemaVersion;
  /** table.column that does not exist or that the current role cannot SELECT. */
  missing: string[];
  /** Tables on which the current role could write (INSERT/UPDATE/DELETE/TRUNCATE). Must be empty. */
  writable: string[];
  superuser: boolean;
  /** Required tables where row-level security would hide rows from this role (it would read 0 rows silently). */
  rlsBlocked: string[];
  /** bb tables the role can read as a whole table (more than the column grants need). Names only. */
  overbroadRead: string[];
  ok: boolean;
}

/** Checks real PostgreSQL privileges of the connected role. Reports table and column NAMES only, never data. */
export async function checkReadAccess(db: Queryable): Promise<AccessReport> {
  const schema = await detectSchemaVersion(db);
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS[schema])) {
    for (const col of cols) {
      const r = await db.query<{ exists: boolean; can: boolean | null }>(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped) AS exists,
                CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_column_privilege(current_user, to_regclass($1), $2, 'SELECT') END AS can`,
        [`bb.${table}`, col]);
      if (!r.rows[0]?.exists || !r.rows[0]?.can) missing.push(`${table}.${col}`);
    }
  }
  const tables = await db.query<{ relname: string; w: boolean; s: boolean }>(
    `SELECT c.relname,
            (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE')
              OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE')) AS w,
            has_table_privilege(current_user, c.oid, 'SELECT') AS s
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'bb' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  const su = await db.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  const writable = tables.rows.filter((t) => t.w).map((t) => t.relname);
  const overbroadRead = tables.rows.filter((t) => t.s).map((t) => t.relname);
  const superuser = Boolean(su.rows[0]?.rolsuper);
  // RLS hides every row from a role that has no SELECT policy (unless it owns the table, is superuser or has BYPASSRLS).
  // row_security_active() is NOT usable here: it is true whenever policies apply, including the policy that lets us read.
  const rls = await db.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'bb' AND c.relname = ANY($1::text[]) AND c.relrowsecurity
        AND pg_get_userbyid(c.relowner) <> current_user
        AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls))
        AND NOT EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'bb' AND p.tablename = c.relname AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('SELECT', 'ALL')
                           AND (p.roles @> ARRAY[current_user::name] OR p.roles @> ARRAY['public'::name]))
      ORDER BY c.relname`, [Object.keys(REQUIRED_COLUMNS[schema])]);
  const rlsBlocked = rls.rows.map((r) => r.relname);
  return { schema, missing, writable, superuser, rlsBlocked, overbroadRead, ok: missing.length === 0 && writable.length === 0 && !superuser && rlsBlocked.length === 0 };
}

/** Read-only: no payment, token or credential column is selected. Works on both schema versions; times are saved verbatim. */
export async function loadCrmSnapshot(db: Queryable, version?: SchemaVersion): Promise<CrmSnapshot> {
  const v = version ?? (await detectSchemaVersion(db));
  const leads = await db.query<{ id: string; d: string; phone: string; name_key: string; children: number | null; package_id: string | null; room_id: string | null; status: string }>(
    `SELECT l.id, to_char(l.requested_date,'YYYY-MM-DD') AS d, c.phone_e164 AS phone, c.name_key, l.children, l.package_id, l.room_id, l.status
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id`);
  const reservationSql = v === "post-015"
    ? `SELECT r.id, to_char(r.starts_at AT TIME ZONE 'Asia/Almaty','YYYY-MM-DD') AS d, to_char(r.starts_at AT TIME ZONE 'Asia/Almaty','HH24:MI') AS t,
              r.room_id, c.phone_e164 AS phone, r.children, r.package_id
         FROM bb.slot_reservations r LEFT JOIN bb.contacts c ON c.id = r.contact_id
        WHERE r.released_at IS NULL AND r.kind = 'booking'`
    : `SELECT r.id, to_char(r.slot_date,'YYYY-MM-DD') AS d, to_char(ts.starts_at,'HH24:MI') AS t,
              r.room_id, c.phone_e164 AS phone, r.children, r.package_id
         FROM bb.slot_reservations r JOIN bb.time_slots ts ON ts.id = r.slot_id LEFT JOIN bb.contacts c ON c.id = r.contact_id
        WHERE r.released_at IS NULL AND r.kind = 'booking'`;
  const res = await db.query<{ id: string; d: string; t: string; room_id: string; phone: string | null; children: number | null; package_id: string | null }>(reservationSql);
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
