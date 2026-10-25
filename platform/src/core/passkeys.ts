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
import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { lockedFor } from "./auth.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.ts";
import { isEnrolled } from "./mfa.ts";
import { assertCan, can, type Actor } from "./rbac.ts";
import type { PasskeyConfig } from "./passkey-config.ts";
import { createSession, revokeSession, revokeUserSessions, validateSession } from "./session.ts";
import { consumeStepUp, grantStepUp, hasStepUp, type StepUpPurpose } from "./stepup.ts";

/**
 * Passkeys (WebAuthn) as a way to sign in for staff: Face ID, Touch ID, Windows Hello, a security key.
 *
 * What makes it safe here:
 *  - the library (@simplewebauthn/server) does the cryptography; this module only decides WHICH challenge, origin and RP ID are expected;
 *  - the challenge is random, stored in the database, valid for a few minutes and consumed exactly once (a replayed answer fails);
 *  - user verification (biometric / device PIN) is REQUIRED, so a passkey is a possession factor plus a "something you are/know" factor:
 *    a session it creates counts as having passed the second factor (it satisfies MFA_MODE=required);
 *  - origin and RP ID come from the configuration, never from the request;
 *  - every sign-in, registration, failure and revocation is in the audit log; failures count in the same throttle as wrong passwords;
 *  - only the public key is stored; a revoked key can never sign in; the password + TOTP sign-in remains as the fallback.
 */

export const CHALLENGE_SECONDS = 5 * 60;
export const MAX_ACTIVE_PASSKEYS = 10;
/** Unanswered challenges one address may hold at a time (a cheap guard against filling the table). */
export const MAX_OPEN_CHALLENGES_PER_IP = 20;

export interface PasskeyMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** What the sensitive operations need besides the request meta: the session the person is acting in (their step-up grant is bound to it). */
export interface PasskeyContext extends PasskeyMeta {
  sessionId: string;
}

export interface PasskeyRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  revokedAt: string | null;
}

/** The user handle sent to the authenticator: the 16 bytes of the user's id (not an e-mail, not a name). */
const userHandle = (userId: string) => Buffer.from(userId.replace(/-/g, ""), "hex");
const ipOf = (meta: PasskeyMeta) => (meta.ip ?? "unknown").slice(0, 64);

function requireEnabled(cfg: PasskeyConfig): void {
  if (!cfg.enabled) throw new NotFoundError("passkeys_disabled");
}

async function storeChallenge(db: Queryable, challenge: string, purpose: "register" | "login", userId: string | null, meta: PasskeyMeta): Promise<void> {
  const ip = ipOf(meta);
  await db.query("DELETE FROM bb.passkey_challenges WHERE expires_at < now()");
  const open = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM bb.passkey_challenges WHERE ip = $1", [ip])).rows[0].n);
  if (open >= MAX_OPEN_CHALLENGES_PER_IP) throw new ConflictError("too_many_challenges");
  await db.query(
    "INSERT INTO bb.passkey_challenges (challenge, purpose, user_id, ip, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    [challenge, purpose, userId, ip, CHALLENGE_SECONDS],
  );
}

/** Takes a challenge out of the table (once). Returns the row's user, or false when it is unknown, used, expired or of another purpose. */
async function consumeChallenge(db: Queryable, challenge: string, purpose: "register" | "login"): Promise<{ userId: string | null } | false> {
  const { rows } = await db.query<{ user_id: string | null }>(
    "DELETE FROM bb.passkey_challenges WHERE challenge = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id",
    [challenge, purpose],
  );
  return rows[0] ? { userId: rows[0].user_id } : false;
}

