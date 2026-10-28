import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { lockedFor } from "./auth.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { createSession, revokeSession, validateSession } from "./session.ts";

export const PASSKEY_CHALLENGE_SECONDS = 5 * 60;
const LABEL = z.string().trim().min(1).max(80);

export interface PasskeyConfig {
  rpID: string;
  origin: string;
  rpName: string;
}

export interface PasskeySummary {
  id: string;
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PasskeyMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export class PasskeyLockedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("passkey_locked");
    this.name = "PasskeyLockedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function challenge(): string {
  return randomBytes(32).toString("base64url");
}

function checkedLabel(value: string): string {
  const parsed = LABEL.safeParse(value);
  if (!parsed.success) throw new ValidationError({ label: "Название устройства должно быть от 1 до 80 символов" });
  return parsed.data;
}

async function saveChallenge(pool: Pool, userId: string, purpose: "login" | "registration", value: string): Promise<void> {
  await pool.query(
    `INSERT INTO bb.passkey_challenges (user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [userId, purpose, value, PASSKEY_CHALLENGE_SECONDS],
  );
}

async function consumeChallenge(db: Queryable, userId: string, purpose: "login" | "registration", value: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE bb.passkey_challenges
        SET consumed_at = now()
      WHERE user_id = $1
        AND purpose = $2
        AND challenge = $3
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id`,
    [userId, purpose, value],
  );
  return (result.rowCount ?? 0) === 1;
}

async function ensurePasskeyNotLocked(pool: Pool, email: string, meta: PasskeyMeta): Promise<string> {
  const ip = (meta.ip ?? "unknown").slice(0, 64);
  const wait = await lockedFor(pool, email, ip);
  if (wait > 0) throw new PasskeyLockedError(wait);
  return ip;
}

async function recordPasskeyFailure(pool: Pool, userId: string, email: string, reason: string, meta: PasskeyMeta): Promise<void> {
  const ip = (meta.ip ?? "unknown").slice(0, 64);
  await pool.query("INSERT INTO bb.login_attempts (email_norm, ip, success) VALUES ($1, $2, false)", [email, ip]);
  await writeAudit(pool, { actorUserId: userId, action: "auth.passkey_failed", entityType: "user", entityId: userId, after: { reason }, ip, userAgent: meta.userAgent });
}

