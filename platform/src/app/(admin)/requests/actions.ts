"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { setLeadStatus } from "../../../core/bookings.ts";
import type { Role } from "../../../core/rbac.ts";
import { birthdayStartTimes } from "../../../core/birthday-booking-time.ts";
import { canCancelStatusOnlyBooking, initialDepositRefundRequiresCancellation } from "../../../core/initial-deposit-refund.ts";
import { isValidDate } from "../../../core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { fastApiActorForStaff } from "../../../server/fastapi-staff.ts";

const legacyId = z.string().uuid();
const leadId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const entityId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const paymentMethod = z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]);
const paymentKind = z.enum(["initial_deposit", "additional"]);
const crmStatus = z.enum(["contacted", "qualified", "lost", "in_progress", "closed", "completed", "cancelled"]);
const lostReasons = new Set(["too_expensive", "date_unavailable", "no_answer", "competitor", "changed_mind", "other_branch", "later", "other", "price", "no_response", "chose_competitor", "changed_plans", "duplicate"]);
const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

function failure(error: unknown): never {
  let code = "failed";
  if (error instanceof ConflictError) code = error.message === "slot_taken" ? "slot_taken" : "conflict";
  else if (error instanceof ValidationError) code = "invalid";
  else if (error instanceof ForbiddenError) code = "forbidden";
  else if (error instanceof FastApiCrmConfigurationError) code = "fastapi_unavailable";
  redirect(`/requests?error=${code}`);
}

function detailFailure(id: string, error: unknown, retry?: Record<string, string>): never {
  let code = "fastapi_unavailable";
  let uncertain = !(error instanceof FastApiCrmError);
  if (error instanceof FastApiCrmError) {
    uncertain = error.status >= 500;
    if (error.status === 403) code = "forbidden";
    else if (error.status === 404) code = "not_found";
    else if (error.status === 409 && error.code === "birthday_booking_cancellation_required") code = "booking_cancel_first";
    else if (error.status === 409 && error.code === "birthday_payment_reconciliation_required") code = "payment_reconciliation";
    else if (error.status === 409 && error.code === "birthday_refund_exceeds_paid") code = "refund_exceeds_paid";
    else if (error.status === 409 && error.code === "birthday_prepayment_required") code = "prepayment_required";
    else if (error.status === 409 && error.code === "booking_buffer_required") code = "buffer_required";
    else if (error.status === 502 && ["booking_response_mismatch", "booking_lead_readback_mismatch", "booking_timeline_readback_mismatch"].includes(error.code)) code = "booking_verification_uncertain";
    else if (error.status === 409 && ["time_conflict", "slot_taken", "request_already_booked"].includes(error.code)) code = "booking_conflict";
    else if (error.status === 409 && ["start_in_past", "booking_date_in_past"].includes(error.code)) code = "booking_past";
    else if (error.status === 422 && error.code === "invalid_lead_status_transition") code = "transition";
    else if (error.status === 409) code = "conflict";
    else if (error.status === 422) code = "invalid";
  } else if (error instanceof ForbiddenError) {
    code = "forbidden";
    uncertain = false;
  } else if (error instanceof ValidationError || error instanceof z.ZodError) {
    code = "invalid";
    uncertain = false;
  }

  const params = new URLSearchParams({ error: code });
  if (retry && uncertain) {
    for (const [name, value] of Object.entries(retry)) params.set(name, value);
  }
  redirect(`/requests/${encodeURIComponent(id)}?${params.toString()}`);
}

async function fastApiClient(user: { id: string; email: string; role: Role }) {
  const requestId = randomUUID();
  const actor = await fastApiActorForStaff(user, { requestId });
  return new FastApiCrmClient(actor);
}

function actionConflict(code: string): FastApiCrmError {
  return new FastApiCrmError(409, code, "crm-action");
}

