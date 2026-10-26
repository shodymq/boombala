import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./db.ts";

/**
 * Server-side sessions of the parent cabinet (the public site's BFF). Only the SHA-256 of the opaque session id is stored,
 * and FastAPI tokens and the CSRF token are sealed with AES-256-GCM. The key is passed in; it is never stored here.
 */

const ID_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_TTL_SECONDS = 24 * 3600;

export interface ParentSessionRecord {
  userId: string;
  csrf: string;
  access: string;
  refresh: string;
  accessExpiresAt: Date;
}

export class ParentSessionInputError extends Error {
  constructor(field: string) {
    super(`parent_session_invalid:${field}`);
    this.name = "ParentSessionInputError";
  }
}

/** AES-256-GCM. Output: base64url(iv[12] | tag[16] | ciphertext). Tampering makes `open` throw. */
export class SessionSealer {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("parent session key must be 32 bytes");
    this.key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  open(sealed: string): string {
    const buf = Buffer.from(sealed, "base64url");
    if (buf.length < 12 + 16 + 1) throw new Error("sealed value too short");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** PARENT_SESSION_ENC_KEY: 32 random bytes, base64. Refuses anything else. */
export function sealerFromEnv(env: Record<string, string | undefined> = process.env): SessionSealer {
  const raw = (env.PARENT_SESSION_ENC_KEY ?? "").trim();
  const key = Buffer.from(raw, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || key.length !== 32) throw new Error("PARENT_SESSION_ENC_KEY must be 32 random bytes, base64");
  return new SessionSealer(key);
}

/** The database never sees the session id, only this digest. */
export function sessionHash(sid: string): Buffer {
  return createHash("sha256").update(sid).digest();
}

function checkSid(sid: string): void {
  if (!ID_RE.test(sid)) throw new ParentSessionInputError("sid");
}

export interface CreateInput {
  sid: string;
  userId: string;
  csrf: string;
  access: string;
  refresh: string;
  accessExpiresAt: Date;
  ttlSeconds: number;
}

export async function createParentSession(db: Queryable, sealer: SessionSealer, input: CreateInput): Promise<void> {
  checkSid(input.sid);
  if (!input.userId || input.userId.length > 64) throw new ParentSessionInputError("userId");
  if (!input.csrf || input.csrf.length > 200) throw new ParentSessionInputError("csrf");
  if (!input.access || input.access.length > 2000) throw new ParentSessionInputError("access");
  if (!input.refresh || input.refresh.length > 2000) throw new ParentSessionInputError("refresh");
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > MAX_TTL_SECONDS) throw new ParentSessionInputError("ttl");
  await db.query(
    `INSERT INTO bb.parent_sessions (session_hash, mobile_user_id, csrf_enc, access_enc, refresh_enc, access_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [
      sessionHash(input.sid),
      input.userId,
      sealer.seal(input.csrf),
      sealer.seal(input.access),
      sealer.seal(input.refresh),
      input.accessExpiresAt,
      input.ttlSeconds,
    ],
  );
}

/** A live session (not revoked, not expired) or null. A row that cannot be opened is an error, not a session. */
export async function lookupParentSession(db: Queryable, sealer: SessionSealer, sid: string): Promise<ParentSessionRecord | null> {
  checkSid(sid);
  const { rows } = await db.query<{ mobile_user_id: string; csrf_enc: string; access_enc: string; refresh_enc: string; access_expires_at: Date }>(
    `SELECT mobile_user_id, csrf_enc, access_enc, refresh_enc, access_expires_at
       FROM bb.parent_sessions
      WHERE session_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionHash(sid)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.mobile_user_id,
    csrf: sealer.open(row.csrf_enc),
    access: sealer.open(row.access_enc),
    refresh: sealer.open(row.refresh_enc),
    accessExpiresAt: row.access_expires_at,
  };
}

/** Replaces the FastAPI tokens after a refresh (the refresh token rotates). Returns false when the session is not live. */
export async function rotateParentTokens(
  db: Queryable,
  sealer: SessionSealer,
  sid: string,
  input: { access: string; refresh: string; accessExpiresAt: Date },
): Promise<boolean> {
  checkSid(sid);
  if (!input.access || input.access.length > 2000) throw new ParentSessionInputError("access");
  if (!input.refresh || input.refresh.length > 2000) throw new ParentSessionInputError("refresh");
  const { rowCount } = await db.query(
    `UPDATE bb.parent_sessions
        SET access_enc = $2, refresh_enc = $3, access_expires_at = $4
      WHERE session_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionHash(sid), sealer.seal(input.access), sealer.seal(input.refresh), input.accessExpiresAt],
  );
  return (rowCount ?? 0) === 1;
}

/** Idempotent: revoking an unknown or already revoked session changes nothing and is not an error. */
export async function revokeParentSession(db: Queryable, sid: string): Promise<void> {
  checkSid(sid);
  await db.query("UPDATE bb.parent_sessions SET revoked_at = now() WHERE session_hash = $1 AND revoked_at IS NULL", [sessionHash(sid)]);
}

/** A fresh opaque id for the browser: 32 random bytes, URL-safe. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}
