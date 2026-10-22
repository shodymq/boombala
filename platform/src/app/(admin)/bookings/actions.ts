"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createBlock, createManualBooking, releaseReservation } from "../../../core/bookings.ts";
import { isValidDate } from "../../../core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

const uuid = z.string().uuid();
const str = (f: FormData, k: string) => String(f.get(k) ?? "");

function back(date: string, query: string): never {
  redirect(`/bookings?date=${isValidDate(date) ? date : ""}&${query}`);
}

/** Only fixed codes travel in the URL; the page shows fixed texts. */
function failure(date: string, error: unknown): never {
  let code = "failed";
  if (error instanceof ConflictError) code = error.message === "slot_taken" ? "slot_taken" : "conflict";
  else if (error instanceof ValidationError) code = "invalid";
  else if (error instanceof ForbiddenError) code = "forbidden";
  return back(date, `error=${code}`);
}

export async function manualBookingAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("bookings.manage");
  const date = str(formData, "date");
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
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(date, new ValidationError({ id: "bad" }));
  try {
    await releaseReservation(getPool(), { id: user.id, role: user.role }, id.data, str(formData, "reason"), await requestMeta());
  } catch (error) {
    return failure(date, error);
  }
  return back(date, "notice=released");
}
