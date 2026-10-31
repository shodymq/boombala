"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { confirmLead, setLeadStatus } from "../../../core/bookings.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { canRetryWithSameIdempotencyKey, FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { fastApiActorForStaff } from "../../../server/fastapi-staff.ts";
import { isValidDate } from "../../../core/dates.ts";

const uuid = z.string().uuid();
const leadId = z.string().min(1).max(32);
const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const fastApiStatus = z.enum(["contacted", "qualified", "lost", "completed", "in_progress", "closed"]);
const paymentMethod = z.enum(["cash", "card_terminal", "bank_transfer", "other_manual"]);
const lostReasons = new Set(["too_expensive", "date_unavailable", "no_answer", "competitor", "changed_mind", "other_branch", "later", "other", "price", "no_response", "chose_competitor", "changed_plans", "duplicate"]);

function detailError(id: string, error: unknown, retryKey?: { name: string; value: string }): never {
  let code = "fastapi_unavailable";
  const canRetryWithSameKey = canRetryWithSameIdempotencyKey(error);
  if (error instanceof FastApiCrmError) {
    if (error.status === 403) code = "forbidden";
    else if (error.status === 404) code = "not_found";
    else if (error.status === 409 && ["time_conflict", "slot_taken"].includes(error.code)) code = "slot_taken";
    else if (error.status === 409 && error.code === "birthday_prepayment_required") code = "prepayment_required";
    else if (error.status === 409 && error.code === "booking_buffer_required") code = "buffer_required";
    else if (error.status === 409 && error.code === "booking_buffer_reconciliation_required") code = "buffer_reconciliation_required";
    else if (error.status === 409 && error.code === "birthday_refund_exceeds_paid") code = "refund_exceeds_paid";
    else if (error.status === 422 && error.code === "invalid_lead_status_transition") code = "transition";
    else if (error.status === 409) code = "conflict";
    else if (error.status === 422) code = "invalid";
  } else if (error instanceof FastApiCrmConfigurationError) {
    code = "fastapi_unavailable";
  } else if (error instanceof ForbiddenError) {
    code = "forbidden";
  } else if (error instanceof ValidationError) {
    code = "invalid";
  } else if (error instanceof z.ZodError) {
    code = "invalid";
  }
  const params = new URLSearchParams({ error: code });
  if (retryKey && canRetryWithSameKey) params.set(retryKey.name, retryKey.value);
  redirect(`/requests/${encodeURIComponent(id)}?${params.toString()}`);
}

async function fastApiClient(user: { id: string; email: string }) {
  const requestId = randomUUID();
  const actor = await fastApiActorForStaff(user, { requestId });
  return new FastApiCrmClient(actor);
}

function failure(error: unknown): never {
  let code = "failed";
  if (error instanceof ConflictError) code = error.message === "slot_taken" ? "slot_taken" : "conflict";
  else if (error instanceof ValidationError) code = "invalid";
  else if (error instanceof ForbiddenError) code = "forbidden";
  else if (error instanceof FastApiCrmConfigurationError) code = "fastapi_unavailable";
  redirect(`/requests?error=${code}`);
}

export async function confirmLeadAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  if (unifiedFastapiCrmEnabled()) {
    const id = leadId.safeParse(formData.get("id"));
    const bookingDate = str(formData, "bookingDate");
    const startTime = str(formData, "startTime");
    const packageId = str(formData, "packageId");
    const roomId = str(formData, "roomId");
    const agreedPriceKzt = Number(str(formData, "agreedPriceKzt"));
    const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
    if (!id.success || !isValidDate(bookingDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !packageId || !roomId || !Number.isInteger(agreedPriceKzt) || agreedPriceKzt <= 0 || !idempotencyKey.success) {
      if (id.success) return detailError(id.data, new ValidationError({ booking: "invalid" }));
      return failure(new ValidationError({ id: "bad" }));
    }
    try {
      const client = await fastApiClient(user);
      await client.confirmBookingAndRead({ requestId: id.data, bookingDate, roomId, startTime, packageId, agreedPriceKzt, idempotencyKey: idempotencyKey.data });
    } catch (error) {
      return detailError(id.data, error, { name: "bookingKey", value: idempotencyKey.data });
    }
    redirect(`/bookings?date=${bookingDate}&notice=booked`);
  }
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  let date = "";
  try {
    date = str(formData, "date");
    await confirmLead(
      getPool(),
      { id: user.id, role: user.role },
      { leadId: id.data, date, slotId: Number(str(formData, "slotId")) || undefined, roomId: str(formData, "roomId") || undefined, packageId: str(formData, "packageId") || undefined },
      await requestMeta(),
    );
  } catch (error) {
    return failure(error);
  }
  redirect(`/bookings?date=${date}&notice=booked`);
}

export async function leadStatusAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("requests.manage");
  if (unifiedFastapiCrmEnabled()) {
    const id = leadId.safeParse(formData.get("id"));
    const status = fastApiStatus.safeParse(str(formData, "status"));
    const lostReason = str(formData, "lostReason");
    if (!id.success || !status.success || (status.data === "lost" && !lostReasons.has(lostReason))) {
      if (id.success) return detailError(id.data, new ValidationError({ status: "invalid" }));
      return failure(new ValidationError({ id: "bad" }));
    }
    try {
      const client = await fastApiClient(user);
      await client.updateLeadStatus(id.data, { status: status.data, ...(status.data === "lost" ? { lostReason } : {}) });
    } catch (error) {
      return detailError(id.data, error);
    }
    redirect(`/requests/${encodeURIComponent(id.data)}?notice=status`);
  }
  const id = uuid.safeParse(formData.get("id"));
  const status = str(formData, "status");
  if (!id.success || !["new", "in_progress", "cancelled"].includes(status)) return failure(new ValidationError({ id: "bad" }));
  try {
    await setLeadStatus(getPool(), { id: user.id, role: user.role }, id.data, status as "new" | "in_progress" | "cancelled", await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/requests?notice=status");
}

export async function saveLeadNoteAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("requests.manage");
  const id = leadId.safeParse(formData.get("id"));
  const adminNote = z.string().max(2000).safeParse(str(formData, "adminNote"));
  if (!unifiedFastapiCrmEnabled()) {
    if (id.success) return detailError(id.data, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (!id.success || !adminNote.success) {
    if (id.success) return detailError(id.data, new ValidationError({ adminNote: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }
  try {
    const client = await fastApiClient(user);
    const lead = await client.getLead(id.data);
    await client.updateLeadStatus(id.data, { status: lead.status, adminNote: adminNote.data });
  } catch (error) {
    return detailError(id.data, error);
  }
  redirect(`/requests/${encodeURIComponent(id.data)}?notice=note`);
}

export async function recordManualPaymentAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const id = leadId.safeParse(formData.get("id"));
  const amountKzt = Number(str(formData, "amountKzt"));
  const method = paymentMethod.safeParse(str(formData, "method"));
  const note = str(formData, "note").trim();
  const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
  if (!unifiedFastapiCrmEnabled()) {
    if (id.success) return detailError(id.data, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (!id.success || !Number.isInteger(amountKzt) || amountKzt <= 0 || amountKzt > 10_000_000 || !method.success || note.length > 300 || !idempotencyKey.success) {
    if (id.success) return detailError(id.data, new ValidationError({ payment: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }
  try {
    const client = await fastApiClient(user);
    await client.recordManualPaymentAndRead(id.data, { amountKzt, method: method.data, idempotencyKey: idempotencyKey.data, ...(note ? { note } : {}) });
  } catch (error) {
    return detailError(id.data, error, { name: "paymentKey", value: idempotencyKey.data });
  }
  redirect(`/requests/${encodeURIComponent(id.data)}?notice=payment`);
}

export async function recordManualRefundAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const id = leadId.safeParse(formData.get("id"));
  const amountKzt = Number(str(formData, "amountKzt"));
  const method = paymentMethod.safeParse(str(formData, "method"));
  const reason = str(formData, "reason").trim();
  const refundDate = str(formData, "refundDate");
  const refundTime = str(formData, "refundTime");
  const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
  if (!unifiedFastapiCrmEnabled()) {
    if (id.success) return detailError(id.data, new FastApiCrmConfigurationError("crm_flag_disabled"));
    return failure(new ValidationError({ id: "bad" }));
  }
  if (!id.success || !Number.isInteger(amountKzt) || amountKzt <= 0 || amountKzt > 10_000_000 || !method.success || reason.length < 1 || reason.length > 300 || !isValidDate(refundDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(refundTime) || !idempotencyKey.success) {
    if (id.success) return detailError(id.data, new ValidationError({ refund: "invalid" }));
    return failure(new ValidationError({ id: "bad" }));
  }
  let refundedAt: string;
  try {
    const localInstant = new Date(`${refundDate}T${refundTime}:00Z`);
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Almaty", timeZoneName: "longOffset" })
      .formatToParts(localInstant)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!offset || !/^GMT(?:[+-]\d{2}:\d{2})?$/.test(offset)) throw new Error("Invalid Almaty offset");
    // The server may run in UTC, so interpret the form values in the branch time zone.
    refundedAt = new Date(`${refundDate}T${refundTime}:00${offset === "GMT" ? "Z" : offset.slice(3)}`).toISOString();
  } catch {
    return detailError(id.data, new ValidationError({ refund: "invalid" }));
  }
  try {
    const client = await fastApiClient(user);
    await client.recordManualRefundAndRead(id.data, {
      amountKzt,
      method: method.data,
      refundedAt,
      reason,
      idempotencyKey: idempotencyKey.data,
    });
  } catch (error) {
    return detailError(id.data, error, { name: "refundKey", value: idempotencyKey.data });
  }
  redirect(`/requests/${encodeURIComponent(id.data)}?notice=refund`);
}