export async function listPasskeys(db: Queryable, userId: string, opts: { includeRevoked?: boolean } = {}): Promise<PasskeyRow[]> {
  const { rows } = await db.query<{ id: string; label: string; created_at: Date; last_used_at: Date | null; device_type: "singleDevice" | "multiDevice"; backed_up: boolean; revoked_at: Date | null }>(
    `SELECT id, label, created_at, last_used_at, device_type, backed_up, revoked_at FROM bb.passkeys
      WHERE user_id = $1 ${opts.includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY created_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    deviceType: r.device_type,
    backedUp: r.backed_up,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  }));
}

export async function activePasskeyCount(db: Queryable, userId: string): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows[0].n);
}

/** Number of active passkeys per user (the Owner's list of staff). */
export async function countActivePasskeys(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ user_id: string; n: string }>("SELECT user_id, count(*) AS n FROM bb.passkeys WHERE revoked_at IS NULL GROUP BY user_id");
  return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
}

// ── registration (a signed-in person adds a device) ─────────────────────────────────────────────────

export async function beginRegistration(pool: Pool, cfg: PasskeyConfig, user: { id: string; email: string; name: string }, ctx: PasskeyContext): Promise<PublicKeyCredentialCreationOptionsJSON> {
  requireEnabled(cfg);
  // A passkey is added on top of the authenticator app, which stays as the backup (and the way back in after a lost device).
  if (!(await isEnrolled(pool, user.id))) throw new ConflictError("totp_required");
  // The fresh proof of identity is checked BEFORE anything is issued (and consumed when the key is stored).
  if (!(await hasStepUp(pool, user.id, ctx.sessionId, "passkey_register"))) throw new ForbiddenError("step_up_required");
  const existing = await listPasskeys(pool, user.id);
  if (existing.length >= MAX_ACTIVE_PASSKEYS) throw new ConflictError("too_many_passkeys");
  const credIds = (await pool.query<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [user.id])).rows;
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: userHandle(user.id),
    attestationType: "none",
    timeout: 120_000,
    excludeCredentials: credIds.map((c) => ({ id: c.credential_id, transports: c.transports as never })),
    // a discoverable credential (the sign-in page asks for no e-mail) and mandatory user verification (Face ID / Touch ID / device PIN)
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  });
  await storeChallenge(pool, options.challenge, "register", user.id, ctx);
  return options;
}

export async function finishRegistration(
  pool: Pool,
  cfg: PasskeyConfig,
  user: { id: string },
  response: RegistrationResponseJSON,
  labelInput: string,
  ctx: PasskeyContext,
): Promise<PasskeyRow> {
  requireEnabled(cfg);
  const label = labelInput.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!label) throw new ValidationError({ label: "Назовите устройство" });
  if (!(await hasStepUp(pool, user.id, ctx.sessionId, "passkey_register"))) throw new ForbiddenError("step_up_required");
  let challengeOwner: string | null | undefined;
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: async (challenge) => {
      const row = await consumeChallenge(pool, challenge, "register");
      challengeOwner = row ? row.userId : undefined;
      return row !== false && row.userId === user.id;
    },
    expectedOrigin: cfg.origins,
    expectedRPID: cfg.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
  }).catch(async () => {
    await writeAudit(pool, { actorUserId: user.id, action: "passkey.register_failed", entityType: "user", entityId: user.id, ip: ctx.ip, userAgent: ctx.userAgent });
    throw new ValidationError({ passkey: "Не удалось проверить ключ. Повторите." });
  });
  if (!verification.verified || challengeOwner !== user.id) throw new ValidationError({ passkey: "Не удалось проверить ключ. Повторите." });
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  return withTx(pool, async (tx) => {
    // serialise the limit check per user, then spend the step-up grant: two parallel requests cannot both register on one confirmation
    await tx.query("SELECT id FROM bb.users WHERE id = $1 FOR UPDATE", [user.id]);
    await consumeStepUp(tx, user.id, ctx.sessionId, "passkey_register");
    const active = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [user.id])).rows[0].n);
    if (active >= MAX_ACTIVE_PASSKEYS) throw new ConflictError("too_many_passkeys");
    const dup = await tx.query("SELECT 1 FROM bb.passkeys WHERE credential_id = $1", [credential.id]);
    if (dup.rowCount) throw new ConflictError("passkey_exists");
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bb.passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.id, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], credentialDeviceType, credentialBackedUp, label],
    );
    await writeAudit(tx, { actorUserId: user.id, action: "passkey.registered", entityType: "passkey", entityId: ins.rows[0].id, after: { label, deviceType: credentialDeviceType, backedUp: credentialBackedUp }, ip: ctx.ip, userAgent: ctx.userAgent });
    return (await listPasskeys(tx, user.id)).find((p) => p.id === ins.rows[0].id)!;
  });
}

// ── sign-in ────────────────────────────────────────────────────────────────────────────────────

/**
 * Options for the sign-in. With `pendingUserId` (the second-factor page: the password was already accepted) only that person's keys are
 * offered; without it the browser offers the discoverable passkeys it holds for this site.
 */
export async function beginLogin(pool: Pool, cfg: PasskeyConfig, opts: { pendingUserId?: string | null } = {}, meta: PasskeyMeta = {}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  requireEnabled(cfg);
  const ip = ipOf(meta);
  const wait = await lockedFor(pool, `passkey@${ip}`, ip);
  if (wait > 0) throw new ConflictError(`locked:${wait}`);
  let allow: { id: string; transports?: never }[] | undefined;
  if (opts.pendingUserId) {
    const keys = await pool.query<{ credential_id: string; transports: string[] }>("SELECT credential_id, transports FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL", [opts.pendingUserId]);
    allow = keys.rows.map((k) => ({ id: k.credential_id, transports: k.transports as never }));
  }
  const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: "required", timeout: 120_000, allowCredentials: allow });
  await storeChallenge(pool, options.challenge, "login", opts.pendingUserId ?? null, meta);
  return options;
}

export type PasskeyLoginResult =
  | { ok: true; token: string; expiresAt: Date; userId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

export interface PasskeyLoginInput {
  response: AuthenticationResponseJSON;
  /** The cookie token of the PENDING session when the person came from the second-factor page. */
  pendingToken?: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface KeyRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  is_active: boolean;
  email: string;
}

type Assertion = { ok: true; row: KeyRow; newCounter: number } | { ok: false; userId: string | null; why: string };

/**
 * The cryptographic part, shared by the sign-in and the step-up: finds the (active) key, lets the library verify the signature, origin, RP ID,
 * user verification and the challenge (consumed once), and checks that the key belongs to the person the ceremony was for.
 * Nothing is written here except the consumed challenge.
 */
async function verifyAssertion(pool: Pool, cfg: PasskeyConfig, response: AuthenticationResponseJSON, expectUserId: string | null): Promise<Assertion> {
  const credentialId = typeof response?.id === "string" ? response.id.slice(0, 1400) : "";
  const row = (
    await pool.query<KeyRow>(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports, u.is_active, u.email
         FROM bb.passkeys p JOIN bb.users u ON u.id = p.user_id
        WHERE p.credential_id = $1 AND p.revoked_at IS NULL`,
      [credentialId],
    )
  ).rows[0];
  if (!row || !row.is_active) return { ok: false, userId: row?.user_id ?? null, why: row ? "user_disabled" : "unknown_key" };
  if (expectUserId !== null && row.user_id !== expectUserId) return { ok: false, userId: row.user_id, why: "user_mismatch" };
  let challengeUser: string | null | undefined;
  let newCounter = Number(row.counter);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: async (challenge) => {
        const c = await consumeChallenge(pool, challenge, "login");
        challengeUser = c ? c.userId : undefined;
        return c !== false;
      },
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpID,
      credential: { id: credentialId, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports as never },
      requireUserVerification: true,
    });
    if (!v.verified) return { ok: false, userId: row.user_id, why: "not_verified" };
    newCounter = v.authenticationInfo.newCounter;
  } catch {
    return { ok: false, userId: row.user_id, why: "verification_failed" };
  }
  // A challenge issued for one person (the second-factor page, a step-up) cannot be answered with another person's key.
  if (challengeUser === undefined || (challengeUser !== null && challengeUser !== row.user_id)) return { ok: false, userId: row.user_id, why: "challenge_mismatch" };
  // The authenticator's user handle (when it sends one) must be this user's.
  const handle = response.response.userHandle;
  if (handle && Buffer.from(handle, "base64url").toString("hex") !== row.user_id.replace(/-/g, "")) return { ok: false, userId: row.user_id, why: "user_handle_mismatch" };
  return { ok: true, row, newCounter };
}

