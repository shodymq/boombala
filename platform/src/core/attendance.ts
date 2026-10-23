import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";
import type { RequestMeta } from "./users.ts";

/**
 * Who actually came in. Rules (enforced by PostgreSQL, see migration 013):
 *  - a QR registration is a declaration, NOT a visit: only an attendance entry written by staff counts;
 *  - a registration can be confirmed once, however many people press the button and however often a request is repeated;
 *  - an entry stores a COUNT of children only; no child's name, ID number or birth date exists anywhere;
 *  - a confirmed count can be corrected, and every correction is logged by the database itself;
 *  - the calendar day of an entry is the day in Asia/Almaty.
 * This module checks permission and input, runs each action in one transaction and translates database answers.
 */

export const MAX_CHILDREN = 50;
/**
 * MVP rule: a QR entry is confirmed and a manual entry is written ONLY for today (Asia/Almaty), whoever asks and whatever the form says.
 * Past days can be read, and an existing entry can be corrected (audited), but nothing new is added to them.
 * `onDate` is the day the person's screen showed; `allowBackfill` exists for tests and a future, separately approved back-fill tool
 * and is never passed by the admin.
 */
function assertToday(onDate: string | undefined, at: Date | undefined, allowBackfill: boolean | undefined): void {
  if (allowBackfill) return;
  if (at) throw new ValidationError({ date: "Вход можно записать только за сегодня" });
  if (onDate !== undefined && onDate !== almatyToday()) throw new ValidationError({ date: "Вход можно записать только за сегодня" });
}

export const CORRECTION_REASONS = ["miscount", "late_arrivals", "wrong_registration", "duplicate", "other"] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

const isCount = (n: unknown, min: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= MAX_CHILDREN;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function requireCount(value: unknown, min = 1): number {
  if (!isCount(value, min)) throw new ValidationError({ childrenCount: min === 0 ? `От 0 до ${MAX_CHILDREN}` : `От 1 до ${MAX_CHILDREN}` });
  return value;
}

// ── figures ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DayFigures {
  date: string;
  /** Children who actually came in (sum of confirmed entries of the day). */
  childrenEntered: number;
  entries: number;
  /** Adults who passed the QR registration on that day (a declaration, not a visit). */
  adultsRegistered: number;
  /** Children declared by that day's registrations that staff has not confirmed yet. */
  childrenExpected: number;
  /** Registrations of that day still waiting for confirmation (including old ones without a declared number). Never includes cancelled ones. */
  registrationsWaiting: number;
  /** Registrations of that day whose entry was cancelled by a correction (0 children): neither expected nor entered. */
  registrationsCancelled: number;
}

const ALMATY_DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Almaty')::date`;

export async function dayFigures(db: Queryable, actor: Actor, date: string): Promise<DayFigures> {
  assertCan(actor, "attendance.manage");
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const r = await db.query<{ children_entered: string; entries: string; adults: string; expected: string; waiting: string; cancelled: string }>(
    `SELECT
       (SELECT COALESCE(sum(children_count), 0) FROM bb.attendance_entries WHERE entry_date = $1::date) AS children_entered,
       (SELECT count(*) FROM bb.attendance_entries WHERE entry_date = $1::date AND children_count > 0) AS entries,
       (SELECT count(*) FROM bb.consent_registrations r WHERE ${ALMATY_DAY("r.created_at")} = $1::date) AS adults,
       (SELECT COALESCE(sum(r.children_count), 0) FROM bb.consent_registrations r
         WHERE ${ALMATY_DAY("r.created_at")} = $1::date
           AND NOT EXISTS (SELECT 1 FROM bb.attendance_entries e WHERE e.registration_id = r.id)) AS expected,
       (SELECT count(*) FROM bb.consent_registrations r
         WHERE ${ALMATY_DAY("r.created_at")} = $1::date
           AND NOT EXISTS (SELECT 1 FROM bb.attendance_entries e WHERE e.registration_id = r.id)) AS waiting,
       (SELECT count(*) FROM bb.consent_registrations r
         WHERE ${ALMATY_DAY("r.created_at")} = $1::date
           AND EXISTS (SELECT 1 FROM bb.attendance_entries e WHERE e.registration_id = r.id AND e.children_count = 0)) AS cancelled`,
    [date],
  );
  const row = r.rows[0];
  return {
    date,
    childrenEntered: Number(row.children_entered),
    entries: Number(row.entries),
    adultsRegistered: Number(row.adults),
    childrenExpected: Number(row.expected),
    registrationsWaiting: Number(row.waiting),
    registrationsCancelled: Number(row.cancelled),
  };
}

