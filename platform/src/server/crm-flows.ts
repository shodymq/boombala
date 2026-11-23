import "server-only";
import { createHash } from "node:crypto";
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
export type BookingWriter = Pick<FastApiCrmClient, "getBookingTimeline" | "createStaffRequest" | "recordManualPaymentAndRead" | "confirmBooking" | "getBirthdayLead">;

export type CreateBookingRequestInput = {
  branchId: string;
  requestedDate: string;
  packageId: string;
  customerName: string;
  phone: string;
  guestCount?: number;
  note?: string;
  idempotencyKey: string;
};

export type RecordPrepaymentInput = {
  requestId: string;
  amountKzt: number;
  method: "cash" | "card_terminal" | "bank_transfer" | "other_manual";
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
  note?: string;
  card?: Record<string, unknown>;
  idempotencyKey: string;
};

export type FlowResult =
  | { ok: true; reservationId: string; requestId: string }
  | { ok: false; code: string; requestId: string | null };

export type RequestFlowResult =
  | { ok: true; requestId: string }
  | { ok: false; code: string; requestId: null };

export type PrepaymentFlowResult =
  | { ok: true; requestId: string; amountKzt: number; alreadyRecorded: boolean }
  | { ok: false; code: string; requestId: string };

const KNOWN_ERRORS = new Set([
  "time_conflict",
  "slot_taken",
  "outside_working_hours",
  "branch_hours_unknown",
  "start_in_past",
  "invalid_start_time",
  "invalid_booking_duration",
  "birthday_prepayment_required",
  "birthday_request_not_bookable",
  "birthday_request_not_payable",
  "payment_confirmation_required",
  "payment_unverified",
  "payment_amount_mismatch",
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
  "paid_request_pending",
  "card_version_conflict",
  "program_incomplete",
  "program_option_not_allowed",
  "program_needs_package",
  "invitation_not_applicable",
  "responsible_invalid",
  "not_sheet_managed",
  "already_handed_over",
  "source_managed_read_only",
]);

/** A fixed code for the page; the page owns the Russian text. Unexpected errors are logged by name only. */
export function failureCode(error: unknown): string {
  if (!(error instanceof FastApiCrmError) && !(error instanceof FastApiCrmConfigurationError)) {
    console.error("[crm-flows] unexpected error:", error instanceof Error ? error.name : "non-error");
  }
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
  if (timeline.rooms?.find((room) => room.id === roomId)?.occupancyMode === "shared") return;
  const { startIso, endIso } = almatyWindow(date, startTime);
  const newOccupiedEnd = new Date(Date.parse(endIso) + timeline.bufferMinutes * 60_000).toISOString();
  const occupied = timeline.reservations.map((r) => ({ roomId: r.roomId, startsAt: r.startsAt, endsAt: r.occupiedEndsAt, status: r.status }));
  if (windowOverlapsRoom(occupied, roomId, startIso, newOccupiedEnd)) throw new FastApiCrmError(409, "time_conflict", "precheck");
}

/** Creating a request never writes money or occupies a room. Booking is a later, separate action after recorded prepayment. */
export async function createBookingRequestFlow(client: BookingWriter, input: CreateBookingRequestInput): Promise<RequestFlowResult> {
  try {
    const request = await client.createStaffRequest({
      branchId: input.branchId,
      packageId: input.packageId,
      customerName: input.customerName,
      phone: input.phone,
      guestCount: input.guestCount,
      requestedDate: input.requestedDate,
      notes: input.note,
      idempotencyKey: `${input.idempotencyKey}:request`,
    });
    return { ok: true, requestId: request.id };
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    return { ok: false, code: failureCode(error), requestId: null };
  }
}