/**
 * Records the use of the key INSIDE the transaction, atomically: the key must still be active (it may have been revoked a moment ago),
 * the person still enabled, and the counter must move forward (two parallel answers with the same counter: one wins). Returns false when
 * any of it no longer holds; the caller then fails the sign-in.
 */
async function commitAssertion(tx: Queryable, row: KeyRow, newCounter: number): Promise<boolean> {
  const active = await tx.query("SELECT 1 FROM bb.users WHERE id = $1 AND is_active FOR UPDATE", [row.user_id]);
  if (!active.rows[0]) return false;
  const upd = await tx.query(
    `UPDATE bb.passkeys SET counter = $2, last_used_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND ((counter = 0 AND $2 = 0) OR counter < $2) RETURNING id`,
    [row.id, newCounter],
  );
  return upd.rows.length === 1;
}

async function failAssertion(pool: Pool, ip: string, userAgent: string | null | undefined, userId: string | null, why: string): Promise<void> {
  await pool.query("INSERT INTO bb.login_attempts (email_norm, ip, success) VALUES ($1, $2, false)", [`passkey@${ip}`, ip]);
  await writeAudit(pool, { actorUserId: userId, action: "auth.passkey_failed", entityType: "user", entityId: userId ?? undefined, after: { why }, ip, userAgent });
}

