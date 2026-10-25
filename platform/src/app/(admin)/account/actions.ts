"use server";

import { redirect } from "next/navigation";
import { ValidationError } from "../../../core/errors.ts";
import { revokePasskey } from "../../../core/passkeys.ts";
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

/** A person revokes one of their own keys (a lost or replaced device). Their current session stays. */
export async function revokeOwnPasskeyAction(formData: FormData): Promise<void> {
  const { user } = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect("/account?error=passkey");
  try {
    await revokePasskey(getPool(), { id: user.id, role: user.role }, id, await requestMeta());
  } catch {
    redirect("/account?error=passkey");
  }
  redirect("/account?notice=passkey_revoked");
}
