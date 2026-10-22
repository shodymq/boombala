import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { can, type Permission } from "../core/rbac.ts";
import { validateSession, type ValidSession } from "../core/session.ts";
import { getPool } from "./db.ts";
import { SESSION_COOKIE, mfaRequired } from "./env.ts";

/** The current staff session, or null. Verified against the database on every request (cached per request). */
export const getSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return validateSession(getPool(), token, { state: "verified", requireMfa: mfaRequired });
});

/** A session that passed the password but not yet the second factor. Only the second-factor page uses it. */
export const getPendingSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return validateSession(getPool(), token, { state: "pending" });
});

export async function requireUser(): Promise<ValidSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Server-side authorization. Call it in every page and every Server Action that reads or changes protected data:
 * hiding a button is not protection.
 */
export async function requirePermission(permission: Permission): Promise<ValidSession> {
  const session = await requireUser();
  if (!can(session.user.role, permission)) redirect("/");
  return session;
}
