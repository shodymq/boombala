"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { birthdayStartTimes, hasBirthdayDuration } from "../../../core/birthday-booking-time.ts";
import { isValidDate } from "../../../core/dates.ts";
import { ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { FastApiCrmClient, FastApiCrmConfigurationError, FastApiCrmError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { fastApiActorForStaff } from "../../../server/fastapi-staff.ts";
import { requirePermission } from "../../../server/dal.ts";

const uuid = z.string().uuid();
const str = (f: FormData, k: string) => String(f.get(k) ?? "");

function back(date: string, query: string): never {
  redirect(`/bookings?date=${isValidDate(date) ? date : ""}&${query}`);
}

/** Only fixed codes travel in the URL; the page shows fixed texts. */
function failure(date: string, error: unknown): never {
  let code = "failed";
  if (error instanceof ValidationError) code = "invalid";
  else if (error instanceof ForbiddenError) code = "forbidden";
  else if (error instanceof FastApiCrmConfigurationError) code = "fastapi_unavailable";
  else if (error instanceof FastApiCrmError) {
    code = error.status === 403 ? "forbidden" : error.code === "booking_buffer_required" ? "buffer_required" : error.code === "slot_taken" ? "slot_taken" : error.status === 409 ? "conflict" : error.status === 422 ? "invalid" : "fastapi_unavailable";
  }
  return back(date, `error=${code}`);
}

async function fastApiClient(staff: { id: string; email: string }): Promise<FastApiCrmClient> {
  const requestId = randomUUID();
  return new FastApiCrmClient(await fastApiActorForStaff(staff, { requestId }));
}

export async function blockAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  if (!unifiedFastapiCrmEnabled()) return failure(date, new FastApiCrmConfigurationError("crm_flag_disabled"));
  const input = z.object({
    date: z.string().refine(isValidDate),
    branchId: z.string().min(1).max(32),
    roomId: z.string().min(1).max(32),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):00$/),
    reason: z.string().trim().min(1).max(300),
    idempotencyKey: uuid,
  }).safeParse({
    date,
    branchId: str(formData, "branchId"),
    roomId: str(formData, "roomId"),
    startTime: str(formData, "startTime"),
    reason: str(formData, "reason"),
    idempotencyKey: str(formData, "idempotencyKey"),
  });
  if (!input.success) return failure(date, new ValidationError({ block: "invalid" }));
  try {
    const client = await fastApiClient(user);
    const catalog = await client.getBookingCatalog();
    const branch = catalog.branches.length === 1 ? catalog.branches[0] : null;
    const rooms = catalog.rooms.filter((room) => room.branchId === branch?.id);
    if (!branch || rooms.length !== 4 || branch.id !== input.data.branchId || !rooms.some((room) => room.id === input.data.roomId)) {
      return back(date, "error=fastapi_unavailable");
    }
    if (branch.bufferMinutes !== 0) return back(date, "error=buffer_required");
    if (!birthdayStartTimes(branch.workingHours).includes(input.data.startTime)) return back(date, "error=invalid");
    const reservation = await client.blockBirthdaySlot({
      branchId: branch.id,
      bookingDate: input.data.date,
      roomId: input.data.roomId,
      startTime: input.data.startTime,
      reason: input.data.reason,
      idempotencyKey: input.data.idempotencyKey,
    });
    if (
      reservation.kind !== "block" ||
      reservation.status !== "blocked" ||
      reservation.bookingDate !== input.data.date ||
      reservation.roomId !== input.data.roomId ||
      !reservation.startsAt?.startsWith(`${input.data.date}T${input.data.startTime}`) ||
      !hasBirthdayDuration(reservation.startsAt, reservation.endsAt)
    ) {
      throw new FastApiCrmError(502, "block_response_mismatch", "crm-action");
    }
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=blocked");
}

export async function releaseAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
  if (!unifiedFastapiCrmEnabled()) return failure(date, new FastApiCrmConfigurationError("crm_flag_disabled"));
  const input = z.object({
    id: z.string().min(1).max(32),
    reason: z.string().trim().min(1).max(300),
    idempotencyKey: uuid,
  }).safeParse({
    id: str(formData, "id"),
    reason: str(formData, "reason"),
    idempotencyKey: str(formData, "idempotencyKey"),
  });
  if (!input.success) return failure(date, new ValidationError({ reservation: "invalid" }));
  try {
    const client = await fastApiClient(user);
    await client.releaseReservation(input.data.id, { idempotencyKey: input.data.idempotencyKey, reason: input.data.reason });
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=released");
}
