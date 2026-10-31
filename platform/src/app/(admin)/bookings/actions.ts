"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createBlock, createManualBooking, releaseReservation } from "../../../core/bookings.ts";
import { isValidDate } from "../../../core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { canRetryWithSameIdempotencyKey, FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { fastApiActorForStaff } from "../../../server/fastapi-staff.ts";

const uuid = z.string().uuid();
const str = (f: FormData, k: string) => String(f.get(k) ?? "");

function back(date: string, query: string): never {
  redirect(`/bookings?date=${isValidDate(date) ? date : ""}&${query}`);
}

/** Only fixed codes travel in the URL; the page shows fixed texts. */
function failure(date: string, error: unknown, retryKey?: { name: string; value: string; action?: string; target?: string }): never {
  let code = "failed";
  if (error instanceof ConflictError) code = error.message === "slot_taken" ? "slot_taken" : "conflict";
  else if (error instanceof ValidationError) code = "invalid";
  else if (error instanceof ForbiddenError) code = "forbidden";
  else if (error instanceof FastApiCrmConfigurationError) code = "fastapi_unavailable";
  else if (error instanceof FastApiCrmError) code = error.status === 403 ? "forbidden" : error.status === 409 ? ["time_conflict", "slot_taken"].includes(error.code) ? "slot_taken" : "conflict" : error.status >= 500 ? "fastapi_unavailable" : "invalid";
  const keepKey = retryKey && canRetryWithSameIdempotencyKey(error);
  const params = new URLSearchParams({ error: code });
  if (keepKey) {
    params.set(retryKey.name, retryKey.value);
    if (retryKey.action && retryKey.target) {
      params.set("retryAction", retryKey.action);
      params.set("retryTarget", retryKey.target);
    }
  }
  return back(date, params.toString());
}

async function fastApiClient(user: { id: string; email: string }) {
  const requestId = randomUUID();
  const actor = await fastApiActorForStaff(user, { requestId });
  return new FastApiCrmClient(actor);
}

export async function manualBookingAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  const requestedDate = str(formData, "requestedDate");
  if (unifiedFastapiCrmEnabled()) {
    const branchId = z.string().min(1).max(32).safeParse(formData.get("branchId"));
    const packageId = z.string().min(1).max(32).safeParse(formData.get("packageId"));
    const name = z.string().trim().min(1).max(120).safeParse(formData.get("name"));
    const phone = z.string().trim().min(7).max(20).regex(/^\+?[0-9 ()-]{7,20}$/).safeParse(formData.get("phone"));
    const childrenText = str(formData, "children").trim();
    const children = childrenText ? z.coerce.number().int().min(0).max(500).safeParse(childrenText) : null;
    const note = str(formData, "note").trim();
    const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
    if (!isValidDate(date) || !isValidDate(requestedDate) || !branchId.success || !packageId.success || !name.success || !phone.success || (childrenText && !children?.success) || note.length > 300 || !idempotencyKey.success) {
      return failure(date, new ValidationError({ request: "invalid" }));
    }
    let requestId = "";
    try {
      const client = await fastApiClient(user);
      const request = await client.createStaffBirthdayRequest({
        branchId: branchId.data,
        packageId: packageId.data,
        customerName: name.data,
        phone: phone.data,
        guestCount: children?.success ? children.data : null,
        requestedDate,
        notes: note || null,
        idempotencyKey: idempotencyKey.data,
      });
      requestId = request.id;
    } catch (error) {
      return failure(date, error, { name: "requestKey", value: idempotencyKey.data });
    }
    redirect(`/requests/${encodeURIComponent(requestId)}?notice=created`);
  }
  try {
    const children = str(formData, "children").trim();
    await createManualBooking(
      getPool(),
      { id: user.id, role: user.role },
      {
        date,
        slotId: Number(str(formData, "slotId")),
        roomId: str(formData, "roomId"),
        packageId: str(formData, "packageId"),
        name: str(formData, "name"),
        phone: str(formData, "phone"),
        children: children ? Number(children) : null,
        note: str(formData, "note"),
      },
      await requestMeta(),
    );
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=booked");
}

