import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./db.ts";
import { isRole, type Role } from "./rbac.ts";

/** Absolute lifetime and idle timeout of a staff session. */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;
export const SESSION_IDLE_SECONDS = 12 * 3600;
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
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO bb.sessions (token_hash, user_id, expires_at, ip, user_agent, mfa_state)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, $6)
     RETURNING expires_at`,
    [hashToken(token), userId, state === "pending" ? PENDING_SESSION_SECONDS : SESSION_ABSOLUTE_SECONDS, meta.ip ?? null, meta.userAgent ? meta.userAgent.slice(0, 400) : null, state],
  );
  return { token, expiresAt: rows[0].expires_at };
}

export interface ValidateOptions {
  /** Which kind of session is wanted. The admin only ever accepts "verified"; the second-factor page accepts "pending". */
  state?: "verified" | "pending";
  /** When the second factor is mandatory: a verified session of a user without an enrolled factor is refused (it predates the policy). */
  requireEnrolled?: boolean;
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
  }>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.name, u.role::text AS role, u.can_export,
            (s.last_seen_at < now() - make_interval(secs => $3)) AS stale
       FROM bb.sessions s JOIN bb.users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)
        AND u.is_active
        AND s.mfa_state = $4
        AND ($5::boolean = false OR s.mfa_state = 'pending' OR EXISTS (SELECT 1 FROM bb.user_mfa m WHERE m.user_id = u.id AND m.enrolled_at IS NOT NULL))`,
    [hashToken(token), SESSION_IDLE_SECONDS, TOUCH_EVERY_SECONDS, options.state ?? "verified", options.requireEnrolled === true],
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  if (row.stale) await db.query("UPDATE bb.sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);
  return { sessionId: row.session_id, user: { id: row.id, email: row.email, name: row.name, role: row.role, canExport: row.can_export } };
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