/** Record an explicitly attested, already received manual prepayment; never creates or confirms a reservation. */
export async function recordManualPrepaymentFlow(client: BookingWriter, input: RecordPrepaymentInput): Promise<PrepaymentFlowResult> {
  try {
    if (input.amountKzt !== 10_000) return { ok: false, code: "payment_amount_mismatch", requestId: input.requestId };
    const lead = await client.getBirthdayLead(input.requestId);
    if (lead.bookedAt !== null) return { ok: false, code: "request_already_booked", requestId: input.requestId };
    if (!(["new", "in_progress"] as string[]).includes(lead.status)) return { ok: false, code: "birthday_request_not_payable", requestId: input.requestId };
    if (lead.manualPaymentFactStatus === "prepaid" && lead.manualPaymentFactAmountKzt > 0) {
      return lead.manualPaymentFactAmountKzt === 10_000
        ? { ok: true, requestId: input.requestId, amountKzt: lead.manualPaymentFactAmountKzt, alreadyRecorded: true }
        : { ok: false, code: "payment_amount_mismatch", requestId: input.requestId };
    }

    const { lead: verified } = await client.recordManualPaymentAndRead(input.requestId, {
      amountKzt: input.amountKzt,
      method: input.method,
      idempotencyKey: `${input.idempotencyKey}:payment`,
      note: input.note,
    });
    const state = verified as typeof lead;
    if (state.id !== input.requestId || state.manualPaymentFactStatus !== "prepaid" || state.manualPaymentFactAmountKzt !== input.amountKzt) {
      return { ok: false, code: "payment_unverified", requestId: input.requestId };
    }
    return { ok: true, requestId: input.requestId, amountKzt: state.manualPaymentFactAmountKzt, alreadyRecorded: false };
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    return { ok: false, code: failureCode(error), requestId: input.requestId };
  }
}

/**
 * Confirms a request whose manual prepayment is already recorded. Writes no request and no payment fact, so a retry on another
 * time never adds money. The kernel decides the room and time.
 */
export async function confirmPaidRequestFlow(client: BookingWriter, input: ConfirmPaidInput): Promise<FlowResult> {
  try {
    const lead = await client.getBirthdayLead(input.requestId);
    if (lead.bookedAt !== null) return { ok: false, code: "request_already_booked", requestId: input.requestId };
    if (!(lead.status === "new" || lead.status === "in_progress")) return { ok: false, code: "birthday_request_not_bookable", requestId: input.requestId };
    if (lead.manualPaymentFactStatus !== "prepaid" || lead.manualPaymentFactAmountKzt !== 10_000) {
      return { ok: false, code: "birthday_prepayment_required", requestId: input.requestId };
    }
    await precheckRoom(client, input.branchId, input.date, input.roomId, input.startTime);
    const confirmed = await client.confirmBooking({
      requestId: input.requestId,
      bookingDate: input.date,
      roomId: input.roomId,
      startTime: input.startTime,
      packageId: input.packageId,
      agreedPriceKzt: input.agreedPriceKzt,
      note: input.note,
      // A failed room conflict must not pin the request to the original slot. Reuse the same key for an
      // identical retry (including a lost success response), but derive a new key when the manager picks
      // another target. The bridge still owns the authoritative idempotency and booking transaction.
      idempotencyKey: confirmationIdempotencyKey(input),
      ...(input.card ? { card: input.card } : {}),
    });
    return settled(confirmed, input.requestId);
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    return { ok: false, code: failureCode(error), requestId: input.requestId };
  }
}

function confirmationIdempotencyKey(input: ConfirmPaidInput): string {
  const target = createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    branchId: input.branchId,
    date: input.date,
    roomId: input.roomId,
    startTime: input.startTime,
    packageId: input.packageId,
    agreedPriceKzt: input.agreedPriceKzt,
    note: input.note ?? null,
    card: input.card ?? null,
  })).digest("hex").slice(0, 24);
  return `${input.idempotencyKey}:confirm:${target}`;
}

function settled(confirmed: unknown, requestId: string): FlowResult {
  const reservationId = reservationIdOf(confirmed);
  if (!reservationId) return { ok: false, code: "failed", requestId };
  return { ok: true, reservationId, requestId };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof FastApiCrmError && error.status === 401;
}
