import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { can, type Permission } from "../core/rbac.ts";
import { validateSession, type ValidSession } from "../core/session.ts";
import { getPool } from "./db.ts";
import { SESSION_COOKIE, mfaRequired } from "./env.ts";
import { bridgeSession, legacyBridgeEnabled } from "./bridge-client.ts";

/** The current staff session, or null. Verified against the database on every request (cached per request). */
export const getSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (legacyBridgeEnabled()) return bridgeSession(token, "verified");
  return validateSession(getPool(), token, { state: "verified", requireMfa: mfaRequired });
});

/** A session that passed the password but not yet the second factor. Only the second-factor page uses it. */
export const getPendingSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (legacyBridgeEnabled()) return bridgeSession(token, "pending");
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

/**
 * Verifies the session and, in bridge mode, reads the page data AT THE SAME TIME. Each bridge round trip crosses the network to
 * the VPS, so waiting for the session before starting the data read doubled the latency of every page.
 *
 * This is safe because every bridge operation validates the session and checks the role on the VPS by itself: the data read is
 * authorized independently, and if the session or permission here is refused, the redirect wins and the data is discarded.
 * Outside bridge mode `data` is null and the page reads the database as before, after the session check.
 */
export async function requirePermissionAnd<T>(permission: Permission, load: () => Promise<T>): Promise<{ session: ValidSession; data: T | null }> {
  const sessionPromise = requirePermission(permission);
  const dataPromise = legacyBridgeEnabled() ? load() : null;
  // A refused session redirects first; the unused read must not surface as an unhandled rejection.
  dataPromise?.catch(() => undefined);
  const session = await sessionPromise;
  return { session, data: dataPromise ? await dataPromise : null };
}
