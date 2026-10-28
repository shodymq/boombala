"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { almatyWindow, isCalendarDate, windowOverlapsRoom } from "../../../core/booking-calendar.ts";
import { withFastApiClient } from "../../../server/crm-actor.ts";
import { FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";

/**
 * The only writer for the calendar when UNIFIED_FASTAPI_CRM_ENABLED=1. Every operation goes to the FastAPI kernel with the
 * verified staff actor. There is no Platform SQL fallback and no dual write.
 *
 * The redirect carries only identifiers. It never says that something succeeded: the calendar page reads the state back
 * from FastAPI and shows success only for what it finds there (`ok` and `reservation` are hints, not proof).
 */

const KNOWN_ERRORS = new Set([
  "time_conflict",
  "slot_taken",
  "outside_working_hours",
  "branch_hours_unknown",
  "start_in_past",
  "invalid_start_time",
  "birthday_prepayment_required",
  "birthday_request_not_bookable",
  "birthday_request_not_payable",
  "request_already_booked",
  "reservation_not_found",
  "reservation_already_released",
  "idempotency_conflict",
  "idempotency_in_progress",
  "forbidden",
  "invalid",
  "unavailable",
  "failed",
  "branch_access_denied",
  "branch_not_found",
  "availability_unavailable",
  "staff_not_linked",
]);

const key = z.string().min(8).max(100);
const startTime = z.string().regex(/^\d{2}:\d{2}$/);
const date = z.string().refine(isCalendarDate, "date");
const id = z.string().min(1).max(64);
const optionalText = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? undefined : v));
const money = z.coerce.number().int().positive().max(10_000_000);

const bookingSchema = z.object({
  branchId: id,
  date,
  roomId: id,
  startTime,
  packageId: id,
  customerName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(20),
  guestCount: z.string().trim().transform((v) => (v === "" ? undefined : Number(v))).pipe(z.number().int().min(0).max(500).optional()),
  agreedPriceKzt: money,
  prepaymentKzt: money,
  prepaymentMethod: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  note: optionalText(300),
  idempotencyKey: key,
});

const confirmPaidSchema = z.object({
  requestId: id,
  branchId: id,
  date,
  roomId: id,
  startTime,
  packageId: id,
  agreedPriceKzt: money,
  idempotencyKey: key,
});

const blockSchema = z.object({ branchId: id, date, roomId: id, startTime, reason: z.string().trim().min(1).max(300), idempotencyKey: key });
const rescheduleSchema = z.object({ reservationId: id, date, roomId: id, startTime, idempotencyKey: key });
const releaseSchema = z.object({ reservationId: id, reason: optionalText(300), idempotencyKey: key });

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function calendarUrl(branchId: string, date: string, query: string): string {
  const params = new URLSearchParams();
  if (branchId) params.set("branch", branchId);
  if (isCalendarDate(date)) params.set("date", date);
  return `/bookings?${params.toString()}&${query}`;
}

/** Turns a FastAPI failure into a fixed code; the page owns the Russian text. */
function failureCode(error: unknown): string {
  if (error instanceof FastApiCrmError) {
    if (error.status === 401 || error.status === 403) return error.code === "staff_not_linked" ? "staff_not_linked" : "forbidden";
    if (error.status === 409 || error.status === 404 || error.status === 422) return KNOWN_ERRORS.has(error.code) ? error.code : "failed";
    return "unavailable";
  }
  if (error instanceof FastApiCrmConfigurationError) return "unavailable";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError")) return "unavailable";
  return "failed";
}

