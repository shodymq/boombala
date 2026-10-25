"use server";

import { redirect } from "next/navigation";
import { ValidationError } from "../../../core/errors.ts";
import { changeOwnPassword } from "../../../core/users.ts";
import { requireUser } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

export async function changeOwnPasswordAction(formData: FormData): Promise<void> {
  const { user, sessionId } = await requireUser();
  const next = String(formData.get("next") ?? "");
  if (next !== String(formData.get("repeat") ?? "")) redirect("/account?error=mismatch");
  try {
    await changeOwnPassword(getPool(), { id: user.id, role: user.role }, String(formData.get("current") ?? ""), next, {
      keepSessionId: sessionId,
      ...(await requestMeta()),
    });
  } catch (error) {
    if (error instanceof ValidationError) redirect(`/account?error=${"currentPassword" in error.fields ? "current" : "weak"}`);
    throw error;
  }
  redirect("/account?notice=ok");
}
