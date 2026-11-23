import type { Pool } from "./db.ts";
import { almatyToday } from "./dates.ts";
import { almatyLocalDateTimeToInstant, type LeadNextAction } from "./lead-workflow.ts";
import { assertCan, can, type Actor } from "./rbac.ts";

export type ManagerWorkspaceLead = {
  id: string;
  seq: number;
  name: string;
  phone: string;
  status: "new" | "in_progress";
  requestedDate: string;
  createdAt: string;
  assignedTo: string | null;
  assigneeName: string | null;
  nextAction: LeadNextAction | null;
  followUpAt: string | null;
};

export type ManagerWorkspaceBirthday = {
  id: string;
  date: string;
  startsAt: string;
  room: string;
  packageName: string | null;
};

/** Null means the current staff role cannot read that section; an empty list is an authorized, genuinely empty result. */
export type ManagerWorkspace = {
  overdueActions: ManagerWorkspaceLead[] | null;
  newRequests: ManagerWorkspaceLead[] | null;
  callsToday: ManagerWorkspaceLead[] | null;
  upcomingBirthdays: ManagerWorkspaceBirthday[] | null;
};

const LEAD_SELECT = `SELECT l.id, l.seq, c.name, c.phone_e164, l.status, to_char(l.requested_date, 'YYYY-MM-DD') AS requested_date,
                            l.created_at, l.assigned_to, assignee.name AS assignee_name, l.next_action, l.follow_up_at
                       FROM bb.lead_requests l
                       JOIN bb.contacts c ON c.id = l.contact_id
                       LEFT JOIN bb.users assignee ON assignee.id = l.assigned_to`;

function mapLead(row: Record<string, unknown>): ManagerWorkspaceLead {
  return {
    id: row.id as string,
    seq: Number(row.seq),
    name: row.name as string,
    phone: row.phone_e164 as string,
    status: row.status as ManagerWorkspaceLead["status"],
    requestedDate: row.requested_date as string,
    createdAt: (row.created_at as Date).toISOString(),
    assignedTo: row.assigned_to as string | null,
    assigneeName: row.assignee_name as string | null,
    nextAction: row.next_action as LeadNextAction | null,
    followUpAt: row.follow_up_at ? (row.follow_up_at as Date).toISOString() : null,
  };
}

async function overdueActions(pool: Pool, actor: Actor, now: Date): Promise<ManagerWorkspaceLead[]> {
  assertCan(actor, "requests.manage");
  const result = await pool.query(
    `${LEAD_SELECT}
      WHERE l.status IN ('new', 'in_progress') AND l.follow_up_at IS NOT NULL AND l.follow_up_at <= $1::timestamptz
      ORDER BY l.follow_up_at ASC, l.seq ASC LIMIT 8`,
    [now.toISOString()],
  );
  return result.rows.map(mapLead);
}

async function newRequests(pool: Pool, actor: Actor): Promise<ManagerWorkspaceLead[]> {
  assertCan(actor, "requests.manage");
  const result = await pool.query(
    `${LEAD_SELECT}
      WHERE l.status = 'new'
      ORDER BY l.created_at ASC, l.seq ASC LIMIT 8`,
  );
  return result.rows.map(mapLead);
}

async function callsToday(pool: Pool, actor: Actor, now: Date): Promise<ManagerWorkspaceLead[]> {
  assertCan(actor, "requests.manage");
  const today = almatyToday(now);
  const tomorrowDate = new Date(`${today}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const from = almatyLocalDateTimeToInstant(`${today}T00:00`).toISOString();
  const through = almatyLocalDateTimeToInstant(`${tomorrow}T00:00`).toISOString();
  const result = await pool.query(
    `${LEAD_SELECT}
      WHERE l.status IN ('new', 'in_progress') AND l.next_action = 'call_customer'
        AND l.follow_up_at >= $1::timestamptz AND l.follow_up_at < $2::timestamptz AND l.follow_up_at > $3::timestamptz
      ORDER BY l.follow_up_at ASC, l.seq ASC LIMIT 8`,
    [from, through, now.toISOString()],
  );
  return result.rows.map(mapLead);
}

async function upcomingBirthdays(pool: Pool, actor: Actor, now: Date): Promise<ManagerWorkspaceBirthday[]> {
  assertCan(actor, "bookings.manage");
  const until = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `SELECT r.id, to_char(r.slot_date, 'YYYY-MM-DD') AS date, r.starts_at, rm.name AS room, p.name AS package_name
       FROM bb.slot_reservations r
       JOIN bb.rooms rm ON rm.id = r.room_id
       LEFT JOIN bb.packages p ON p.id = r.package_id
      WHERE r.kind = 'booking' AND r.released_at IS NULL
        AND r.starts_at >= $1::timestamptz AND r.starts_at < $2::timestamptz
      ORDER BY r.starts_at, r.id
      LIMIT 8`,
    [now.toISOString(), until.toISOString()],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    date: row.date as string,
    startsAt: (row.starts_at as Date).toISOString(),
    room: row.room as string,
    packageName: row.package_name as string | null,
  }));
}

/** Existing lead workflow + confirmed reservations, filtered by the same server-side permissions as their source pages. */
export async function managerWorkspace(pool: Pool, actor: Actor, now = new Date()): Promise<ManagerWorkspace> {
  if (Number.isNaN(now.getTime())) throw new RangeError("invalid_manager_workspace_time");
  const requestsAllowed = can(actor.role, "requests.manage");
  const bookingsAllowed = can(actor.role, "bookings.manage");
  const [overdue, fresh, calls, birthdays] = await Promise.all([
    requestsAllowed ? overdueActions(pool, actor, now) : null,
    requestsAllowed ? newRequests(pool, actor) : null,
    requestsAllowed ? callsToday(pool, actor, now) : null,
    bookingsAllowed ? upcomingBirthdays(pool, actor, now) : null,
  ]);
  return { overdueActions: overdue, newRequests: fresh, callsToday: calls, upcomingBirthdays: birthdays };
}
