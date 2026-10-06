/**
 * Canonical origin for metadata, sitemap and robots.
 * Production metadata must always point at the canonical public host. The
 * optional override is intentionally limited to local development so a
 * Vercel preview can never become canonical or appear in the sitemap.
 */
const PRODUCTION_URL = "https://boombala.kz";

export function getSiteUrl(): string {
  if (process.env.NODE_ENV === "production") return PRODUCTION_URL;
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  return explicit ? explicit.replace(/\/$/, "") : "http://localhost:3000";
}