export async function blockAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  if (unifiedFastapiCrmEnabled()) {
    const branchId = z.string().min(1).max(32).safeParse(formData.get("branchId"));
    const roomId = z.string().min(1).max(32).safeParse(formData.get("roomId"));
    const startTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).safeParse(formData.get("startTime"));
    const reason = z.string().trim().min(1).max(300).safeParse(formData.get("reason"));
    const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
    if (!isValidDate(date) || !branchId.success || !roomId.success || !startTime.success || !reason.success || !idempotencyKey.success) {
      return failure(date, new ValidationError({ block: "invalid" }));
    }
    try {
      const client = await fastApiClient(user);
      await client.blockBookingSlotAndRead({ branchId: branchId.data, bookingDate: date, roomId: roomId.data, startTime: startTime.data, reason: reason.data, idempotencyKey: idempotencyKey.data });
    } catch (error) {
      return failure(date, error, { name: "blockKey", value: idempotencyKey.data, action: "block", target: roomId.data });
    }
    return back(date, "notice=blocked");
  }
  try {
    await createBlock(getPool(), { id: user.id, role: user.role }, { date, slotId: Number(str(formData, "slotId")), roomId: str(formData, "roomId"), note: str(formData, "note") }, await requestMeta());
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=blocked");
}

export async function releaseAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  if (unifiedFastapiCrmEnabled()) {
    const branchId = z.string().min(1).max(32).safeParse(formData.get("branchId"));
    const id = z.string().min(1).max(32).safeParse(formData.get("id"));
    const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
    const reason = z.string().trim().min(1).max(300).safeParse(formData.get("reason"));
    if (!isValidDate(date) || !branchId.success || !id.success || !idempotencyKey.success || !reason.success) {
      return failure(date, new ValidationError({ release: "invalid" }));
    }
    try {
      const client = await fastApiClient(user);
      await client.releaseReservationAndRead(id.data, branchId.data, date, { idempotencyKey: idempotencyKey.data, reason: reason.data });
    } catch (error) {
      return failure(date, error, { name: "releaseKey", value: idempotencyKey.data, action: "release", target: id.data });
    }
    return back(date, "notice=released");
  }
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(date, new ValidationError({ id: "bad" }));
  try {
    await releaseReservation(getPool(), { id: user.id, role: user.role }, id.data, str(formData, "reason"), await requestMeta());
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=released");
}

export async function rescheduleAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  if (!unifiedFastapiCrmEnabled()) return failure(date, new FastApiCrmConfigurationError("crm_flag_disabled"));
  const id = z.string().min(1).max(32).safeParse(formData.get("id"));
  const branchId = z.string().min(1).max(32).safeParse(formData.get("branchId"));
  const bookingDate = str(formData, "bookingDate");
  const startTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).safeParse(formData.get("startTime"));
  const roomId = z.string().min(1).max(32).safeParse(formData.get("roomId"));
  const idempotencyKey = uuid.safeParse(formData.get("idempotencyKey"));
  if (!isValidDate(date) || !isValidDate(bookingDate) || !id.success || !branchId.success || !startTime.success || !roomId.success || !idempotencyKey.success) {
    return failure(date, new ValidationError({ reschedule: "invalid" }));
  }
  try {
    const client = await fastApiClient(user);
    await client.rescheduleReservationAndRead(id.data, branchId.data, { bookingDate, startTime: startTime.data, roomId: roomId.data, idempotencyKey: idempotencyKey.data });
  } catch (error) {
    return failure(date, error, { name: "rescheduleKey", value: idempotencyKey.data, action: "reschedule", target: id.data });
  }
  return back(bookingDate, "notice=rescheduled");
}
