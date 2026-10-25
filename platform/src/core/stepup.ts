import type { Pool, Queryable } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { lockedFor } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";
import { verifySecondFactor } from "./mfa.ts";
import { validateSession } from "./session.ts";

/**
 * Step-up authentication. A sensitive action (add or revoke a passkey, revoke all of a person's keys, issue an enrolment code) needs a FRESH
 * proof of identity: a current authenticator code / recovery code, or a passkey assertion made now. An active cookie is not enough, so a
 * hijacked session cannot enrol an attacker's device.
 *
 * A grant is bound to the person, to THIS session and to ONE purpose; it lapses after five minutes and is consumed by the action it was
 * given for (it works once). The check happens on the server, inside the action.
 */

export const STEPUP_SECONDS = 5 * 60;
export const STEPUP_PURPOSES = ["passkey_register", "passkey_revoke", "passkeys_revoke_all", "enrollment_code"] as const;
export type StepUpPurpose = (typeof STEPUP_PURPOSES)[number];
export const isStepUpPurpose = (v: unknown): v is StepUpPurpose => typeof v === "string" && (STEPUP_PURPOSES as readonly string[]).includes(v);

export async function grantStepUp(db: Queryable, input: { userId: string; sessionId: string; purpose: StepUpPurpose; method: "totp" | "recovery" | "passkey" }): Promise<void> {
  await db.query("DELETE FROM bb.step_up_grants WHERE session_id = $1 AND purpose = $2", [input.sessionId, input.purpose]);
  await db.query("DELETE FROM bb.step_up_grants WHERE expires_at < now()");
  await db.query(
    "INSERT INTO bb.step_up_grants (user_id, session_id, purpose, method, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    [input.userId, input.sessionId, input.purpose, input.method, STEPUP_SECONDS],
  );
}

/** True when a live grant exists (it is NOT consumed). Used to refuse early, before expensive work. */
export async function hasStepUp(db: Queryable, userId: string, sessionId: string, purpose: StepUpPurpose): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM bb.step_up_grants WHERE user_id = $1 AND session_id = $2 AND purpose = $3 AND expires_at > now()", [userId, sessionId, purpose]);
  return rows.length > 0;
}

/** Consumes the grant, atomically: two parallel requests cannot both use it. Throws when there is none. */
export async function consumeStepUp(db: Queryable, userId: string, sessionId: string, purpose: StepUpPurpose): Promise<void> {
  const { rows } = await db.query("DELETE FROM bb.step_up_grants WHERE user_id = $1 AND session_id = $2 AND purpose = $3 AND expires_at > now() RETURNING id", [userId, sessionId, purpose]);
  if (rows.length === 0) throw new ForbiddenError("step_up_required");
}

export type StepUpResult = { ok: true; method: "totp" | "recovery" } | { ok: false; reason: "invalid" | "expired" } | { ok: false; reason: "locked"; retryAfterSeconds: number };

/** Step-up with a code from the authenticator app or a recovery code. Wrong codes count in the same throttle as wrong passwords. */
export async function stepUpWithCode(
  pool: Pool,
  input: { sessionToken: string | undefined; purpose: StepUpPurpose; code: string; mfaKey: string | undefined; requireMfa: boolean; ip?: string | null; userAgent?: string | null },
): Promise<StepUpResult> {
  const session = await validateSession(pool, input.sessionToken, { state: "verified", requireMfa: input.requireMfa });
  if (!session) return { ok: false, reason: "expired" };
  const ip = (input.ip ?? "unknown").slice(0, 64);
  const wait = await lockedFor(pool, session.user.email, ip);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterSeconds: wait };
  const meta = { ip, userAgent: input.userAgent };
  const method = await verifySecondFactor(pool, session.user.id, input.code.slice(0, 40), input.mfaKey, meta);
  if (!method) {
    await pool.query("INSERT INTO bb.login_attempts (email_norm, ip, success) VALUES ($1, $2, false)", [session.user.email, ip]);
    await writeAudit(pool, { actorUserId: session.user.id, action: "auth.stepup_failed", entityType: "user", entityId: session.user.id, after: { purpose: input.purpose }, ...meta });
    return { ok: false, reason: "invalid" };
  }
  await grantStepUp(pool, { userId: session.user.id, sessionId: session.sessionId, purpose: input.purpose, method });
  await writeAudit(pool, { actorUserId: session.user.id, action: "auth.stepup", entityType: "user", entityId: session.user.id, after: { purpose: input.purpose, method }, ...meta });
  return { ok: true, method };
}