export interface SeriesDay {
  date: string;
  childrenEntered: number;
  entries: number;
  qrChildren: number;
  manualChildren: number;
  adultsRegistered: number;
}

/** One row per calendar day (Asia/Almaty) from `from` to `to` inclusive, days without data included with zeros. */
export async function attendanceSeries(db: Queryable, actor: Actor, from: string, to: string): Promise<SeriesDay[]> {
  assertCan(actor, "attendance.manage");
  if (!isValidDate(from) || !isValidDate(to) || from > to) throw new ValidationError({ date: "Некорректный период" });
  const r = await db.query<{ d: string; children: string; entries: string; qr: string; manual: string; adults: string }>(
    `SELECT to_char(g.d, 'YYYY-MM-DD') AS d,
            COALESCE(e.children, 0) AS children, COALESCE(e.entries, 0) AS entries, COALESCE(e.qr, 0) AS qr, COALESCE(e.manual, 0) AS manual,
            COALESCE(a.adults, 0) AS adults
       FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
       LEFT JOIN (SELECT entry_date, sum(children_count) AS children, count(*) FILTER (WHERE children_count > 0) AS entries,
                         sum(children_count) FILTER (WHERE method = 'qr') AS qr, sum(children_count) FILTER (WHERE method = 'manual') AS manual
                    FROM bb.attendance_entries WHERE entry_date BETWEEN $1::date AND $2::date GROUP BY entry_date) e ON e.entry_date = g.d::date
       LEFT JOIN (SELECT ${ALMATY_DAY("created_at")} AS d, count(*) AS adults FROM bb.consent_registrations
                   WHERE ${ALMATY_DAY("created_at")} BETWEEN $1::date AND $2::date GROUP BY 1) a ON a.d = g.d::date
      ORDER BY g.d`,
    [from, to],
  );
  return r.rows.map((x) => ({
    date: x.d,
    childrenEntered: Number(x.children),
    entries: Number(x.entries),
    qrChildren: Number(x.qr),
    manualChildren: Number(x.manual),
    adultsRegistered: Number(x.adults),
  }));
}

export interface RegistrationRow {
  id: string;
  seq: number;
  /** The adult's name; "—" when the contact was anonymised. */
  name: string;
  declaredChildren: number | null;
  createdAt: string;
  status: "waiting" | "confirmed" | "cancelled";
  entryId: string | null;
  enteredChildren: number | null;
  enteredAt: string | null;
}

export async function listRegistrations(db: Queryable, actor: Actor, date: string): Promise<RegistrationRow[]> {
  assertCan(actor, "attendance.manage");
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const r = await db.query<{ id: string; seq: string; name: string; anon: Date | null; declared: number | null; created_at: Date; entry_id: string | null; entered: number | null; entered_at: Date | null }>(
    `SELECT r.id, r.seq, c.name, c.anonymized_at AS anon, r.children_count AS declared, r.created_at,
            e.id AS entry_id, e.children_count AS entered, e.entered_at
       FROM bb.consent_registrations r
       JOIN bb.contacts c ON c.id = r.contact_id
       LEFT JOIN bb.attendance_entries e ON e.registration_id = r.id
      WHERE ${ALMATY_DAY("r.created_at")} = $1::date
      ORDER BY r.seq DESC`,
    [date],
  );
  return r.rows.map((x) => ({
    id: x.id,
    seq: Number(x.seq),
    name: x.anon ? "—" : x.name,
    declaredChildren: x.declared,
    createdAt: x.created_at.toISOString(),
    status: x.entry_id === null ? "waiting" : x.entered! > 0 ? "confirmed" : "cancelled",
    entryId: x.entry_id,
    enteredChildren: x.entered,
    enteredAt: x.entered_at ? x.entered_at.toISOString() : null,
  }));
}

export interface EntryRow {
  id: string;
  method: "qr" | "manual";
  childrenCount: number;
  enteredAt: string;
  confirmedBy: string;
  /** Registered adult for a QR entry. */
  adultName: string | null;
  corrections: Array<{ oldCount: number; newCount: number; reason: CorrectionReason; by: string; at: string }>;
}

