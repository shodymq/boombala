/**
 * Canonical origin for metadata, sitemap and robots.
 * NEXT_PUBLIC_SITE_URL overrides; production builds default to the real domain;
 * local development uses localhost.
 */
const PRODUCTION_URL = "https://boombala.kz";

export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return process.env.NODE_ENV === "production" ? PRODUCTION_URL : "http://localhost:3000";
}
