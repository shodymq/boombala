import "server-only";
import { almatyWindow, windowOverlapsRoom } from "../core/booking-calendar.ts";
import { FastApiCrmConfigurationError, FastApiCrmError, type FastApiCrmClient } from "./fastapi-crm.ts";

/**
 * The booking steps the calendar performs, as plain functions over the FastAPI client. The server actions wrap them with
 * the verified staff actor and turn the result into a redirect. Nothing here writes to Platform SQL.
 *
 * Retry rule: a 401 is rethrown so the caller can issue a fresh bridge token and run the whole step once more. Every other
 * failure becomes a result, so the page can show the state FastAPI actually reached (for example a paid, unconfirmed request).
 */

/** The methods the flows use. A test can pass a fake with only these. */
export type BookingWriter = Pick<FastApiCrmClient, "getBookingTimeline" | "createStaffRequest" | "recordManualPayment" | "confirmBooking">;

export type NewBookingInput = {
  branchId: string;
  date: string;
  roomId: string;
  startTime: string;
  packageId: string;
  customerName: string;
  phone: string;
  guestCount?: number;
  agreedPriceKzt: number;
  prepaymentKzt: number;
  prepaymentMethod: "cash" | "card_terminal" | "bank_transfer" | "other_manual";
  note?: string;
  idempotencyKey: string;
};

export type ConfirmPaidInput = {
  requestId: string;
  branchId: string;
  date: string;
  roomId: string;
  startTime: string;
  packageId: string;
  agreedPriceKzt: number;
  idempotencyKey: string;
};

export type FlowResult =
  | { ok: true; reservationId: string; requestId: string }
  | { ok: false; code: string; requestId: string | null };

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

/** A fixed code for the page; the page owns the Russian text. */
export function failureCode(error: unknown): string {
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
 * stays the authority; a race between this read and the confirmation still ends in the kernel's time_conflict.
 */
export async function precheckRoom(client: BookingWriter, branchId: string, date: string, roomId: string, startTime: string): Promise<void> {
  const timeline = await client.getBookingTimeline(branchId, date);
  const { startIso, endIso } = almatyWindow(date, startTime);
  const newOccupiedEnd = new Date(Date.parse(endIso) + timeline.bufferMinutes * 60_000).toISOString();
  const occupied = timeline.reservations.map((r) => ({ roomId: r.roomId, startsAt: r.startsAt, endsAt: r.occupiedEndsAt, status: r.status }));
  if (windowOverlapsRoom(occupied, roomId, startIso, newOccupiedEnd)) throw new FastApiCrmError(409, "time_conflict", "precheck");
}

/** Request, then the manual prepayment, then the confirmation. Each step has its own derived idempotency key. */
export async function createBookingFlow(client: BookingWriter, input: NewBookingInput): Promise<FlowResult> {
  let requestId: string | null = null;
  try {
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
    requestId = request.id;
    await client.recordManualPayment(request.id, {
      amountKzt: input.prepaymentKzt,
      method: input.prepaymentMethod,
      idempotencyKey: `${input.idempotencyKey}:payment`,
      note: input.note,
    });
    const confirmed = await client.confirmBooking({
      requestId: request.id,
      bookingDate: input.date,
      roomId: input.roomId,
      startTime: input.startTime,
      packageId: input.packageId,
      agreedPriceKzt: input.agreedPriceKzt,
      idempotencyKey: `${input.idempotencyKey}:confirm`,
      note: input.note,
    });
    return settled(confirmed, requestId);
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    return { ok: false, code: failureCode(error), requestId };
  }
}

/**
 * Confirms a request whose manual prepayment is already recorded. Writes no request and no payment fact, so a retry on another
 * time never adds money. The kernel decides the room and time.
 */
export async function confirmPaidRequestFlow(client: BookingWriter, input: ConfirmPaidInput): Promise<FlowResult> {
  try {
    await precheckRoom(client, input.branchId, input.date, input.roomId, input.startTime);
    const confirmed = await client.confirmBooking({
      requestId: input.requestId,
      bookingDate: input.date,
      roomId: input.roomId,
      startTime: input.startTime,
      packageId: input.packageId,
      agreedPriceKzt: input.agreedPriceKzt,
      idempotencyKey: `${input.idempotencyKey}:confirm`,
    });
    return settled(confirmed, input.requestId);
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    return { ok: false, code: failureCode(error), requestId: input.requestId };
  }
}

function settled(confirmed: unknown, requestId: string): FlowResult {
  const reservationId = reservationIdOf(confirmed);
  if (!reservationId) return { ok: false, code: "failed", requestId };
  return { ok: true, reservationId, requestId };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof FastApiCrmError && error.status === 401;
}