function reservationIdOf(value: unknown): string | null {
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

/**
 * A UX hint only: refuses a window that overlaps a known occupancy (party plus buffer) before anything is written. PostgreSQL
 * stays the authority; a race still returns time_conflict from the kernel.
 */
async function precheckRoom(client: FastApiCrmClient, branchId: string, date: string, roomId: string, startTime: string): Promise<void> {
  const timeline = await client.getBookingTimeline(branchId, date);
  const { startIso, endIso } = almatyWindow(date, startTime);
  const newOccupiedEnd = new Date(Date.parse(endIso) + timeline.bufferMinutes * 60_000).toISOString();
  const occupied = timeline.reservations.map((r) => ({ roomId: r.roomId, startsAt: r.startsAt, endsAt: r.occupiedEndsAt, status: r.status }));
  if (windowOverlapsRoom(occupied, roomId, startIso, newOccupiedEnd)) throw new FastApiCrmError(409, "time_conflict", "precheck");
}

/** Only the branch and date are needed to return the manager to the same view. */
async function branchAndDate(formData: FormData): Promise<{ branchId: string; date: string }> {
  return { branchId: field(formData, "branchId"), date: field(formData, "date") };
}

function okOutcome(kind: "booked" | "blocked" | "released" | "rescheduled", reservationId: string | null): string {
  if (!reservationId) return "error=failed";
  return `ok=${kind}&reservation=${encodeURIComponent(reservationId)}`;
}

export async function createBookingAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = bookingSchema.safeParse({
    branchId,
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    packageId: field(formData, "packageId"),
    customerName: field(formData, "customerName"),
    phone: field(formData, "phone"),
    guestCount: field(formData, "guestCount"),
    agreedPriceKzt: field(formData, "agreedPriceKzt"),
    prepaymentKzt: field(formData, "prepaymentKzt"),
    prepaymentMethod: field(formData, "prepaymentMethod"),
    note: field(formData, "note"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) redirect(calendarUrl(branchId, input.date, "error=unavailable"));

  // Booking needs a request, then a recorded prepayment (the kernel refuses a confirmation without one), then the confirmation.
  // Each step has its own derived idempotency key, so a double submit replays the same records instead of creating new ones.
  const trail: { requestId: string | null } = { requestId: null };
  let outcome: string;
  try {
    const confirmed = await withFastApiClient(session, async (client) => {
      // Refuse a known conflict before any request or prepayment is written, so no paid request is left behind.
      await precheckRoom(client, input.branchId, input.date, input.roomId, input.startTime);
      const request = await client.createStaffRequest({
        branchId: input.branchId,
        packageId: input.packageId,
        customerName: input.customerName,
        phone: input.phone,
        guestCount: input.guestCount,
        requestedDate: input.date,
        notes: input.note,
        idempotencyKey: `${input.idempotencyKey}:request`,
      });
      trail.requestId = request.id;
      await client.recordManualPayment(request.id, {
        amountKzt: input.prepaymentKzt,
        method: input.prepaymentMethod,
        idempotencyKey: `${input.idempotencyKey}:payment`,
        note: input.note,
      });
      return client.confirmBooking({
        requestId: request.id,
        bookingDate: input.date,
        roomId: input.roomId,
        startTime: input.startTime,
        packageId: input.packageId,
        agreedPriceKzt: input.agreedPriceKzt,
        idempotencyKey: `${input.idempotencyKey}:confirm`,
        note: input.note,
      });
    });
    outcome = okOutcome("booked", reservationIdOf(confirmed));
  } catch (error) {
    outcome = `error=${failureCode(error)}`;
  }
  // The request id lets the page read the real payment and booking state from FastAPI after a failure.
  if (trail.requestId) outcome += `&request=${encodeURIComponent(trail.requestId)}`;
  redirect(calendarUrl(input.branchId, input.date, outcome));
}

/**
 * Confirms a request whose manual prepayment is already recorded. It records no new request and no new payment fact, so a
 * retry on another time never adds money. The kernel still decides the room and time under PostgreSQL's constraint.
 */
export async function confirmPaidRequestAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = confirmPaidSchema.safeParse({
    requestId: field(formData, "requestId"),
    branchId,
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    packageId: field(formData, "packageId"),
    agreedPriceKzt: field(formData, "agreedPriceKzt"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) redirect(calendarUrl(input.branchId, input.date, "error=unavailable"));
  let outcome: string;
  try {
    const confirmed = await withFastApiClient(session, async (client) => {
      await precheckRoom(client, input.branchId, input.date, input.roomId, input.startTime);
      return client.confirmBooking({
        requestId: input.requestId,
        bookingDate: input.date,
        roomId: input.roomId,
        startTime: input.startTime,
        packageId: input.packageId,
        agreedPriceKzt: input.agreedPriceKzt,
        idempotencyKey: `${input.idempotencyKey}:confirm`,
      });
    });
    outcome = okOutcome("booked", reservationIdOf(confirmed));
  } catch (error) {
    outcome = `error=${failureCode(error)}`;
  }
  redirect(calendarUrl(input.branchId, input.date, `${outcome}&request=${encodeURIComponent(input.requestId)}`));
}

export async function blockAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = blockSchema.safeParse({
    branchId,
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    reason: field(formData, "reason"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  let outcome: string;
  try {
    const blocked = await withFastApiClient(session, (client) =>
      client.blockSlot({ branchId: input.branchId, bookingDate: input.date, roomId: input.roomId, startTime: input.startTime, reason: input.reason, idempotencyKey: input.idempotencyKey }),
    );
    outcome = okOutcome("blocked", reservationIdOf(blocked));
  } catch (error) {
    outcome = `error=${failureCode(error)}`;
  }
  redirect(calendarUrl(input.branchId, input.date, outcome));
}

export async function rescheduleAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = rescheduleSchema.safeParse({
    reservationId: field(formData, "reservationId"),
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  let outcome: string;
  try {
    const moved = await withFastApiClient(session, (client) =>
      client.rescheduleReservation(input.reservationId, { idempotencyKey: input.idempotencyKey, startTime: input.startTime, bookingDate: input.date, roomId: input.roomId }),
    );
    outcome = okOutcome("rescheduled", reservationIdOf(moved));
  } catch (error) {
    outcome = `error=${failureCode(error)}`;
  }
  redirect(calendarUrl(branchId, input.date, outcome));
}

export async function releaseAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = releaseSchema.safeParse({
    reservationId: field(formData, "reservationId"),
    reason: field(formData, "reason"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  let outcome: string;
  try {
    const released = await withFastApiClient(session, (client) =>
      client.releaseReservation(input.reservationId, { idempotencyKey: input.idempotencyKey, reason: input.reason }),
    );
    outcome = okOutcome("released", reservationIdOf(released));
  } catch (error) {
    outcome = `error=${failureCode(error)}`;
  }
  redirect(calendarUrl(branchId, rawDate, outcome));
}