export async function finishLogin(pool: Pool, cfg: PasskeyConfig, input: PasskeyLoginInput): Promise<PasskeyLoginResult> {
  requireEnabled(cfg);
  const ip = ipOf(input);
  const wait = await lockedFor(pool, `passkey@${ip}`, ip);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterSeconds: wait };
  const fail = async (userId: string | null, why: string): Promise<PasskeyLoginResult> => {
    await failAssertion(pool, ip, input.userAgent, userId, why);
    return { ok: false, reason: "invalid" };
  };

  // The second-factor page: the key must belong to the person whose password was just accepted.
  let expectUser: string | null = null;
  if (input.pendingToken) {
    const pending = await validateSession(pool, input.pendingToken, { state: "pending" });
    if (!pending) return fail(null, "pending_expired");
    expectUser = pending.user.id;
  }
  const a = await verifyAssertion(pool, cfg, input.response, expectUser);
  if (!a.ok) return fail(a.userId, a.why);

  return withTx(pool, async (tx) => {
    if (!(await commitAssertion(tx, a.row, a.newCounter))) return { ok: false as const, reason: "invalid" as const, raced: true };
    if (input.pendingToken) await revokeSession(tx, input.pendingToken);
    // always a NEW session token: nothing the browser held before (a planted cookie included) becomes a signed-in session
    const session = await createSession(tx, a.row.user_id, { ip, userAgent: input.userAgent }, "verified", { mfaVerified: true });
    await tx.query("UPDATE bb.users SET last_login_at = now() WHERE id = $1", [a.row.user_id]);
    await tx.query("DELETE FROM bb.login_attempts WHERE email_norm = $1 AND success = false", [a.row.email]);
    await writeAudit(tx, { actorUserId: a.row.user_id, action: "auth.login", entityType: "user", entityId: a.row.user_id, after: { passkey: true, passkeyId: a.row.id }, ip, userAgent: input.userAgent });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, userId: a.row.user_id };
  }).then(async (r) => {
    if ("raced" in r) return fail(a.row.user_id, "key_state_changed");
    return r;
  });
}

// ── step-up with a passkey (a fresh proof before a sensitive action) ───────────────────────────────

export async function beginStepUp(pool: Pool, cfg: PasskeyConfig, user: { id: string }, meta: PasskeyMeta = {}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return beginLogin(pool, cfg, { pendingUserId: user.id }, meta);
}

/** The person (already signed in) answers with a key of THEIRS; on success the grant for `purpose` is issued to this session. */
export async function finishStepUp(
  pool: Pool,
  cfg: PasskeyConfig,
  input: { response: AuthenticationResponseJSON; sessionToken: string | undefined; purpose: StepUpPurpose; requireMfa: boolean; ip?: string | null; userAgent?: string | null },
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" | "locked"; retryAfterSeconds?: number }> {
  requireEnabled(cfg);
  const session = await validateSession(pool, input.sessionToken, { state: "verified", requireMfa: input.requireMfa });
  if (!session) return { ok: false, reason: "expired" };
  const ip = ipOf(input);
  const wait = await lockedFor(pool, `passkey@${ip}`, ip);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterSeconds: wait };
  const a = await verifyAssertion(pool, cfg, input.response, session.user.id);
  if (!a.ok) {
    await failAssertion(pool, ip, input.userAgent, a.userId, `stepup_${a.why}`);
    return { ok: false, reason: "invalid" };
  }
  const done = await withTx(pool, async (tx) => {
    if (!(await commitAssertion(tx, a.row, a.newCounter))) return false;
    await grantStepUp(tx, { userId: session.user.id, sessionId: session.sessionId, purpose: input.purpose, method: "passkey" });
    await writeAudit(tx, { actorUserId: session.user.id, action: "auth.stepup", entityType: "user", entityId: session.user.id, after: { purpose: input.purpose, method: "passkey" }, ip, userAgent: input.userAgent });
    return true;
  });
  if (!done) {
    await failAssertion(pool, ip, input.userAgent, session.user.id, "stepup_key_state_changed");
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

// ── revocation ─────────────────────────────────────────────────────────────────────────────────

async function otherFactorLeft(tx: Queryable, userId: string, excludingPasskey?: string): Promise<boolean> {
  const totp = await isEnrolled(tx, userId);
  if (totp) return true;
  const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM bb.passkeys WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)", [userId, excludingPasskey ?? null]);
  return Number(rows[0].n) > 0;
}

