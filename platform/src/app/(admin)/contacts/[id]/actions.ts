"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../core/errors.ts";
import { anonymizeContact, revokeConsent } from "../../../../core/privacy.ts";
import { requirePermission } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";
import { requestMeta } from "../../../../server/request.ts";

const uuid = z.string().uuid();

async function run(formData: FormData, fn: (actor: { id: string; role: "owner" | "manager" | "editor" }, id: string, meta: Awaited<ReturnType<typeof requestMeta>>) => Promise<unknown>, notice: string): Promise<void> {
  const { user } = await requirePermission("privacy.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) redirect("/contacts");
  let code = "";
  try {
    await fn({ id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    if (error instanceof NotFoundError) redirect("/contacts");
    code = error instanceof ForbiddenError ? "forbidden" : error instanceof ConflictError ? "blocked" : "failed";
  }
  redirect(`/contacts/${id.data}?${code ? `error=${code}` : `notice=${notice}`}`);
}

export async function revokeConsentAction(formData: FormData): Promise<void> {
  return run(formData, (actor, id, meta) => revokeConsent(getPool(), actor, id, meta), "revoked");
}

export async function anonymizeContactAction(formData: FormData): Promise<void> {
  return run(formData, (actor, id, meta) => anonymizeContact(getPool(), actor, id, meta), "anonymized");
}
