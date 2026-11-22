import type { Pool } from "./db.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { can, type Role } from "./rbac.ts";

const WINDOW_DAYS = 30;

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const result = value.toISOString().slice(0, 10);
  if (!isValidDate(result)) throw new Error("analytics_date_invalid");
  return result;
}

export interface DashboardAnalytics {
  /** Inclusive Asia/Almaty window for request and manually recorded payment facts. */
  historyFrom: string;
  historyThrough: string;
  /** Current statuses of requests created in the historical window; not a matured conversion cohort. */
  leads: null | {
    total: number;
    new: number;
    inProgress: number;
    confirmed: number;
    cancelled: number;
    completed: number;
  };
  /** Active reservations whose event date falls from today through the next 29 Almaty dates. */
  upcoming: null | { bookings: number; blocks: number };
  /** Append-only manager-entered prepayment facts recorded in the historical window; never total revenue. */
  manualPrepayments: null | { count: number; amountKzt: string };
}

/**
 * Aggregate-only manager snapshot. No customer fields leave PostgreSQL. Permissions follow the data family:
 * request pipeline requires requests.manage; schedule and manual payment facts require bookings.manage.
 */
export async function dashboardAnalytics(pool: Pool, role: Role, today = almatyToday()): Promise<DashboardAnalytics> {
  if (!isValidDate(today)) throw new Error("analytics_date_invalid");
  const historyFrom = shiftDate(today, -(WINDOW_DAYS - 1));
  const historyThrough = today;
  const upcomingEndExclusive = shiftDate(today, WINDOW_DAYS);

  const [leadRows, upcomingRows, paymentRows] = await Promise.all([
    can(role, "requests.manage")
      ? pool.query<{ status: string; count: number }>(
          `SELECT status, count(*)::int AS count
             FROM bb.lead_requests
            WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Almaty')
              AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')
            GROUP BY status`,
          [historyFrom, historyThrough],
        )
      : Promise.resolve(null),
    can(role, "bookings.manage")
      ? pool.query<{ kind: string; count: number }>(
          `SELECT kind, count(*)::int AS count
             FROM bb.slot_reservations
            WHERE released_at IS NULL AND starts_at >= now() AND slot_date >= $1::date AND slot_date < $2::date
            GROUP BY kind`,
          [today, upcomingEndExclusive],
        )
      : Promise.resolve(null),
    can(role, "bookings.manage")
      ? pool.query<{ count: number; amount: string }>(
          `SELECT count(*)::int AS count, coalesce(sum(amount_kzt), 0)::text AS amount
             FROM bb.manual_payment_facts
            WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Almaty')
              AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')`,
          [historyFrom, historyThrough],
        )
      : Promise.resolve(null),
  ]);

  const statusCount = (status: string) => Number(leadRows?.rows.find((row) => row.status === status)?.count ?? 0);
  const kindCount = (kind: string) => Number(upcomingRows?.rows.find((row) => row.kind === kind)?.count ?? 0);
  const paymentAmount = paymentRows ? BigInt(paymentRows.rows[0]?.amount ?? "0") : 0n;

  return {
    historyFrom,
    historyThrough,
    leads: leadRows ? {
      total: leadRows.rows.reduce((sum, row) => sum + Number(row.count), 0),
      new: statusCount("new"),
      inProgress: statusCount("in_progress"),
      confirmed: statusCount("confirmed"),
      cancelled: statusCount("cancelled"),
      completed: statusCount("completed"),
    } : null,
    upcoming: upcomingRows ? { bookings: kindCount("booking"), blocks: kindCount("block") } : null,
    manualPrepayments: paymentRows ? {
      count: Number(paymentRows.rows[0]?.count ?? 0),
      // Keep the PostgreSQL bigint sum exact through JSON; the UI formats this decimal string as BigInt.
      amountKzt: paymentAmount.toString(),
    } : null,
  };
}
