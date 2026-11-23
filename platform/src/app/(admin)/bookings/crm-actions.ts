"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isCalendarDate, toMinutes } from "../../../core/booking-calendar.ts";
import { withFastApiClient } from "../../../server/crm-actor.ts";
import { unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { confirmPaidRequestFlow, createBookingRequestFlow, failureCode, recordManualPrepaymentFlow } from "../../../server/crm-flows.ts";
import { requirePermission } from "../../../server/dal.ts";
import type { BookingFormState } from "./booking-action-state";

/**
 * The only writer for the calendar when UNIFIED_FASTAPI_CRM_ENABLED=1. Every operation goes to the FastAPI kernel with the
 * verified staff actor. There is no Platform SQL fallback and no dual write.
 *
 * The redirect carries only identifiers. It never says that something succeeded: the calendar page reads the state back
 * from FastAPI and shows success only for what it finds there (`ok` and `reservation` are hints, not proof).
 */

const key = z.string().min(8).max(100);
// Any real HH:MM. The minute is not rounded or restricted here: the FastAPI kernel decides which starts it accepts.
const startTime = z.string().regex(/^\d{2}:\d{2}$/).refine((v) => {
  const minutes = toMinutes(v);
  return minutes !== null && minutes % 60 === 0;
}, "full_hour");
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
  note: optionalText(300),
  idempotencyKey: key,
});

const paymentSchema = z.object({
  requestId: id,
  branchId: id,
  date,
  roomId: id,
  startTime,
  amountKzt: money.refine((amount) => amount === 10_000, "payment_amount_mismatch"),
  prepaymentMethod: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  receiptConfirmed: z.literal("yes"),
  note: optionalText(300),
  idempotencyKey: key,
});

const blockSchema = z.object({ branchId: id, date, roomId: id, startTime, reason: z.string().trim().min(1).max(300), idempotencyKey: key });
const rescheduleSchema = z.object({ reservationId: id, date, roomId: id, startTime, idempotencyKey: key });
const releaseSchema = z.object({ reservationId: id, reason: optionalText(300), idempotencyKey: key });

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** A form value as a card field: empty means "not set" (null), anything else is passed on and validated by the server. */
function cardValue(formData: FormData, name: string): string | null {
  const value = field(formData, name).trim();
  return value === "" ? null : value;
}

const CARD_KINDS = ["show", "master_class", "challenge", "animation"] as const;

/** The optional customer and headcount fields of the new-booking forms. Nothing here is required. */
function newBookingCard(formData: FormData): Record<string, unknown> | undefined {
  const card: Record<string, unknown> = {};
  for (const name of ["childName", "childAge", "preferredLanguage", "childrenTotal", "adultsTotal", "responsibleUserId"]) {
    const value = cardValue(formData, name);
    if (value !== null) card[name] = value;
  }
  if (cardValue(formData, "headcountMode") === "by_fact") card.headcountMode = "by_fact";
  return Object.keys(card).length ? card : undefined;
}

function calendarUrl(branchId: string, date: string, query: string): string {
  const params = new URLSearchParams();
  if (branchId) params.set("branch", branchId);
  if (isCalendarDate(date)) params.set("date", date);
  return `/bookings?${params.toString()}&${query}`;
}

/** Only the branch and date are needed to return the manager to the same view. */
async function branchAndDate(formData: FormData): Promise<{ branchId: string; date: string }> {
  return { branchId: field(formData, "branchId"), date: field(formData, "date") };
}

function reservationIdOf(value: unknown): string | null {
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function okOutcome(kind: "booked" | "blocked" | "released" | "rescheduled", reservationId: string | null): string {
  if (!reservationId) return "error=failed";
  return `ok=${kind}&reservation=${encodeURIComponent(reservationId)}`;
}

function actionError(error: unknown, requestId?: string): BookingFormState {
  return { errorCode: failureCode(error), ...(requestId ? { requestId } : {}) };
}

export async function createBookingAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
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
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) return { errorCode: "unavailable" };
  let result: Awaited<ReturnType<typeof createBookingRequestFlow>>;
  try {
    result = await withFastApiClient(session, (client) => createBookingRequestFlow(client, {
      branchId: input.branchId,
      requestedDate: input.date,
      packageId: input.packageId,
      customerName: input.customerName,
      phone: input.phone,
      guestCount: input.guestCount,
      idempotencyKey: input.idempotencyKey,
    }));
  } catch (error) {
    return actionError(error);
  }
  if (!result.ok) return { errorCode: result.code };
  redirect(calendarUrl(input.branchId, input.date, `continue=${encodeURIComponent(result.requestId)}&room=${encodeURIComponent(field(formData, "roomId"))}&start=${encodeURIComponent(field(formData, "startTime"))}`));
}

