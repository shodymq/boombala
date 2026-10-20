import type { Pool } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { dummyVerify, verifyPassword } from "./password.ts";
import { createSession } from "./session.ts";

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 30;

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; userId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

export interface LoginInput {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Seconds until the oldest counted failure leaves the window, when the limit is already reached; otherwise 0. */
async function lockedFor(pool: Pool, emailNorm: string, ip: string): Promise<number> {
  const { rows } = await pool.query<{ by_email: number; by_ip: number; wait_email: number | null; wait_ip: number | null }>(
    `SELECT
       count(*) FILTER (WHERE email_norm = $1)::int AS by_email,
       count(*) FILTER (WHERE ip = $2)::int AS by_ip,
       ceil(extract(epoch FROM (min(at) FILTER (WHERE email_norm = $1) + make_interval(secs => $3) - now())))::int AS wait_email,
       ceil(extract(epoch FROM (min(at) FILTER (WHERE ip = $2) + make_interval(secs => $3) - now())))::int AS wait_ip
       FROM bb.login_attempts
      WHERE success = false AND at > now() - make_interval(secs => $3) AND (email_norm = $1 OR ip = $2)`,
    [emailNorm, ip, LOGIN_WINDOW_SECONDS],
  );
  const r = rows[0];
  if (r.by_email >= MAX_FAILURES_PER_EMAIL) return Math.max(1, r.wait_email ?? LOGIN_WINDOW_SECONDS);
  if (r.by_ip >= MAX_FAILURES_PER_IP) return Math.max(1, r.wait_ip ?? LOGIN_WINDOW_SECONDS);
  return 0;
}

/**
 * Email + password login with throttling. Unknown e-mail, wrong password and disabled account all return the
 * same "invalid" and cost the same time. Attempts made while locked are not counted (the lock does not extend).
 */
export async function authenticate(pool: Pool, input: LoginInput): Promise<LoginResult> {
  const emailNorm = normalizeEmail(input.email).slice(0, 254);
  const ip = (input.ip ?? "unknown").slice(0, 64);

  const wait = await lockedFor(pool, emailNorm, ip);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterSeconds: wait };

  const { rows } = await pool.query<{ id: string; password_hash: string; is_active: boolean }>(
    "SELECT id, password_hash, is_active FROM bb.users WHERE email = $1",
    [emailNorm],
  );
  const user = rows[0];
  const passwordOk = user ? await verifyPassword(user.password_hash, input.password) : (await dummyVerify(input.password), false);

  if (!user || !user.is_active || !passwordOk) {
    await pool.query("INSERT INTO bb.login_attempts (email_norm, ip, success) VALUES ($1, $2, false)", [emailNorm, ip]);
    await writeAudit(pool, {
      actorUserId: user?.id ?? null,
      action: "auth.login_failed",
      entityType: "user",
      entityId: user?.id,
      after: { email: emailNorm },
      ip,
      userAgent: input.userAgent,
    });
    return { ok: false, reason: "invalid" };
  }

  return withTx(pool, async (tx) => {
    const session = await createSession(tx, user.id, { ip, userAgent: input.userAgent });
    await tx.query("UPDATE bb.users SET last_login_at = now() WHERE id = $1", [user.id]);
    // A successful login clears the failure counter for this e-mail.
    await tx.query("DELETE FROM bb.login_attempts WHERE email_norm = $1 AND success = false", [emailNorm]);
    await writeAudit(tx, { actorUserId: user.id, action: "auth.login", entityType: "user", entityId: user.id, ip, userAgent: input.userAgent });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, userId: user.id };
  });
}

/** Housekeeping for the throttling table. */
export async function purgeOldLoginAttempts(pool: Pool): Promise<number> {
  const res = await pool.query("DELETE FROM bb.login_attempts WHERE at < now() - interval '2 days'");
  return res.rowCount ?? 0;
}
