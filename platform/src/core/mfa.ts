import { createHash } from "node:crypto";
import type { Client, Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";
import { revokeUserSessions } from "./session.ts";
import { generateRecoveryCode, generateSecret, matchTotp, normalizeRecoveryCode, openSecret, otpauthUri, parseKey, sealSecret } from "./totp.ts";

/**
 * Second factor for staff. Policy (whether it is required) lives in the server layer (MFA_MODE); this module only
 * enrols, verifies and resets. Every failure is reported the same way: "invalid".
 */

export const RECOVERY_CODE_COUNT = 10;

export interface AuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const hashCode = (normalized: string) => createHash("sha256").update(`bb-recovery:${normalized}`).digest();

export async function isEnrolled(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NOT NULL", [userId]);
  return rows.length > 0;
}

export interface Enrollment {
  secret: string;
  otpauth: string;
}

/**
 * Starts enrolment, or returns the pending one: a secret that is not active until a code from it is confirmed. The
 * same secret is shown on every visit until it is confirmed (a refresh must not invalidate the phone's entry).
 * Refused when the user is already enrolled (a reset by the Owner is the only way to change a second factor).
 */
export async function beginEnrollment(pool: Pool, userId: string, key: string | undefined): Promise<Enrollment> {
  const k = parseKey(key);
  return withTx(pool, async (tx) => {
    const user = await tx.query<{ email: string }>("SELECT email FROM bb.users WHERE id = $1 AND is_active FOR UPDATE", [userId]);
    if (!user.rows[0]) throw new NotFoundError();
    if (await isEnrolled(tx, userId)) throw new ConflictError("already_enrolled");
    const pending = await tx.query<{ secret_enc: string }>("SELECT secret_enc FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NULL", [userId]);
    let secret: string;
    if (pending.rows[0]) {
      secret = openSecret(pending.rows[0].secret_enc, k);
    } else {
      secret = generateSecret();
      await tx.query("INSERT INTO bb.user_mfa (user_id, secret_enc) VALUES ($1, $2)", [userId, sealSecret(secret, k)]);
    }
    return { secret, otpauth: otpauthUri(secret, user.rows[0].email) };
  });
}

async function issueRecoveryCodes(tx: Client, userId: string): Promise<string[]> {
  await tx.query("DELETE FROM bb.mfa_recovery_codes WHERE user_id = $1", [userId]);
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const c = generateRecoveryCode();
    if (!codes.includes(c)) codes.push(c);
  }
  for (const c of codes) await tx.query("INSERT INTO bb.mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, hashCode(normalizeRecoveryCode(c))]);
  return codes;
}

/** Confirms enrolment with a code from the new secret. Returns the recovery codes: shown once, never again. */
export async function confirmEnrollment(pool: Pool, userId: string, code: string, key: string | undefined, meta: AuditMeta = {}, now = Date.now()): Promise<{ recoveryCodes: string[] } | null> {
  const k = parseKey(key);
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ secret_enc: string; enrolled_at: Date | null }>("SELECT secret_enc, enrolled_at FROM bb.user_mfa WHERE user_id = $1 FOR UPDATE", [userId]);
    const row = rows[0];
    if (!row || row.enrolled_at) return null;
    const step = matchTotp(openSecret(row.secret_enc, k), code, now);
    if (step === null) return null;
    await tx.query("UPDATE bb.user_mfa SET enrolled_at = now(), last_step = $2 WHERE user_id = $1", [userId, step]);
    const recoveryCodes = await issueRecoveryCodes(tx, userId);
    await writeAudit(tx, { actorUserId: userId, action: "mfa.enrolled", entityType: "user", entityId: userId, ...meta });
    return { recoveryCodes };
  });
}

/**
 * Verifies the second factor at login: a current TOTP code (each time step works once) or an unused recovery code.
 * Returns how it was proven, or null.
 */
