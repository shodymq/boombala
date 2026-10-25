import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./db.ts";
import { isRole, type Role } from "./rbac.ts";

/** Absolute lifetime and idle timeout of a staff session. */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;
/**
 * Idle timeout. 12 hours by default; a shared cash-desk tablet should use a short one (STAFF_SESSION_IDLE_MINUTES=30..60): with a passkey,
 * signing in again takes two taps. Values outside 5..720 minutes are ignored.
 */
const idleMinutes = Number(process.env.STAFF_SESSION_IDLE_MINUTES);
export const SESSION_IDLE_SECONDS = (Number.isInteger(idleMinutes) && idleMinutes >= 5 && idleMinutes <= 720 ? idleMinutes : 720) * 60;
/** A session at the "password accepted, second factor pending" step is useless for the admin and short-lived. */
export const PENDING_SESSION_SECONDS = 10 * 60;
/** `last_seen_at` is refreshed at most this often (saves a write on every request). */
const TOUCH_EVERY_SECONDS = 60;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  canExport: boolean;
}

export interface ValidSession {
  sessionId: string;
  user: SessionUser;
  /** Only filled when asked for (`withEnroll`): the Owner's one-time code was redeemed in this pending session. */
  enrollAuthorizedAt?: Date | null;
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Creates a session and returns the raw token (shown to the browser once, never stored). */
export async function createSession(
  db: Queryable,
  userId: string,
  meta: SessionMeta = {},
  state: "verified" | "pending" = "verified",
  /** `mfaVerified: true` only for the session issued right after the second factor was proven. */
  options: { mfaVerified?: boolean } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  // The column of migration 011 is named only when it is needed, so the application still works on a database that has
  // migrations up to 010 as long as the second factor is not mandatory (the current Preview).
  const withMfa = options.mfaVerified === true && state === "verified";
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO bb.sessions (token_hash, user_id, expires_at, ip, user_agent, mfa_state${withMfa ? ", mfa_verified_at" : ""})
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, $6${withMfa ? ", now()" : ""})
     RETURNING expires_at`,
    [hashToken(token), userId, state === "pending" ? PENDING_SESSION_SECONDS : SESSION_ABSOLUTE_SECONDS, meta.ip ?? null, meta.userAgent ? meta.userAgent.slice(0, 400) : null, state],
  );
  return { token, expiresAt: rows[0].expires_at };
}

export interface ValidateOptions {
  /** Which kind of session is wanted. The admin only ever accepts "verified"; the second-factor page accepts "pending". */
  state?: "verified" | "pending";
  /**
   * The second factor is mandatory: only a session that PASSED it (mfa_verified_at is set) is accepted. A session issued
   * earlier, without the factor, is refused even if its owner has enrolled since. Needs migration 011.
   */
  requireMfa?: boolean;
  /** Also read `enroll_authorized_at` (migration 014). Only the second-factor page and its actions ask for it. */
  withEnroll?: boolean;
}

/** Returns the user behind a token, or null when it is unknown, revoked, expired, idle too long or the user is disabled. */
export async function validateSession(db: Queryable, token: string | undefined, options: ValidateOptions = {}): Promise<ValidSession | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const { rows } = await db.query<{
    session_id: string;
    last_seen_at: Date;
    id: string;
    email: string;
    name: string;
    role: string;
    can_export: boolean;
    stale: boolean;
    enroll_authorized_at?: Date | null;
  }>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.name, u.role::text AS role, u.can_export,
            (s.last_seen_at < now() - make_interval(secs => $3)) AS stale${options.withEnroll ? ", s.enroll_authorized_at" : ""}
       FROM bb.sessions s JOIN bb.users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)
        AND u.is_active
        AND s.mfa_state = $4${options.requireMfa === true && (options.state ?? "verified") === "verified" ? "\n        AND s.mfa_verified_at IS NOT NULL" : ""}`,
    [hashToken(token), SESSION_IDLE_SECONDS, TOUCH_EVERY_SECONDS, options.state ?? "verified"],
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  if (row.stale) await db.query("UPDATE bb.sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);
  return {
    sessionId: row.session_id,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, canExport: row.can_export },
    ...(options.withEnroll ? { enrollAuthorizedAt: row.enroll_authorized_at ?? null } : {}),
  };
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query("UPDATE bb.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
}

/** Used after password/role changes and deactivation. `exceptSessionId` keeps the current device logged in. */
export async function revokeUserSessions(db: Queryable, userId: string, exceptSessionId?: string): Promise<number> {
  const res = await db.query(
    `UPDATE bb.sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
  return res.rowCount ?? 0;
}

/** Housekeeping: drops sessions that can never be valid again. */
export async function purgeExpiredSessions(db: Queryable): Promise<number> {
  const res = await db.query(
    "DELETE FROM bb.sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '30 days'",
  );
  return res.rowCount ?? 0;
}

/**
 * Ends every session that did not pass the second factor (the ones issued before it was mandatory). The admin already refuses
 * them (see requireMfa); this removes them for good and returns how many were ended. Run it when switching MFA_MODE to
 * `required` on a database that has been in use. Idempotent.
 */
export async function revokeSessionsWithoutMfa(db: Queryable): Promise<number> {
  const res = await db.query(
    "UPDATE bb.sessions SET revoked_at = now() WHERE revoked_at IS NULL AND mfa_state = 'verified' AND mfa_verified_at IS NULL",
  );
  return res.rowCount ?? 0;
}

/** Ends every open session of everyone (a full sign-out, e.g. after a suspected leak). Returns how many. */
export async function revokeAllSessions(db: Queryable): Promise<number> {
  const res = await db.query("UPDATE bb.sessions SET revoked_at = now() WHERE revoked_at IS NULL");
  return res.rowCount ?? 0;
}