/**
 * A person revokes their own key; the Owner (users.manage) may revoke anyone's (a lost phone). Needs a fresh step-up grant (consumed here).
 * The revoked key can never sign in again. Revoking one's OWN last way in is refused unless a backup factor (the authenticator app) exists.
 */
export async function revokePasskey(pool: Pool, actor: Actor, passkeyId: string, ctx: PasskeyContext): Promise<void> {
  return withTx(pool, async (tx) => {
    await consumeStepUp(tx, actor.id, ctx.sessionId, "passkey_revoke");
    const row = (await tx.query<{ user_id: string; label: string; revoked_at: Date | null }>("SELECT user_id, label, revoked_at FROM bb.passkeys WHERE id = $1 FOR UPDATE", [passkeyId])).rows[0];
    if (!row) throw new NotFoundError("passkey");
    if (row.user_id !== actor.id && !can(actor.role, "users.manage")) throw new ForbiddenError("passkey of another person");
    if (row.revoked_at) return;
    if (row.user_id === actor.id && !(await otherFactorLeft(tx, actor.id, passkeyId))) throw new ConflictError("last_factor");
    await tx.query("UPDATE bb.passkeys SET revoked_at = now(), revoked_by = $2 WHERE id = $1", [passkeyId, actor.id]);
    // another person's key was revoked: their open sessions end too (the device may be in someone else's hands)
    if (row.user_id !== actor.id) await revokeUserSessions(tx, row.user_id);
    await writeAudit(tx, { actorUserId: actor.id, action: "passkey.revoked", entityType: "passkey", entityId: passkeyId, before: { label: row.label, userId: row.user_id }, ip: ctx.ip, userAgent: ctx.userAgent });
  });
}

/** The Owner revokes every key of one person and ends their sessions (lost access, a leaver). Needs a step-up grant. Returns how many keys were revoked. */
export async function revokeAllPasskeys(pool: Pool, actor: Actor, userId: string, ctx: PasskeyContext): Promise<number> {
  assertCan(actor, "users.manage");
  return withTx(pool, async (tx) => {
    await consumeStepUp(tx, actor.id, ctx.sessionId, "passkeys_revoke_all");
    // the Owner may not cut their OWN last way in
    if (userId === actor.id && !(await isEnrolled(tx, actor.id))) throw new ConflictError("last_factor");
    const res = await tx.query("UPDATE bb.passkeys SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, actor.id]);
    const n = res.rowCount ?? 0;
    if (n > 0 && userId !== actor.id) await revokeUserSessions(tx, userId);
    await writeAudit(tx, { actorUserId: actor.id, action: "passkey.revoked_all", entityType: "user", entityId: userId, after: { count: n }, ip: ctx.ip, userAgent: ctx.userAgent });
    return n;
  });
}

/** Housekeeping: drops expired challenges. */
export async function purgeExpiredChallenges(db: Queryable): Promise<number> {
  const res = await db.query("DELETE FROM bb.passkey_challenges WHERE expires_at < now()");
  return res.rowCount ?? 0;
}


/** Break-glass for the server console (a lost phone, nobody else can sign in as Owner): revokes every key of one person and ends their sessions. */
export async function revokePasskeysByEmail(pool: Pool, email: string): Promise<{ found: boolean; revoked: number }> {
  return withTx(pool, async (tx) => {
    const u = await tx.query<{ id: string }>("SELECT id FROM bb.users WHERE email = $1 FOR UPDATE", [email.trim().toLowerCase()]);
    if (!u.rows[0]) return { found: false, revoked: 0 };
    const id = u.rows[0].id;
    const res = await tx.query("UPDATE bb.passkeys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    const ended = await revokeUserSessions(tx, id);
    await writeAudit(tx, { actorUserId: null, action: "passkey.revoked_all", entityType: "user", entityId: id, after: { count: res.rowCount ?? 0, sessionsEnded: ended, via: "server_console" } });
    return { found: true, revoked: res.rowCount ?? 0 };
  });
}
