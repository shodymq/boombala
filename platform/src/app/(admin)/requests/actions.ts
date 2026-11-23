"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { confirmLead, setLeadStatus } from "../../../core/bookings.ts";
import { claimLead, updateLeadWorkflow } from "../../../core/lead-workflow.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { FastApiCrmConfigurationError, unifiedFastapiCrmEnabled } from "../../../server/fastapi-crm.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { cookies } from "next/headers";
import { bridgeRpc, LegacyBridgeError, legacyBridgeEnabled } from "../../../server/bridge-client.ts";
import { SESSION_COOKIE } from "../../../server/env.ts";
import type { LeadWorkflowFormState } from "./workflow-action-form.tsx";

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

function workflowFailure(error: unknown, leadId: string): never {
  const remoteCode = error instanceof LegacyBridgeError ? error.code : undefined;
  const code = remoteCode ?? (
    error instanceof ConflictError ? error.message
      : error instanceof ValidationError ? "invalid"
        : error instanceof ForbiddenError ? "forbidden"
          : error instanceof FastApiCrmConfigurationError ? "fastapi_unavailable"
            : "failed"
  );
  redirect(`/requests/${encodeURIComponent(leadId)}?error=${encodeURIComponent(code)}`);
}

export async function updateLeadWorkflowAction(_previous: LeadWorkflowFormState, formData: FormData): Promise<LeadWorkflowFormState> {
  const { user } = await requirePermission("requests.manage");
  if (unifiedFastapiCrmEnabled() && !legacyBridgeEnabled()) return { errorCode: "fastapi_unavailable" };
  const leadId = uuid.safeParse(formData.get("id"));
  const expectedVersion = Number(str(formData, "expectedVersion"));
  if (!leadId.success) return { errorCode: "invalid" };
  const input = {
    leadId: leadId.data,
    expectedVersion,
    assignedTo: str(formData, "assignedTo") || null,
    nextAction: str(formData, "nextAction") || null,
    followUpAtLocal: str(formData, "followUpAtLocal") || null,
    managerAgreement: str(formData, "managerAgreement"),
  };
  try {
    if (legacyBridgeEnabled()) {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!token) return { errorCode: "fastapi_unavailable" };
      await bridgeRpc("requests.workflow.update", input, token);
    } else {
      await updateLeadWorkflow(getPool(), { id: user.id, role: user.role }, input, await requestMeta());
    }
  } catch (error) {
    const remoteCode = error instanceof LegacyBridgeError ? error.code : undefined;
    const code = remoteCode ?? (
      error instanceof ConflictError ? error.message
        : error instanceof ValidationError ? "invalid"
          : error instanceof ForbiddenError ? "forbidden"
            : error instanceof FastApiCrmConfigurationError ? "fastapi_unavailable"
              : "failed"
    );
    return { errorCode: code };
  }
  redirect(`/requests/${encodeURIComponent(leadId.data)}?notice=workflow`);
}

export async function claimLeadAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("requests.manage");
  if (unifiedFastapiCrmEnabled() && !legacyBridgeEnabled()) return workflowFailure(new FastApiCrmConfigurationError("crm_actor_missing"), str(formData, "id"));
  const leadId = uuid.safeParse(formData.get("id"));
  const expectedVersion = Number(str(formData, "expectedVersion"));
  if (!leadId.success) return workflowFailure(new ValidationError({ id: "invalid" }), "invalid");
  const input = { leadId: leadId.data, expectedVersion };
  try {
    if (legacyBridgeEnabled()) {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!token) return workflowFailure(new FastApiCrmConfigurationError("crm_actor_missing"), leadId.data);
      await bridgeRpc("requests.workflow.claim", input, token);
    } else {
      await claimLead(getPool(), { id: user.id, role: user.role }, input, await requestMeta());
    }
  } catch (error) {
    return workflowFailure(error, leadId.data);
  }
  redirect(`/requests/${encodeURIComponent(leadId.data)}?notice=claimed`);
}
