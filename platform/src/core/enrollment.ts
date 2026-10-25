import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { lockedFor } from "./auth.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { assertCan, type Actor } from "./rbac.ts";
import { validateSession } from "./session.ts";

/**
 * Nobody enrols a FIRST factor (an authenticator app or a passkey) with a password alone.
 *
 * Without this, whoever learns one new employee's password could sign in, show themselves the TOTP secret and enrol their own phone.
 * Now the Owner (or the server console) issues a one-time ENROLMENT CODE and hands it over in person. After the password, the person enters
 * the code; only then does the pending session get the right to enrol. The code is 60 random bits, stored only as a hash, valid for two
 * hours, burned after five wrong tries, and replaced whenever a new one is issued.
 *
 * The rule is active as soon as migration 014 is applied (a database without it behaves as before, so the new build can be deployed first).
 */

export const ENROLLMENT_CODE_MINUTES = 120;
export const MAX_CODE_ATTEMPTS = 5;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

export function generateEnrollmentCode(): string {
  const raw = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}
export const normalizeEnrollmentCode = (input: string) => input.toUpperCase().replace(/[^A-Z2-9]/g, "");
const hashCode = (normalized: string) => createHash("sha256").update(`bb-enroll:${normalized}`).digest();

let gate = false;
/** True once migration 014 exists in this database (cached; a database cannot lose it). */
export async function enrollmentGateActive(db: Queryable): Promise<boolean> {
  if (gate) return true;
  const { rows } = await db.query<{ t: string | null }>("SELECT to_regclass('bb.enrollment_codes') AS t");
  gate = rows[0].t !== null;
  return gate;
}

/** Has the person got a factor already (TOTP or an active passkey)? Then a code is not for them: a reset comes first. */
async function hasFactor(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM bb.user_mfa WHERE user_id = $1 AND enrolled_at IS NOT NULL)
          + (SELECT count(*) FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL) AS n`,
    [userId],
  );
  return Number(rows[0].n) > 0;
}

async function issue(tx: Queryable, userId: string, createdBy: string | null, meta: { ip?: string | null; userAgent?: string | null }): Promise<{ code: string; expiresAt: Date }> {
  const u = await tx.query<{ is_active: boolean }>("SELECT is_active FROM bb.users WHERE id = $1 FOR UPDATE", [userId]);
  if (!u.rows[0] || !u.rows[0].is_active) throw new NotFoundError();
  if (await hasFactor(tx, userId)) throw new ConflictError("already_enrolled");
  await tx.query("UPDATE bb.enrollment_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
  const code = generateEnrollmentCode();
  const ins = await tx.query<{ expires_at: Date }>(
    "INSERT INTO bb.enrollment_codes (user_id, code_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at",
    [userId, hashCode(normalizeEnrollmentCode(code)), createdBy, ENROLLMENT_CODE_MINUTES],
  );
  await writeAudit(tx, { actorUserId: createdBy, action: "enrollment.code_issued", entityType: "user", entityId: userId, after: { expiresAt: ins.rows[0].expires_at, via: createdBy ? "owner" : "server_console" }, ...meta });
  return { code, expiresAt: ins.rows[0].expires_at };
}

/** The Owner issues a code for a person who has no factor yet. The caller has already consumed the Owner's step-up. The code is returned ONCE. */
export async function issueEnrollmentCode(pool: Pool, actor: Actor, userId: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ code: string; expiresAt: Date }> {
  assertCan(actor, "users.manage");
  return withTx(pool, (tx) => issue(tx, userId, actor.id, meta));
}

/** Break-glass: the same from the server console (root on the server is the stronger authority). Audited with actor NULL. */
export async function issueEnrollmentCodeByEmail(pool: Pool, email: string): Promise<{ code: string; expiresAt: Date } | null> {
  return withTx(pool, async (tx) => {
    const u = await tx.query<{ id: string }>("SELECT id FROM bb.users WHERE email = $1", [email.trim().toLowerCase()]);
    if (!u.rows[0]) return null;
    return issue(tx, u.rows[0].id, null, {});
  });
}

export type RedeemResult = { ok: true } | { ok: false; reason: "invalid" | "expired" } | { ok: false; reason: "locked"; retryAfterSeconds: number };

/** The person (password accepted, session still pending) types the code. Success marks THAT session as allowed to enrol a first factor. */
export async function redeemEnrollmentCode(pool: Pool, input: { pendingToken: string | undefined; code: string; ip?: string | null; userAgent?: string | null }): Promise<RedeemResult> {
  const pending = await validateSession(pool, input.pendingToken, { state: "pending" });
  if (!pending) return { ok: false, reason: "expired" };
  const ip = (input.ip ?? "unknown").slice(0, 64);
  const wait = await lockedFor(pool, pending.user.email, ip);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterSeconds: wait };
  const meta = { ip, userAgent: input.userAgent };
  const given = hashCode(normalizeEnrollmentCode(input.code));

  const outcome = await withTx(pool, async (tx) => {
    const open = await tx.query<{ id: string; code_hash: Buffer; attempts: number }>(
      "SELECT id, code_hash, attempts FROM bb.enrollment_codes WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [pending.user.id],
    );
    const row = open.rows[0];
    if (!row) return "invalid" as const;
    const match = row.code_hash.length === given.length && timingSafeEqual(row.code_hash, given);
    if (!match) {
      const attempts = row.attempts + 1;
      await tx.query("UPDATE bb.enrollment_codes SET attempts = $2::smallint, used_at = CASE WHEN $2::int >= $3::int THEN now() ELSE NULL END WHERE id = $1", [row.id, attempts, MAX_CODE_ATTEMPTS]);
      return "invalid" as const;
    }
    await tx.query("UPDATE bb.enrollment_codes SET used_at = now() WHERE id = $1", [row.id]);
    await tx.query("UPDATE bb.sessions SET enroll_authorized_at = now() WHERE id = $1 AND revoked_at IS NULL", [pending.sessionId]);
    await writeAudit(tx, { actorUserId: pending.user.id, action: "enrollment.code_redeemed", entityType: "user", entityId: pending.user.id, ...meta });
    return "ok" as const;
  });
  if (outcome === "ok") return { ok: true };
  await pool.query("INSERT INTO bb.login_attempts (email_norm, ip, success) VALUES ($1, $2, false)", [pending.user.email, ip]);
  await writeAudit(pool, { actorUserId: pending.user.id, action: "enrollment.code_failed", entityType: "user", entityId: pending.user.id, ...meta });
  return { ok: false, reason: "invalid" };
}

/** May this pending session enrol a first factor? Always yes while the gate is not active (a database without migration 014). */
export async function mayEnroll(db: Queryable, session: { sessionId: string; enrollAuthorizedAt?: Date | null }): Promise<boolean> {
  if (!(await enrollmentGateActive(db))) return true;
  if (session.enrollAuthorizedAt !== undefined) return session.enrollAuthorizedAt !== null;
  const { rows } = await db.query("SELECT 1 FROM bb.sessions WHERE id = $1 AND enroll_authorized_at IS NOT NULL AND revoked_at IS NULL", [session.sessionId]);
  return rows.length > 0;
}
