import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The pending phone login (phone + FastAPI verification id) lives in the browser as ONE sealed, HttpOnly cookie, so any
 * process can finish the login. It is encrypted and authenticated (AES-256-GCM) with a key derived from PARENT_PENDING_KEY,
 * which only the public site holds (not the platform, not the database). It expires by itself.
 */

export interface PendingPayload {
  phone: string;
  verificationId: string;
  /** Epoch ms. */
  expiresAt: number;
}

const INFO = "boombala.parent.pending.v1";

export class PendingSealer {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("PARENT_PENDING_KEY must be 32 random bytes");
    this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), INFO, 32));
  }

  seal(payload: PendingPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  /** The payload if it is authentic and not expired; otherwise null. Never throws on a bad cookie. */
  open(value: string | undefined, now: number = Date.now()): PendingPayload | null {
    if (!value || value.length > 2000) return null;
    try {
      const buf = Buffer.from(value, "base64url");
      if (buf.length < 12 + 16 + 2) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
      const p = JSON.parse(json) as Partial<PendingPayload>;
      if (typeof p.phone !== "string" || typeof p.verificationId !== "string" || typeof p.expiresAt !== "number") return null;
      if (p.expiresAt <= now) return null;
      return { phone: p.phone, verificationId: p.verificationId, expiresAt: p.expiresAt };
    } catch {
      return null;
    }
  }
}

export function pendingSealerFromEnv(env: Record<string, string | undefined>): PendingSealer {
  const raw = (env.PARENT_PENDING_KEY ?? "").trim();
  const key = Buffer.from(raw, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || key.length !== 32) throw new Error("PARENT_PENDING_KEY must be 32 random bytes, base64");
  return new PendingSealer(key);
}
