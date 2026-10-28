import "server-only";

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
 * `MFA_MODE=required`: production staff accounts retain TOTP/recovery as a recovery factor. `PASSKEY_MODE=required`
 * selects WebAuthn as the normal second factor without deleting existing TOTP material.
 */
export const mfaRequired = process.env.MFA_MODE === "required";
/** WebAuthn is the normal second factor when PASSKEY_MODE=required. */
export const passkeyRequired = process.env.PASSKEY_MODE === "required";
/** AES-256-GCM key (32 bytes, base64) that encrypts TOTP secrets in the database. Only the admin app has it. */
export const mfaKey = process.env.MFA_ENC_KEY;

export interface WebAuthnConfig {
  rpID: string;
  origin: string;
  rpName: string;
}

export function webAuthnConfig(): WebAuthnConfig {
  const rpID = process.env.WEBAUTHN_RP_ID?.trim();
  const origin = process.env.WEBAUTHN_ORIGIN?.trim();
  const rpName = process.env.WEBAUTHN_RP_NAME?.trim() || "Boom Bala CRM";
  if (!rpID || !origin || !/^https:\/\//i.test(origin)) throw new Error("WebAuthn production configuration is incomplete");
  return { rpID, origin, rpName };
}