export async function leadStatusAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("requests.manage");
  if (unifiedFastapiCrmEnabled()) {
    const id = leadId.safeParse(formData.get("id"));
    const status = crmStatus.safeParse(str(formData, "status"));
    const lostReason = str(formData, "lostReason");
    if (!id.success || !status.success || (status.data === "lost" && !lostReasons.has(lostReason))) {
      if (id.success) return detailFailure(id.data, new ValidationError({ status: "invalid" }));
      return failure(new ValidationError({ id: "bad" }));
    }
    try {
      const client = await fastApiClient(user);
      const lead = await client.getLead(id.data);
      let bookingReservationState: "none" | "active" | "released" | undefined;
      if (status.data === "cancelled" && lead.type === "birthday_request") {
        bookingReservationState = (await client.getBirthdayLead(id.data)).bookingReservationState;
      }
      if (!allowedStatusTransitions(lead.type, lead.status, bookingReservationState).includes(status.data)) return detailFailure(id.data, actionConflict("invalid_lead_status_transition"));
      const updated = await client.updateLeadStatus(id.data, {
        status: status.data,
        ...(status.data === "lost" ? { lostReason } : {}),
      });
      if (updated.status !== status.data) throw new FastApiCrmError(502, "status_readback_mismatch", "crm-action");
    } catch (error) {
      return detailFailure(id.data, error);
    }
    redirect(`/requests/${encodeURIComponent(id.data)}?notice=status`);
  }

  const id = legacyId.safeParse(formData.get("id"));
  const status = str(formData, "status");
  if (!id.success || !["new", "in_progress", "cancelled"].includes(status)) return failure(new ValidationError({ id: "bad" }));
  try {
    await setLeadStatus(getPool(), { id: user.id, role: user.role }, id.data, status as "new" | "in_progress" | "cancelled", await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/requests?notice=status");
}

function allowedStatusTransitions(
  type: "birthday_request" | "contact",
  status: string,
  bookingReservationState?: "none" | "active" | "released",
): string[] {
  if (type === "contact") {
    if (status === "new") return ["in_progress", "closed"];
    if (status === "in_progress") return ["closed"];
    return [];
  }
  if (status === "new") return ["contacted", "lost"];
  if (status === "contacted") return ["qualified", "lost"];
  if (status === "qualified") return ["lost"];
  if (status === "lost") return ["contacted", "qualified"];
  if (status === "in_progress") return ["contacted", "qualified", "lost"];
  if (["booked", "paid", "confirmed"].includes(status)) {
    const transitions = ["completed"];
    if (bookingReservationState && canCancelStatusOnlyBooking(status, bookingReservationState)) transitions.push("cancelled");
    return transitions;
  }
  return [];
}

export async function recordManualPaymentAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const id = leadId.safeParse(formData.get("id"));
  const kind = paymentKind.safeParse(str(formData, "paymentKind"));
  const amountKzt = Number(str(formData, "amountKzt"));
  const method = paymentMethod.safeParse(str(formData, "method"));
  const note = str(formData, "note").trim();
  const idempotencyKey = z.string().uuid().safeParse(formData.get("idempotencyKey"));
  if (!unifiedFastapiCrmEnabled()) {
    if (id.success) return detailFailure(id.data, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (!id.success || !kind.success || !Number.isInteger(amountKzt) || amountKzt <= 0 || amountKzt > 10_000_000 || !method.success || note.length > 300 || !idempotencyKey.success || str(formData, "receiptReceived") !== "yes") {
    if (id.success) return detailFailure(id.data, new ValidationError({ payment: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (kind.data === "initial_deposit" && amountKzt !== 10_000) return detailFailure(id.data, new ValidationError({ initialDeposit: "must_be_10000" }));

  try {
    const client = await fastApiClient(user);
    const lead = await client.getLead(id.data);
    if (lead.type !== "birthday_request") throw actionConflict("birthday_request_required");
    if (["lost", "cancelled", "completed", "closed"].includes(lead.status)) throw actionConflict("birthday_request_not_payable");
    const birthday = await client.getBirthdayLead(id.data);
    if (kind.data === "initial_deposit" && birthday.manualPaymentFactStatus === "unreconciled") {
      throw actionConflict("birthday_payment_reconciliation_required");
    }
    if (kind.data === "initial_deposit" && birthday.manualPaymentFacts.some((payment) => payment.paymentKind === "initial_deposit")) {
      throw actionConflict("initial_deposit_already_recorded");
    }
    await client.recordManualPaymentAndRead(id.data, {
      amountKzt,
      paymentKind: kind.data,
      method: method.data,
      idempotencyKey: idempotencyKey.data,
      ...(note ? { note } : {}),
    });
  } catch (error) {
    return detailFailure(id.data, error, { [kind.data === "initial_deposit" ? "depositKey" : "paymentKey"]: idempotencyKey.data });
  }
  redirect(`/requests/${encodeURIComponent(id.data)}?notice=payment`);
}

export async function recordManualRefundAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const id = leadId.safeParse(formData.get("id"));
  const paymentFactId = entityId.safeParse(formData.get("paymentFactId"));
  const amountKzt = Number(str(formData, "amountKzt"));
  const method = paymentMethod.safeParse(str(formData, "method"));
  const reason = str(formData, "reason").trim();
  const idempotencyKey = z.string().uuid().safeParse(formData.get("idempotencyKey"));
  if (!unifiedFastapiCrmEnabled()) {
    if (id.success) return detailFailure(id.data, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (!id.success || !paymentFactId.success || !Number.isInteger(amountKzt) || amountKzt <= 0 || amountKzt > 10_000_000 || !method.success || reason.length < 1 || reason.length > 300 || !idempotencyKey.success || str(formData, "refundCompleted") !== "yes") {
    if (id.success) return detailFailure(id.data, new ValidationError({ refund: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }

  try {
    const client = await fastApiClient(user);
    const lead = await client.getLead(id.data);
    if (lead.type !== "birthday_request") throw actionConflict("birthday_request_required");
    const birthday = await client.getBirthdayLead(id.data);

    const payment = birthday.manualPaymentFacts.find((fact) => fact.id === paymentFactId.data && fact.source === "manager_manual");
    if (!payment) throw actionConflict("birthday_payment_reconciliation_required");
    if (payment.paymentKind === null || birthday.manualPaymentFactStatus === "unreconciled") throw actionConflict("birthday_payment_reconciliation_required");
    if (payment.paymentKind === "initial_deposit" && initialDepositRefundRequiresCancellation(lead.status, birthday.bookingReservationState)) {
      throw actionConflict("birthday_booking_cancellation_required");
    }
    if (birthday.manualRefundFacts.some((refund) => refund.paymentFactId === null)) throw actionConflict("birthday_payment_reconciliation_required");
    const refundedKzt = birthday.manualRefundFacts
      .filter((refund) => refund.paymentFactId === payment.id)
      .reduce((sum, refund) => sum + refund.amountKzt, 0);
    if (amountKzt > payment.amountKzt - refundedKzt) throw actionConflict("birthday_refund_exceeds_paid");

    await client.recordManualRefundAndRead(id.data, {
      amountKzt,
      paymentFactId: payment.id,
      method: method.data,
      refundedAt: new Date().toISOString(),
      idempotencyKey: idempotencyKey.data,
      reason,
    });
  } catch (error) {
    return detailFailure(id.data, error, { refundKey: idempotencyKey.data });
  }
  redirect(`/requests/${encodeURIComponent(id.data)}?notice=refund`);
}

export async function confirmBirthdayBookingAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const input = z.object({
    id: leadId,
    bookingDate: z.string().refine(isValidDate),
    branchId: entityId,
    roomId: entityId,
    packageId: entityId,
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):00$/),
    agreedPriceKzt: z.coerce.number().int().min(1).max(10_000_000),
    idempotencyKey: z.string().uuid(),
  }).safeParse({
    id: str(formData, "id"),
    bookingDate: str(formData, "bookingDate"),
    branchId: str(formData, "branchId"),
    roomId: str(formData, "roomId"),
    packageId: str(formData, "packageId"),
    startTime: str(formData, "startTime"),
    agreedPriceKzt: str(formData, "agreedPriceKzt"),
    idempotencyKey: str(formData, "idempotencyKey"),
  });
  if (!unifiedFastapiCrmEnabled()) {
    if (input.success) return detailFailure(input.data.id, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ booking: "invalid" }));
  }
  if (!input.success) {
    const id = leadId.safeParse(formData.get("id"));
    if (id.success) return detailFailure(id.data, new ValidationError({ booking: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }

  try {
    const client = await fastApiClient(user);
    const lead = await client.getLead(input.data.id);
    if (lead.type !== "birthday_request" || !lead.branch?.id || lead.branch.id !== input.data.branchId) {
      throw actionConflict("birthday_request_not_bookable");
    }
    if (!["new", "contacted", "qualified", "in_progress"].includes(lead.status)) {
      throw actionConflict("birthday_request_not_bookable");
    }
    const birthday = await client.getBirthdayLead(input.data.id);
    const deposit = birthday.manualPaymentFacts.find((payment) => payment.paymentKind === "initial_deposit" && payment.source === "manager_manual");
    const depositRefunded = deposit ? birthday.manualRefundFacts
      .filter((refund) => refund.paymentFactId === deposit.id)
      .reduce((total, refund) => total + refund.amountKzt, 0) : 0;
    if (
      birthday.manualPaymentFactStatus === "unreconciled" ||
      birthday.manualRefundFacts.some((refund) => refund.paymentFactId === null) ||
      !deposit ||
      deposit.amountKzt !== 10_000 ||
      depositRefunded !== 0 ||
      birthday.netInitialDepositKzt !== 10_000
    ) {
      throw actionConflict("birthday_prepayment_required");
    }

    const catalog = await client.getBookingCatalog(input.data.branchId);
    const branch = catalog.branches.length === 1 ? catalog.branches[0] : null;
    const rooms = catalog.rooms.filter((room) => room.branchId === input.data.branchId);
    const packages = catalog.packages.filter((item) => item.branchId === input.data.branchId);
    if (!branch || branch.id !== input.data.branchId || rooms.length !== 4 || packages.length === 0 || !rooms.some((room) => room.id === input.data.roomId) || !packages.some((item) => item.id === input.data.packageId)) {
      throw actionConflict("booking_catalog_mismatch");
    }
    if (branch.bufferMinutes !== 0) {
      throw actionConflict("booking_buffer_required");
    }
    if (!birthdayStartTimes(branch.workingHours).includes(input.data.startTime)) throw actionConflict("booking_time_outside_working_hours");

    await client.confirmBookingAndRead({
      requestId: input.data.id,
      bookingDate: input.data.bookingDate,
      roomId: input.data.roomId,
      startTime: input.data.startTime,
      packageId: input.data.packageId,
      agreedPriceKzt: input.data.agreedPriceKzt,
      idempotencyKey: input.data.idempotencyKey,
    }, branch);
  } catch (error) {
    return detailFailure(input.data.id, error, {
      bookingKey: input.data.idempotencyKey,
      bookingDate: input.data.bookingDate,
      bookingRoomId: input.data.roomId,
      bookingPackageId: input.data.packageId,
      bookingStartTime: input.data.startTime,
      agreedPriceKzt: String(input.data.agreedPriceKzt),
    });
  }
  redirect(`/bookings?date=${input.data.bookingDate}&notice=booked`);
}