/** Confirms only a request whose 10,000 ₸ manual prepayment has been read back from the backend. */
export async function confirmPaidRequestAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
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
    note: field(formData, "note"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) return { errorCode: "unavailable" };
  let result: Awaited<ReturnType<typeof confirmPaidRequestFlow>>;
  try {
    result = await withFastApiClient(session, (client) => confirmPaidRequestFlow(client, { ...input, card: newBookingCard(formData) }));
  } catch (error) {
    return actionError(error, input.requestId);
  }
  if (!result.ok) return { errorCode: result.code, requestId: input.requestId };
  const outcome = okOutcome("booked", result.reservationId);
  redirect(calendarUrl(input.branchId, input.date, `${outcome}&request=${encodeURIComponent(input.requestId)}`));
}

/** The only CRM action that writes a manual payment fact; it requires explicit receipt attestation and backend read-back. */
export async function recordManualPrepaymentAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const requestId = field(formData, "requestId");
  if (field(formData, "receiptConfirmed") !== "yes") return { errorCode: "payment_confirmation_required", requestId };
  if (Number(field(formData, "amountKzt")) !== 10_000) return { errorCode: "payment_amount_mismatch", requestId };
  const parsed = paymentSchema.safeParse({
    requestId,
    branchId,
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    amountKzt: field(formData, "amountKzt"),
    prepaymentMethod: field(formData, "prepaymentMethod"),
    receiptConfirmed: field(formData, "receiptConfirmed"),
    note: field(formData, "note"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) return { errorCode: "unavailable" };
  let result: Awaited<ReturnType<typeof recordManualPrepaymentFlow>>;
  try {
    result = await withFastApiClient(session, (client) => recordManualPrepaymentFlow(client, {
      requestId: input.requestId,
      amountKzt: input.amountKzt,
      method: input.prepaymentMethod,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    }));
  } catch (error) {
    return actionError(error, input.requestId);
  }
  if (!result.ok) return { errorCode: result.code, requestId: input.requestId };
  redirect(calendarUrl(input.branchId, input.date, `continue=${encodeURIComponent(input.requestId)}&request=${encodeURIComponent(input.requestId)}&room=${encodeURIComponent(input.roomId)}&start=${encodeURIComponent(input.startTime)}&payment=recorded`));
}

export async function blockAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
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
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  let blocked: unknown;
  try {
    blocked = await withFastApiClient(session, (client) =>
      client.blockSlot({ branchId: input.branchId, bookingDate: input.date, roomId: input.roomId, startTime: input.startTime, reason: input.reason, idempotencyKey: input.idempotencyKey }),
    );
  } catch (error) {
    return actionError(error);
  }
  const outcome = okOutcome("blocked", reservationIdOf(blocked));
  if (outcome === "error=failed") return { errorCode: "failed" };
  redirect(calendarUrl(input.branchId, input.date, outcome));
}

