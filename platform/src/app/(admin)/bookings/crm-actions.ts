"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { almatyDate, isCalendarDate, toMinutes } from "../../../core/booking-calendar.ts";
import { withFastApiClient } from "../../../server/crm-actor.ts";
import { unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { confirmPaidRequestFlow, continueRequestFlow, createBookingFlow, failureCode } from "../../../server/crm-flows.ts";
import { requirePermission } from "../../../server/dal.ts";

/**
 * The only writer for the calendar when UNIFIED_FASTAPI_CRM_ENABLED=1. Every operation goes to the FastAPI kernel with the
 * verified staff actor. There is no Platform SQL fallback and no dual write.
 *
 * The redirect carries only identifiers. It never says that something succeeded: the calendar page reads the state back
 * from FastAPI and shows success only for what it finds there (`ok` and `reservation` are hints, not proof).
 */

const key = z.string().min(8).max(100);
// Any real HH:MM. The minute is not rounded or restricted here: the FastAPI kernel decides which starts it accepts.
const startTime = z.string().regex(/^\d{2}:\d{2}$/).refine((v) => toMinutes(v) !== null, "time");
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
  childName: optionalText(80),
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

const continueSchema = confirmPaidSchema.extend({
  prepaymentKzt: money,
  prepaymentMethod: z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]),
  note: optionalText(300),
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
    childName: field(formData, "childName"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) redirect(calendarUrl(branchId, input.date, "error=unavailable"));
  // The kernel has no child field yet, so the name travels in the comment (visible in the booking card).
  const note = [input.childName ? `Ребёнок: ${input.childName}` : "", input.note ?? ""].filter(Boolean).join(". ").slice(0, 300) || undefined;

  // Booking needs a request, then a recorded prepayment (the kernel refuses a confirmation without one), then the confirmation.
  // Each step has its own derived idempotency key, so a double submit replays the same records instead of creating new ones.
  const result = await withFastApiClient(session, (client) =>
    createBookingFlow(client, {
      branchId: input.branchId,
      date: input.date,
      roomId: input.roomId,
      startTime: input.startTime,
      packageId: input.packageId,
      customerName: input.customerName,
      phone: input.phone,
      guestCount: input.guestCount,
      agreedPriceKzt: input.agreedPriceKzt,
      prepaymentKzt: input.prepaymentKzt,
      prepaymentMethod: input.prepaymentMethod,
      note,
      card: newBookingCard(formData),
      idempotencyKey: input.idempotencyKey,
    }, almatyDate()),
  );
  let outcome = result.ok ? okOutcome("booked", result.reservationId) : `error=${result.code}`;
  // The request id lets the page read the real payment and booking state from FastAPI after a failure.
  if (result.requestId) outcome += `&request=${encodeURIComponent(result.requestId)}`;
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
  const result = await withFastApiClient(session, (client) => confirmPaidRequestFlow(client, { ...input }));
  const outcome = result.ok ? okOutcome("booked", result.reservationId) : `error=${result.code}`;
  redirect(calendarUrl(input.branchId, input.date, `${outcome}&request=${encodeURIComponent(input.requestId)}`));
}

/** Books the request the manager opened (no new request is created). */
export async function continueRequestAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = continueSchema.safeParse({
    requestId: field(formData, "requestId"),
    branchId,
    date: rawDate,
    roomId: field(formData, "roomId"),
    startTime: field(formData, "startTime"),
    packageId: field(formData, "packageId"),
    agreedPriceKzt: field(formData, "agreedPriceKzt"),
    prepaymentKzt: field(formData, "prepaymentKzt") || "10000",
    prepaymentMethod: field(formData, "prepaymentMethod") || "cash",
    note: field(formData, "note"),
    idempotencyKey: field(formData, "idempotencyKey"),
  });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
  const input = parsed.data;
  if (!unifiedFastapiCrmEnabled()) redirect(calendarUrl(input.branchId, input.date, "error=unavailable"));
  const result = await withFastApiClient(session, (client) => continueRequestFlow(client, { ...input, card: newBookingCard(formData) }));
  const outcome = result.ok ? okOutcome("booked", result.reservationId) : `error=${result.code}`;
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

// ── Booking card (Booking V2) ──────────────────────────────────────────────────────────────────────────────────

const cardSaveSchema = z.object({ reservationId: id, idempotencyKey: key, date });

function cardUrl(branchId: string, d: string, reservationId: string, query: string): string {
  return calendarUrl(branchId, d, `reservation=${encodeURIComponent(reservationId)}&card=1&${query}`);
}

/**
 * Saves the card of an event. The browser sends only what the manager typed: the server recomputes the program rules, the
 * amount and the permissions. A stale form (another manager saved first) is refused with `card_version_conflict`.
 */
export async function saveCardAction(formData: FormData): Promise<void> {
  const session = await requirePermission("bookings.manage");
  const { branchId, date: rawDate } = await branchAndDate(formData);
  const parsed = cardSaveSchema.safeParse({ reservationId: field(formData, "reservationId"), idempotencyKey: field(formData, "idempotencyKey"), date: rawDate });
  if (!parsed.success) redirect(calendarUrl(branchId, rawDate, "error=invalid"));
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

  let outcome: string;
  try {
    await withFastApiClient(session, (client) =>
      client.saveBookingCard(input.reservationId, { idempotencyKey: input.idempotencyKey, expectedVersion: versionRaw === null ? null : Number(versionRaw), fields }),
    );
    outcome = "saved=card";
  } catch (error) {
    outcome = `cerror=${failureCode(error)}`;
  }
  redirect(cardUrl(branchId, input.date, input.reservationId, outcome));
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
