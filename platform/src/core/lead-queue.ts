import type { Pool } from "./db.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import { assertCan, can, type Actor } from "./rbac.ts";
import type { LeadRow } from "./bookings.ts";
import type { LeadNextAction } from "./lead-workflow.ts";

/**
 * The request queue: server-side search, pagination, a single record by id and the dashboard counters.
 * Read-only. Writes (status, confirmation) stay in bookings.ts and the calendar flow.
 */
export const LEAD_PAGE_SIZE = 25;
export const LEAD_PAGE_SIZE_MAX = 100;
export const LEAD_STATUSES = ["new", "in_progress", "confirmed", "cancelled", "completed"] as const;

export interface LeadFilter {
  status?: string;
  /** Free text: a part of the name, or at least three digits of the phone. */
  q?: string;
  /** Dates of creation, Asia/Almaty calendar days, inclusive. */
  createdFrom?: string;
  createdTo?: string;
  /** Open requests whose planned follow-up time has passed. */
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export interface LeadQueueItem extends LeadRow {
  assignedTo: string | null;
  assigneeName: string | null;
  nextAction: LeadNextAction | null;
  followUpAt: Date | null;
  managerAgreement: string | null;
  workflowVersion: number;
  followUpOverdue: boolean;
}

export interface LeadPage {
  items: LeadQueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeadDetail extends LeadQueueItem {
  /** Manual prepayment fact in tenge, or null when none is recorded. */
  prepaymentKzt: number | null;
}

const LEAD_COLUMNS = `l.id, l.seq, l.created_at, l.status, c.name, c.phone_e164, to_char(l.requested_date, 'YYYY-MM-DD') AS requested_date,
            l.slot_id, to_char(l.preferred_start_time, 'HH24:MI') AS preferred_start_time, l.room_id, l.package_id, l.children,
            l.assigned_to, assignee.name AS assignee_name, l.next_action, l.follow_up_at, l.manager_agreement, l.workflow_version,
            (l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')) AS follow_up_overdue,
            (SELECT r.id FROM bb.slot_reservations r WHERE r.lead_request_id = l.id AND r.released_at IS NULL) AS reservation_id`;

function leadRow(r: Record<string, unknown>): LeadQueueItem {
  return {
    id: r.id as string,
    seq: Number(r.seq),
    createdAt: r.created_at as Date,
    status: r.status as string,
    name: r.name as string,
    phone: r.phone_e164 as string,
    requestedDate: r.requested_date as string,
    slotId: r.slot_id as number | null,
    preferredStartTime: r.preferred_start_time as string | null,
    roomId: r.room_id as string | null,
    packageId: r.package_id as string | null,
    children: r.children as number | null,
    reservationId: r.reservation_id as string | null,
    assignedTo: r.assigned_to as string | null,
    assigneeName: r.assignee_name as string | null,
    nextAction: r.next_action as LeadNextAction | null,
    followUpAt: r.follow_up_at as Date | null,
    managerAgreement: r.manager_agreement as string | null,
    workflowVersion: Number(r.workflow_version),
    followUpOverdue: r.follow_up_overdue === true,
  };
}

const LIKE_SPECIALS = /[\\%_]/g;
const NON_DIGITS = /\D/g;

/** Filters and paginates in PostgreSQL. A malformed filter is a validation error, never a silent "all rows". */
export async function searchLeads(pool: Pool, actor: Actor, filter: LeadFilter = {}): Promise<LeadPage> {
  assertCan(actor, "requests.manage");
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError({ status: "invalid" });
    where.push(`l.status = ${add(filter.status)}`);
  }
  if (filter.createdFrom !== undefined) {
    if (!isValidDate(filter.createdFrom)) throw new ValidationError({ createdFrom: "invalid" });
    where.push(`(l.created_at AT TIME ZONE 'Asia/Almaty')::date >= ${add(filter.createdFrom)}::date`);
  }
  if (filter.createdTo !== undefined) {
    if (!isValidDate(filter.createdTo)) throw new ValidationError({ createdTo: "invalid" });
    where.push(`(l.created_at AT TIME ZONE 'Asia/Almaty')::date <= ${add(filter.createdTo)}::date`);
  }
  if (filter.overdue === true) where.push("l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')");
  const q = filter.q?.trim().slice(0, 80);
  if (q) {
    const digits = q.replace(NON_DIGITS, "");
    const name = add(`%${q.replace(LIKE_SPECIALS, (c) => `\\${c}`)}%`);
    where.push(
      digits.length >= 3
        ? `(c.name ILIKE ${name} OR regexp_replace(c.phone_e164, '[^0-9]', '', 'g') LIKE ${add(`%${digits}%`)})`
        : `c.name ILIKE ${name}`,
    );
  }
  const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? LEAD_PAGE_SIZE) || LEAD_PAGE_SIZE, 1), LEAD_PAGE_SIZE_MAX);
  const requested = Math.max(Math.trunc(filter.page ?? 1) || 1, 1);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const counted = await pool.query(`SELECT count(*)::int AS n FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id ${clause}`, params);
  const total = Number(counted.rows[0].n);
  // A page past the end falls back to the last page, so a stale link shows data instead of an empty screen.
  const page = Math.min(requested, Math.max(Math.ceil(total / pageSize), 1));
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLUMNS}
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id LEFT JOIN bb.users assignee ON assignee.id = l.assigned_to
       ${clause} ORDER BY (l.follow_up_at IS NOT NULL AND l.follow_up_at <= now() AND l.status IN ('new', 'in_progress')) DESC,
         (l.status IN ('new', 'in_progress')) DESC, l.requested_date, l.seq DESC
       LIMIT ${add(pageSize)} OFFSET ${add((page - 1) * pageSize)}`,
    params,
  );
  return { items: rows.map(leadRow), total, page, pageSize };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One record by id, with the manual prepayment fact. Null when there is no such request. */
export async function getLead(pool: Pool, actor: Actor, id: string): Promise<LeadDetail | null> {
  assertCan(actor, "requests.manage");
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT ${LEAD_COLUMNS}, (SELECT p.amount_kzt FROM bb.manual_payment_facts p WHERE p.lead_request_id = l.id ORDER BY p.created_at LIMIT 1) AS prepayment_kzt
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id LEFT JOIN bb.users assignee ON assignee.id = l.assigned_to WHERE l.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  return { ...leadRow(rows[0]), prepaymentKzt: rows[0].prepayment_kzt === null ? null : Number(rows[0].prepayment_kzt) };
}

export interface DashboardCounters {
  /** Asia/Almaty calendar day the booking counters refer to. */
  date: string;
  requests: { new: number; inProgress: number } | null;
  bookings: { booked: number; blocked: number } | null;
}

/** Real counters only. Requests need `requests.manage`, bookings and blocks need `bookings.manage`; otherwise null, never zero. */
export async function dashboardCounters(pool: Pool, role: Actor["role"]): Promise<DashboardCounters> {
  const date = almatyToday();
  const [requests, bookings] = await Promise.all([
    can(role, "requests.manage")
      ? pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM bb.lead_requests WHERE status IN ('new', 'in_progress') GROUP BY status")
      : Promise.resolve(null),
    can(role, "bookings.manage")
      ? pool.query<{ kind: string; n: number }>(
          `SELECT kind, count(*)::int AS n FROM bb.slot_reservations
            WHERE released_at IS NULL AND (starts_at AT TIME ZONE 'Asia/Almaty')::date = $1::date GROUP BY kind`,
          [date],
        )
      : Promise.resolve(null),
  ]);
  const pick = (rows: Array<{ n: number } & Record<string, unknown>>, key: string, value: string) => rows.find((r) => r[key] === value)?.n ?? 0;
  return {
    date,
    requests: requests ? { new: pick(requests.rows, "status", "new"), inProgress: pick(requests.rows, "status", "in_progress") } : null,
    bookings: bookings ? { booked: pick(bookings.rows, "kind", "booking"), blocked: pick(bookings.rows, "kind", "block") } : null,
  };
}