export async function listEntries(db: Queryable, actor: Actor, date: string): Promise<EntryRow[]> {
  assertCan(actor, "attendance.manage");
  if (!isValidDate(date)) throw new ValidationError({ date: "Некорректная дата" });
  const r = await db.query<{ id: string; method: "qr" | "manual"; children_count: number; entered_at: Date; staff: string; adult: string | null; anon: Date | null }>(
    `SELECT e.id, e.method, e.children_count, e.entered_at, u.name AS staff, c.name AS adult, c.anonymized_at AS anon
       FROM bb.attendance_entries e
       JOIN bb.users u ON u.id = e.confirmed_by
       LEFT JOIN bb.consent_registrations r ON r.id = e.registration_id
       LEFT JOIN bb.contacts c ON c.id = r.contact_id
      WHERE e.entry_date = $1::date
      ORDER BY e.entered_at DESC, e.seq DESC`,
    [date],
  );
  const ids = r.rows.map((x) => x.id);
  const corr = ids.length
    ? await db.query<{ entry_id: string; old_count: number; new_count: number; reason: CorrectionReason; by: string; corrected_at: Date }>(
        `SELECT k.entry_id, k.old_count, k.new_count, k.reason, u.name AS by, k.corrected_at
           FROM bb.attendance_corrections k JOIN bb.users u ON u.id = k.corrected_by WHERE k.entry_id = ANY($1::uuid[]) ORDER BY k.id`,
        [ids],
      )
    : { rows: [] };
  return r.rows.map((x) => ({
    id: x.id,
    method: x.method,
    childrenCount: x.children_count,
    enteredAt: x.entered_at.toISOString(),
    confirmedBy: x.staff,
    adultName: x.method === "qr" ? (x.anon ? "—" : x.adult) : null,
    corrections: corr.rows.filter((k) => k.entry_id === x.id).map((k) => ({ oldCount: k.old_count, newCount: k.new_count, reason: k.reason, by: k.by, at: k.corrected_at.toISOString() })),
  }));
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryResult {
  entryId: string;
  /** True when the entry already existed: nothing was added, the figures did not change. */
  duplicate: boolean;
  childrenCount: number;
}

/**
 * Staff confirms that the registered adult has come in with `childrenCount` children (the number may differ from the declared one).
 * The first confirmation wins; any repeat (double tap, retry, a colleague at the same moment) returns the existing entry and adds nothing.
 * `at` exists for tests and back-filling only; the admin never passes it.
 */
export async function confirmRegistrationEntry(
  pool: Pool,
  actor: Actor,
  input: { registrationId: string; childrenCount: unknown; onDate?: string; at?: Date; allowBackfill?: boolean },
  meta: RequestMeta = {},
): Promise<EntryResult> {
  assertCan(actor, "attendance.manage");
  if (!isUuid(input.registrationId)) throw new ValidationError({ registrationId: "Некорректная регистрация" });
  const count = requireCount(input.childrenCount);
  assertToday(input.onDate, input.at, input.allowBackfill);
  return withTx(pool, async (tx) => {
    const reg = await tx.query<{ today: boolean }>(`SELECT (${ALMATY_DAY("created_at")} = ${ALMATY_DAY("now()")}) AS today FROM bb.consent_registrations WHERE id = $1`, [input.registrationId]);
    if (!reg.rows[0]) throw new NotFoundError("registration");
    // A registration of an earlier day is not confirmed now (the entry would belong to a day the visitor did not register on).
    if (!reg.rows[0].today && !input.allowBackfill) throw new ValidationError({ date: "Вход можно записать только за сегодня" });
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bb.attendance_entries (registration_id, method, children_count, confirmed_by, entered_at)
       VALUES ($1, 'qr', $2, $3, COALESCE($4::timestamptz, now()))
       ON CONFLICT (registration_id) WHERE registration_id IS NOT NULL DO NOTHING RETURNING id`,
      [input.registrationId, count, actor.id, input.at ?? null],
    );
    if (!ins.rows[0]) {
      const existing = await tx.query<{ id: string; children_count: number }>("SELECT id, children_count FROM bb.attendance_entries WHERE registration_id = $1", [input.registrationId]);
      return { entryId: existing.rows[0].id, duplicate: true, childrenCount: existing.rows[0].children_count };
    }
    await writeAudit(tx, { actorUserId: actor.id, action: "attendance.confirmed", entityType: "attendance_entry", entityId: ins.rows[0].id, after: { method: "qr", children: count, registrationId: input.registrationId }, ...meta });
    return { entryId: ins.rows[0].id, duplicate: false, childrenCount: count };
  });
}

/**
 * A visitor without a QR registration. The idempotency key (generated once per form) makes a double tap or a retry
 * add one entry, not two.
 */
export async function addManualEntry(
  pool: Pool,
  actor: Actor,
  input: { childrenCount: unknown; idempotencyKey: string; onDate?: string; at?: Date; allowBackfill?: boolean },
  meta: RequestMeta = {},
): Promise<EntryResult> {
  assertCan(actor, "attendance.manage");
  const count = requireCount(input.childrenCount);
  assertToday(input.onDate, input.at, input.allowBackfill);
  if (!isUuid(input.idempotencyKey)) throw new ValidationError({ idempotencyKey: "Обновите страницу и повторите" });
  return withTx(pool, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bb.attendance_entries (registration_id, method, children_count, confirmed_by, entered_at, idempotency_key)
       VALUES (NULL, 'manual', $1, $2, COALESCE($3::timestamptz, now()), $4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [count, actor.id, input.at ?? null, input.idempotencyKey],
    );
    if (!ins.rows[0]) {
      const existing = await tx.query<{ id: string; children_count: number }>("SELECT id, children_count FROM bb.attendance_entries WHERE idempotency_key = $1", [input.idempotencyKey]);
      return { entryId: existing.rows[0].id, duplicate: true, childrenCount: existing.rows[0].children_count };
    }
    await writeAudit(tx, { actorUserId: actor.id, action: "attendance.manual", entityType: "attendance_entry", entityId: ins.rows[0].id, after: { method: "manual", children: count }, ...meta });
    return { entryId: ins.rows[0].id, duplicate: false, childrenCount: count };
  });
}

/**
 * Corrects the number of children of an entry (0 cancels it). `expectedCount` is the number the person saw on screen: if a
 * colleague changed it in the meantime the correction is refused instead of overwriting blindly. The database writes the
 * correction row; the audit log records it too.
 */
export async function correctEntry(
  pool: Pool,
  actor: Actor,
  input: { entryId: string; newCount: unknown; expectedCount: unknown; reason: unknown },
  meta: RequestMeta = {},
): Promise<{ changed: boolean; childrenCount: number }> {
  assertCan(actor, "attendance.manage");
  if (!isUuid(input.entryId)) throw new ValidationError({ entryId: "Некорректная запись" });
  const next = requireCount(input.newCount, 0);
  const expected = requireCount(input.expectedCount, 0);
  const reason = String(input.reason);
  if (!(CORRECTION_REASONS as readonly string[]).includes(reason)) throw new ValidationError({ reason: "Выберите причину" });
  return withTx(pool, async (tx) => {
    const cur = await tx.query<{ children_count: number; registration_id: string | null }>("SELECT children_count, registration_id FROM bb.attendance_entries WHERE id = $1 FOR UPDATE", [input.entryId]);
    if (!cur.rows[0]) throw new NotFoundError("entry");
    const before = cur.rows[0].children_count;
    if (before !== expected) throw new ConflictError("changed");
    if (before === next) return { changed: false, childrenCount: before };
    // The database trigger reads these two values and writes the correction row itself.
    await tx.query("SELECT set_config('bb.actor', $1, true), set_config('bb.reason', $2, true)", [actor.id, reason]);
    await tx.query("UPDATE bb.attendance_entries SET children_count = $2 WHERE id = $1", [input.entryId, next]);
    await writeAudit(tx, { actorUserId: actor.id, action: "attendance.corrected", entityType: "attendance_entry", entityId: input.entryId, before: { children: before }, after: { children: next, reason }, ...meta });
    return { changed: true, childrenCount: next };
  });
}

/** The default range of the table and chart: the last `days` days up to and including `to`. */
export function rangeEndingAt(to: string, days: number): { from: string; to: string } {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { from: d.toISOString().slice(0, 10), to };
}

export { almatyToday };