export async function rescheduleAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = rescheduleSchema.safeParse({
    reservationId: field(formData, "reservationId"),
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  let moved: unknown;
  try {
    moved = await withFastApiClient(session, (client) =>
      client.rescheduleReservation(input.reservationId, { idempotencyKey: input.idempotencyKey, startTime: input.startTime, bookingDate: input.date, roomId: input.roomId }),
    );
  } catch (error) {
    return actionError(error);
  }
  const outcome = okOutcome("rescheduled", reservationIdOf(moved));
  if (outcome === "error=failed") return { errorCode: "failed" };
  redirect(calendarUrl(branchId, input.date, outcome));
}

export async function releaseAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = releaseSchema.safeParse({
    reservationId: field(formData, "reservationId"),
    reason: field(formData, "reason"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  let released: unknown;
  try {
    released = await withFastApiClient(session, (client) =>
      client.releaseReservation(input.reservationId, { idempotencyKey: input.idempotencyKey, reason: input.reason }),
    );
  } catch (error) {
    return actionError(error);
  }
  const outcome = okOutcome("released", reservationIdOf(released));
  if (outcome === "error=failed") return { errorCode: "failed" };
  redirect(calendarUrl(branchId, rawDate, outcome));
}

// ── Booking card (Booking V2) ──────────────────────────────────────────────────────────────────────────────────

const cardSaveSchema = z.object({ reservationId: id, idempotencyKey: key, date });

function cardUrl(branchId: string, d: string, reservationId: string, query: string): string {
  return calendarUrl(branchId, d, `reservation=${encodeURIComponent(reservationId)}&card=1&${query}`);
}

/**
 * Saves the card of an event. The browser sends only what the manager typed: the server recomputes the program rules, the
 * amount and the permissions. A stale form (another manager saved first) is refused with `card_version_conflict`.
 */
export async function saveCardAction(_previous: BookingFormState, formData: FormData): Promise<BookingFormState> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = cardSaveSchema.safeParse({ reservationId: field(formData, "reservationId"), idempotencyKey: field(formData, "idempotencyKey"), date: rawDate });
  if (!parsed.success) return { errorCode: "invalid" };
  const input = parsed.data;
  const versionRaw = cardValue(formData, "expectedVersion");

  const fields: Record<string, unknown> = {
    childName: cardValue(formData, "childName"),
    childAge: cardValue(formData, "childAge"),
    preferredLanguage: cardValue(formData, "preferredLanguage"),
    headcountMode: cardValue(formData, "headcountMode") ?? "exact",
    childrenTotal: cardValue(formData, "childrenTotal"),
    adultsTotal: cardValue(formData, "adultsTotal"),
    animators: field(formData, "animators").split(",").map((x) => x.trim()).filter(Boolean),
    responsibleUserId: cardValue(formData, "responsibleUserId"),
    animationNote: cardValue(formData, "animationNote"),
    wishes: cardValue(formData, "wishes"),
    decoration: cardValue(formData, "decoration"),
    cake: cardValue(formData, "cake"),
    staffComment: cardValue(formData, "staffComment"),
    propsStatus: cardValue(formData, "propsStatus") ?? "not_started",
    manualExtraChildrenKzt: cardValue(formData, "manualExtraChildrenKzt"),
    manualExtraAdultsKzt: cardValue(formData, "manualExtraAdultsKzt"),
    mealKzt: cardValue(formData, "mealKzt") ?? "0",
    programStatus: formData.get("programApproved") ? "approved" : "draft",
    selections: CARD_KINDS.flatMap((kind) => formData.getAll(`sel_${kind}`).filter((v): v is string => typeof v === "string" && v !== "").map((optionId) => ({ kind, optionId }))),
    services: Array.from({ length: 31 }, (_, i) => i).flatMap((i) => {
      const name = field(formData, `svcName${i}`).trim();
      const amount = field(formData, `svcAmount${i}`).trim();
      return name || amount ? [{ name, amountKzt: Number(amount) }] : [];
    }),
  };
  // The invitation status exists only for the package that includes it; the form omits the field otherwise.
  const invitation = cardValue(formData, "invitationStatus");
  if (invitation) fields.invitationStatus = invitation;

  try {
    await withFastApiClient(session, (client) =>
      client.saveBookingCard(input.reservationId, { idempotencyKey: input.idempotencyKey, expectedVersion: versionRaw === null ? null : Number(versionRaw), fields }),
    );
  } catch (error) {
    return actionError(error);
  }
  redirect(cardUrl(branchId, input.date, input.reservationId, "saved=card"));
}

/** Hands a Google Sheets record over to the CRM. Afterwards sync no longer moves or releases it. */
export async function handoverAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = cardSaveSchema.safeParse({ reservationId: field(formData, "reservationId"), idempotencyKey: field(formData, "idempotencyKey"), date: rawDate });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  let outcome: string;
  try {
    await withFastApiClient(session, (client) => client.handoverReservation(input.reservationId, { idempotencyKey: input.idempotencyKey }));
    outcome = "saved=handover";
  } catch (error) {
    outcome = `cerror=${failureCode(error)}`;
  }
  redirect(cardUrl(branchId, input.date, input.reservationId, outcome));
}