export async function verifySecondFactor(pool: Pool, userId: string, input: string, key: string | undefined, meta: AuditMeta = {}, now = Date.now()): Promise<"totp" | "recovery" | null> {
  const k = parseKey(key);
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ secret_enc: string; last_step: string }>("SELECT secret_enc, last_step FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NOT NULL FOR UPDATE", [userId]);
    const row = rows[0];
    if (!row) return null;
    const compact = input.trim();
    if (/^\d{6}$/.test(compact.replace(/\s/g, ""))) {
      const step = matchTotp(openSecret(row.secret_enc, k), compact, now);
      if (step !== null && step > Number(row.last_step)) {
        await tx.query("UPDATE bb.user_mfa SET last_step = $2 WHERE user_id = $1", [userId, step]);
        return "totp" as const;
      }
      return null;
    }
    const normalized = normalizeRecoveryCode(compact);
    if (normalized.length !== 10) return null;
    const used = await tx.query("UPDATE bb.mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id", [userId, hashCode(normalized)]);
    if (!used.rows[0]) return null;
    const left = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM bb.mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await writeAudit(tx, { actorUserId: userId, action: "mfa.recovery_used", entityType: "user", entityId: userId, after: { left: left.rows[0].n }, ...meta });
    return "recovery" as const;
  });
}

export async function recoveryCodesLeft(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM bb.mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
  return rows[0].n;
}

/**
 * The Owner removes another person's second factor (lost phone). All their sessions end; at the next login they enrol again.
 * Nobody resets their own factor here: the Owner's own recovery is a recovery code, then the server-side script.
 */
export async function resetUserMfa(pool: Pool, actor: Actor, targetUserId: string, meta: AuditMeta = {}): Promise<void> {
  assertCan(actor, "users.manage");
  if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw new NotFoundError();
  if (targetUserId === actor.id) throw new ValidationError({ id: "own_mfa" });
  await withTx(pool, async (tx) => {
    const u = await tx.query("SELECT 1 FROM bb.users WHERE id = $1 FOR UPDATE", [targetUserId]);
    if (!u.rows[0]) throw new NotFoundError();
    await tx.query("DELETE FROM bb.user_mfa WHERE user_id = $1", [targetUserId]);
    await tx.query("DELETE FROM bb.mfa_recovery_codes WHERE user_id = $1", [targetUserId]);
    const ended = await revokeUserSessions(tx, targetUserId);
    await writeAudit(tx, { actorUserId: actor.id, action: "mfa.reset", entityType: "user", entityId: targetUserId, after: { sessionsEnded: ended }, ...meta });
  });
}

/** Break-glass, run on the server by an administrator (see docs): same effect, actor is the server console. */
export async function resetUserMfaByEmail(pool: Pool, email: string): Promise<boolean> {
  return withTx(pool, async (tx) => {
    const u = await tx.query<{ id: string }>("SELECT id FROM bb.users WHERE email = $1 FOR UPDATE", [email.trim().toLowerCase()]);
    if (!u.rows[0]) return false;
    const id = u.rows[0].id;
    await tx.query("DELETE FROM bb.user_mfa WHERE user_id = $1", [id]);
    await tx.query("DELETE FROM bb.mfa_recovery_codes WHERE user_id = $1", [id]);
    const ended = await revokeUserSessions(tx, id);
    await writeAudit(tx, { actorUserId: null, action: "mfa.reset", entityType: "user", entityId: id, after: { sessionsEnded: ended, via: "server_console" } });
    return true;
  });
}

/** Ids of the users with an active second factor (for the staff list). */
export async function listEnrolledUserIds(db: Queryable, actor: Actor): Promise<Set<string>> {
  assertCan(actor, "users.manage");
  const { rows } = await db.query<{ user_id: string }>("SELECT user_id FROM bb.user_mfa WHERE enrolled_at IS NOT NULL");
  return new Set(rows.map((r) => r.user_id));
}
