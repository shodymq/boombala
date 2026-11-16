"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { confirmLead, setLeadStatus } from "../../../core/bookings.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { FastApiCrmConfigurationError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { cookies } from "next/headers";
import { bridgeRpc, legacyBridgeEnabled } from "../../../server/bridge-client.ts";
import { SESSION_COOKIE } from "../../../server/env.ts";

const uuid = z.string().uuid();
const str = (f: FormData, k: string) => String(f.get(k) ?? "");

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
  if (unifiedFastapiCrmEnabled() && !legacyBridgeEnabled()) return failure(new FastApiCrmConfigurationError("crm_actor_missing"));
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  let date = "";
  try {
    date = str(formData, "date");
    if (legacyBridgeEnabled()) {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!token) return failure(new FastApiCrmConfigurationError("crm_actor_missing"));
      await bridgeRpc("requests.confirm", { id: id.data, date, slotId: Number(str(formData, "slotId")) || undefined, roomId: str(formData, "roomId") || undefined, packageId: str(formData, "packageId") || undefined }, token);
    } else {
      await confirmLead(getPool(), { id: user.id, role: user.role }, { leadId: id.data, date, slotId: Number(str(formData, "slotId")) || undefined, roomId: str(formData, "roomId") || undefined, packageId: str(formData, "packageId") || undefined }, await requestMeta());
    }
  } catch (error) {
    return failure(error);
  }
  redirect(`/bookings?date=${date}&notice=booked`);
}

export async function leadStatusAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("requests.manage");
  if (unifiedFastapiCrmEnabled() && !legacyBridgeEnabled()) return failure(new FastApiCrmConfigurationError("crm_actor_missing"));
  const id = uuid.safeParse(formData.get("id"));
  const status = str(formData, "status");
  if (!id.success || !["new", "in_progress", "cancelled"].includes(status)) return failure(new ValidationError({ id: "bad" }));
  try {
    if (legacyBridgeEnabled()) {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!token) return failure(new FastApiCrmConfigurationError("crm_actor_missing"));
      await bridgeRpc("requests.status", { id: id.data, status }, token);
    } else await setLeadStatus(getPool(), { id: user.id, role: user.role }, id.data, status as "new" | "in_progress" | "cancelled", await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/requests?notice=status");
}
