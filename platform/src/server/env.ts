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
