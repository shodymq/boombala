"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ValidationError } from "../../../core/errors.ts";
import { changeOwnPassword } from "../../../core/users.ts";
import { requireUser } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";
import { bridgeRpc, legacyBridgeEnabled } from "../../../server/bridge-client.ts";
import { SESSION_COOKIE } from "../../../server/env.ts";

export async function changeOwnPasswordAction(formData: FormData): Promise<void> {
  const { user, sessionId } = await requireUser();
  const next = String(formData.get("next") ?? "");
  if (next !== String(formData.get("repeat") ?? "")) redirect("/account?error=mismatch");
  try {
    const current = String(formData.get("current") ?? "");
    if (legacyBridgeEnabled()) {
      const token = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!token) redirect("/login");
      await bridgeRpc("users.passwordSelf", { currentPassword: current, newPassword: next }, token);
    } else {
      await changeOwnPassword(getPool(), { id: user.id, role: user.role }, current, next, { keepSessionId: sessionId, ...(await requestMeta()) });
    }
  } catch (error) {
    if (error instanceof ValidationError) redirect(`/account?error=${"currentPassword" in error.fields ? "current" : "weak"}`);
    throw error;
  }
  redirect("/account?notice=ok");
}
