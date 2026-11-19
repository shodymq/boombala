import "server-only";

import { cookies } from "next/headers";
import { almatyDate, isCalendarDate } from "../core/booking-calendar.ts";
import type { LeadDetail } from "../core/lead-queue.ts";
import type { BirthdayLeadState, BookingCatalog, BookingTimeline, FastApiLeadList } from "./fastapi-crm.ts";
import { bridgeRpc } from "./bridge-client.ts";
import { SESSION_COOKIE } from "./env.ts";

/** What the calendar page needs, read with one bridge round trip (typed operation `calendar.view`). */
export type CalendarView = {
  catalog: BookingCatalog;
  timeline: BookingTimeline;
  leads: FastApiLeadList;
  lead: BirthdayLeadState | null;
  bookingLead: BirthdayLeadState | null;
  /** The request being continued from its card; the page decides whether it can still be continued. */
  continued: LeadDetail | null;
};

export type CalendarViewQuery = { date?: string; request?: string; reservation?: string; continue?: string };

export async function loadCalendarView(query: CalendarViewQuery): Promise<CalendarView> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new Error("session_missing");
  const date = isCalendarDate(query.date) ? query.date : almatyDate();
  return bridgeRpc<CalendarView>("calendar.view", { date, request: query.request, reservation: query.reservation, continue: query.continue }, token);
}
