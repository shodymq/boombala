import "server-only";
import { passkeyConfigFromEnv, passkeyConfigProblems } from "../core/passkey-config.ts";

/** Set `PLATFORM_HTTPS=1` when the app is served over HTTPS (always in production behind the reverse proxy). */
export const isHttps = process.env.PLATFORM_HTTPS === "1";

/** `__Host-` cookies require Secure + Path=/ and therefore HTTPS. Plain name for local http development. */
export const SESSION_COOKIE = isHttps ? "__Host-bb_session" : "bb_session";

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * `MFA_MODE=required`: every staff login needs a second factor (TOTP). It is `off` only for local development and the
 * existing Preview; the Kazakhstan production profile refuses to start without `required` (see server/exposure.ts).
 */
export const mfaRequired = process.env.MFA_MODE === "required";
/** AES-256-GCM key (32 bytes, base64) that encrypts TOTP secrets in the database. Only the admin app has it. */
export const mfaKey = process.env.MFA_ENC_KEY;

/**
 * Passkeys (Face ID / Touch ID). Off unless PASSKEYS_ENABLED=1; the RP ID and the origins come only from here (never from a request).
 * `passkeyProblems` is empty when the configuration is usable; the pages and endpoints treat a non-empty list as "passkeys unavailable".
 */
export const passkeys = passkeyConfigFromEnv();
export const passkeyProblems = passkeyConfigProblems(passkeys, { production: process.env.PLATFORM_PROFILE === "kz-production" });
export const passkeysAvailable = passkeys.enabled && passkeyProblems.length === 0;