export async function listPasskeys(pool: Queryable, userId: string): Promise<PasskeySummary[]> {
  const { rows } = await pool.query<{
    id: string;
    label: string;
    device_type: "singleDevice" | "multiDevice";
    backed_up: boolean;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, label, device_type, backed_up, created_at, last_used_at
       FROM bb.passkeys
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at`,
    [userId],
  );
  return rows.map((row) => ({ id: row.id, label: row.label, deviceType: row.device_type, backedUp: row.backed_up, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

export async function beginPasskeyRegistration(pool: Pool, userId: string, config: PasskeyConfig): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rows: userRows } = await pool.query<{ email: string; name: string }>("SELECT email, name FROM bb.users WHERE id = $1 AND is_active", [userId]);
  const user = userRows[0];
  if (!user) throw new ValidationError({ user: "Пользователь не найден" });
  const { rows: credentials } = await pool.query<{ credential_id: string; transports: string[] }>(
    "SELECT credential_id, transports FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: user.email,
    userID: Buffer.from(userId),
    userDisplayName: user.name,
    challenge: challenge(),
    timeout: 60_000,
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: credential.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  await saveChallenge(pool, userId, "registration", options.challenge);
  return options;
}

export async function beginPasskeyLogin(pool: Pool, userId: string, config: PasskeyConfig): Promise<
  { mode: "authenticate"; options: PublicKeyCredentialRequestOptionsJSON } | { mode: "register"; options: PublicKeyCredentialCreationOptionsJSON }
> {
  const { rows: userRows } = await pool.query<{ email: string; name: string }>("SELECT email, name FROM bb.users WHERE id = $1 AND is_active", [userId]);
  const user = userRows[0];
  if (!user) throw new ValidationError({ user: "Пользователь не найден" });
  const { rows: credentials } = await pool.query<{ credential_id: string; transports: string[] }>(
    "SELECT credential_id, transports FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  if (credentials.length === 0) {
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: user.email,
      userID: Buffer.from(userId),
      userDisplayName: user.name,
      challenge: challenge(),
      timeout: 60_000,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    await saveChallenge(pool, userId, "registration", options.challenge);
    return { mode: "register", options };
  }
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    challenge: challenge(),
    timeout: 60_000,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: credential.transports })),
  });
  await saveChallenge(pool, userId, "login", options.challenge);
  return { mode: "authenticate", options };
}

export async function finishPasskeyRegistration(
  pool: Pool,
  input: {
    userId: string;
    response: RegistrationResponseJSON;
    label: string;
    config: PasskeyConfig;
    pendingToken?: string;
  },
  meta: PasskeyMeta = {},
): Promise<{ token?: string; expiresAt?: Date }> {
  const label = checkedLabel(input.label);
  const { rows: userRows } = await pool.query<{ email: string }>("SELECT email FROM bb.users WHERE id = $1 AND is_active", [input.userId]);
  const email = userRows[0]?.email;
  if (!email) throw new ValidationError({ user: "Пользователь не найден" });
  await ensurePasskeyNotLocked(pool, email, meta);
  let challengeValue = "";
  let verified;
  try {
    const { rows } = await pool.query<{ challenge: string }>(
      `SELECT challenge FROM bb.passkey_challenges
        WHERE user_id = $1 AND purpose = 'registration' AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [input.userId],
    );
    if (!rows[0]) throw new ValidationError({ passkey: "Сессия регистрации passkey истекла" });
    challengeValue = rows[0].challenge;
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challengeValue,
      expectedOrigin: input.config.origin,
      expectedRPID: input.config.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!verified.verified) throw new ValidationError({ passkey: "Passkey не прошёл проверку" });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    await recordPasskeyFailure(pool, input.userId, email, "verification", meta);
    throw new ValidationError({ passkey: "Passkey не прошёл проверку" });
  }
  const registration = verified.registrationInfo;
  if (!challengeValue) throw new ValidationError({ passkey: "Сессия регистрации passkey истекла" });
  const pending = input.pendingToken ? await validateSession(pool, input.pendingToken, { state: "pending" }) : null;
  if (input.pendingToken && (!pending || pending.user.id !== input.userId)) throw new ValidationError({ passkey: "Сессия входа истекла" });
  return withTx(pool, async (tx) => {
    const used = await consumeChallenge(tx, input.userId, "registration", challengeValue);
    if (!used) throw new ValidationError({ passkey: "Passkey challenge уже использован или истёк" });
    try {
      await tx.query(
        `INSERT INTO bb.passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.userId, registration.credential.id, Buffer.from(registration.credential.publicKey), registration.credential.counter, input.response.response.transports ?? [], registration.credentialDeviceType, registration.credentialBackedUp, label],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictError("passkey_exists");
      throw error;
    }
    await writeAudit(tx, { actorUserId: input.userId, action: "auth.passkey_registered", entityType: "passkey", after: { deviceType: registration.credentialDeviceType, backedUp: registration.credentialBackedUp }, ip: meta.ip, userAgent: meta.userAgent });
    if (!pending || !input.pendingToken) return {};
    await revokeSession(tx, input.pendingToken);
    const session = await createSession(tx, input.userId, { ip: meta.ip, userAgent: meta.userAgent }, "verified", { mfaVerified: true });
    await tx.query("UPDATE bb.users SET last_login_at = now() WHERE id = $1", [input.userId]);
    await tx.query("DELETE FROM bb.login_attempts WHERE email_norm = $1 AND success = false", [pending.user.email]);
    await writeAudit(tx, { actorUserId: input.userId, action: "auth.login", entityType: "user", entityId: input.userId, after: { method: "passkey_enrollment" }, ip: meta.ip, userAgent: meta.userAgent });
    return session;
  });
}

export async function finishPasskeyLogin(
  pool: Pool,
  input: { userId: string; pendingToken: string; response: AuthenticationResponseJSON; config: PasskeyConfig },
  meta: PasskeyMeta = {},
): Promise<{ token: string; expiresAt: Date }> {
  const pending = await validateSession(pool, input.pendingToken, { state: "pending" });
  if (!pending || pending.user.id !== input.userId) throw new ValidationError({ passkey: "Сессия входа истекла" });
  await ensurePasskeyNotLocked(pool, pending.user.email, meta);
  const { rows } = await pool.query<{ credential_id: string; public_key: Buffer; counter: number; transports: string[] }>(
    `SELECT credential_id, public_key, counter, transports
       FROM bb.passkeys
      WHERE user_id = $1 AND credential_id = $2 AND revoked_at IS NULL`,
    [input.userId, input.response.id],
  );
  const credential = rows[0];
  if (!credential) {
    await recordPasskeyFailure(pool, input.userId, pending.user.email, "not_found", meta);
    throw new ValidationError({ passkey: "Passkey не найден" });
  }
  const { rows: challengeRows } = await pool.query<{ challenge: string }>(
    `SELECT challenge FROM bb.passkey_challenges
      WHERE user_id = $1 AND purpose = 'login' AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [input.userId],
  );
  const challengeValue = challengeRows[0]?.challenge;
  if (!challengeValue) {
    await writeAudit(pool, { actorUserId: input.userId, action: "auth.passkey_failed", entityType: "user", entityId: input.userId, after: { reason: "expired" }, ip: meta.ip, userAgent: meta.userAgent });
    throw new ValidationError({ passkey: "Сессия входа истекла" });
  }
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challengeValue,
      expectedOrigin: input.config.origin,
      expectedRPID: input.config.rpID,
      credential: { id: credential.credential_id, publicKey: Uint8Array.from(credential.public_key), counter: Number(credential.counter), transports: credential.transports },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: "required" },
    });
  } catch {
    await recordPasskeyFailure(pool, input.userId, pending.user.email, "verification", meta);
    throw new ValidationError({ passkey: "Passkey не прошёл проверку" });
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) {
    await recordPasskeyFailure(pool, input.userId, pending.user.email, "user_verification", meta);
    throw new ValidationError({ passkey: "Passkey не прошёл проверку" });
  }
  const newCounter = verified.authenticationInfo.newCounter;
  if (Number(credential.counter) > 0 && newCounter > 0 && newCounter <= Number(credential.counter)) {
    await recordPasskeyFailure(pool, input.userId, pending.user.email, "counter", meta);
    throw new ValidationError({ passkey: "Passkey counter недействителен" });
  }
  return withTx(pool, async (tx) => {
    const challengeUsed = await consumeChallenge(tx, input.userId, "login", challengeValue);
    if (!challengeUsed) throw new ValidationError({ passkey: "Passkey challenge уже использован или истёк" });
    const updated = await tx.query(
      `UPDATE bb.passkeys SET counter = GREATEST(counter, $2), last_used_at = now()
        WHERE user_id = $1 AND credential_id = $3 AND revoked_at IS NULL`,
      [input.userId, newCounter, input.response.id],
    );
    if (updated.rowCount !== 1) throw new ValidationError({ passkey: "Passkey отозван" });
    await revokeSession(tx, input.pendingToken);
    const session = await createSession(tx, input.userId, { ip: meta.ip, userAgent: meta.userAgent }, "verified", { mfaVerified: true });
    await tx.query("UPDATE bb.users SET last_login_at = now() WHERE id = $1", [input.userId]);
    await tx.query("DELETE FROM bb.login_attempts WHERE email_norm = $1 AND success = false", [pending.user.email]);
    await writeAudit(tx, { actorUserId: input.userId, action: "auth.login", entityType: "user", entityId: input.userId, after: { method: "passkey" }, ip: meta.ip, userAgent: meta.userAgent });
    return session;
  });
}

export async function revokePasskey(pool: Pool, userId: string, passkeyId: string, meta: PasskeyMeta = {}): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(passkeyId)) throw new ValidationError({ passkey: "Некорректный passkey" });
  await withTx(pool, async (tx) => {
    const result = await tx.query<{ label: string }>(
      `UPDATE bb.passkeys SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING label`,
      [passkeyId, userId],
    );
    if (!result.rows[0]) throw new ValidationError({ passkey: "Passkey не найден" });
    await writeAudit(tx, { actorUserId: userId, action: "auth.passkey_revoked", entityType: "passkey", entityId: passkeyId, after: {}, ip: meta.ip, userAgent: meta.userAgent });
  });
}
