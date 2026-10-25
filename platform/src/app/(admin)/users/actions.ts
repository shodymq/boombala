"use server";

import { revokeAllPasskeys } from "../../../core/passkeys.ts";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { resetUserMfa } from "../../../core/mfa.ts";
import { isRole } from "../../../core/rbac.ts";
import { changeRole, createUser, setActive, setCanExport, setPassword } from "../../../core/users.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

const uuid = z.string().uuid();

/** Maps domain errors to a short code shown on the page. Nothing else (no SQL, no stack) leaves the server. */
function failure(error: unknown): never {
  let code = "failed";
  if (error instanceof ValidationError) code = `invalid_${Object.keys(error.fields)[0] ?? "form"}`.replace(/[^a-z_]/gi, "");
  else if (error instanceof ConflictError) code = error.message === "last_owner" ? "last_owner" : "email_taken";
  else if (error instanceof ForbiddenError) code = "forbidden";
  redirect(`/users?error=${encodeURIComponent(code)}`);
}

export async function createUserAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const role = String(formData.get("role") ?? "");
  if (!isRole(role)) return failure(new ValidationError({ role: "Неизвестная роль" }));
  try {
    await createUser(
      getPool(),
      { id: user.id, role: user.role },
      { email: String(formData.get("email") ?? ""), name: String(formData.get("name") ?? ""), role, password: String(formData.get("password") ?? "") },
      await requestMeta(),
    );
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=created");
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  const role = String(formData.get("role") ?? "");
  if (!id.success || !isRole(role)) return failure(new ValidationError({ role: "Некорректные данные" }));
  try {
    await changeRole(getPool(), { id: user.id, role: user.role }, id.data, role, await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=role");
}

export async function setActiveAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ user: "Некорректные данные" }));
  try {
    await setActive(getPool(), { id: user.id, role: user.role }, id.data, formData.get("active") === "1", await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=active");
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ user: "Некорректные данные" }));
  try {
    await setPassword(getPool(), { id: user.id, role: user.role }, id.data, String(formData.get("password") ?? ""), await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=password");
}

export async function setCanExportAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ user: "Некорректные данные" }));
  try {
    await setCanExport(getPool(), { id: user.id, role: user.role }, id.data, formData.get("allowed") === "1", await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=export");
}

export async function resetMfaAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "Некорректные данные" }));
  try {
    await resetUserMfa(getPool(), { id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=mfa");
}

/** The Owner revokes every Face ID / Touch ID key of a person (lost phone, leaver) and ends their sessions. */
export async function revokeUserPasskeysAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("users.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "Некорректные данные" }));
  try {
    await revokeAllPasskeys(getPool(), { id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/users?notice=passkeys");
}
