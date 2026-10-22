import "server-only";
import { getVercelOidcToken } from "@vercel/oidc";

/**
 * Server-to-server client for the Boom Bala platform (CRM). Used only from route handlers, never from the browser:
 * the intake token must not reach a visitor, and personal data is sent only by our server.
 *
 * LEAD_PIPELINE: `telegram-only` (default: today's behaviour, nothing is sent to the platform),
 *                `dual`   (platform first, direct Telegram as a fallback so an enquiry is never lost),
 *                `strict` (platform only).
 */
export type LeadPipeline = "telegram-only" | "dual" | "strict";

export function leadPipeline(env: Record<string, string | undefined> = process.env): LeadPipeline {
  const v = (env.LEAD_PIPELINE ?? "").trim();
  return v === "dual" || v === "strict" ? v : "telegram-only";
}

export type PlatformFailure = "not_configured" | "unavailable" | "disabled" | "consent_unavailable" | "rejected";

export class PlatformError extends Error {
  constructor(readonly kind: PlatformFailure) {
    super(`platform:${kind}`);
    this.name = "PlatformError";
  }
}

async function endpoint(path: string, env: Record<string, string | undefined> = process.env): Promise<{ url: string; token: string; oidcToken: string }> {
  const base = (env.PLATFORM_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.PLATFORM_INTAKE_TOKEN ?? "").trim();
  const safeBase = /^https:\/\/[^/]+$/.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
  if (!safeBase || token.length < 24) throw new PlatformError("not_configured");
  // The trusted-OIDC header exists only for protected Vercel Previews. On our own server (Kazakhstan) it must never be requested:
  // outside Vercel the library would look for a token and call a Vercel service on every request.
  const oidcToken = process.env.VERCEL === "1" ? await getVercelOidcToken().catch(() => "") : "";
  return { url: `${base}${path}`, token, oidcToken };
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
  const { url, token, oidcToken } = await endpoint(path);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(oidcToken ? { "x-vercel-trusted-oidc-idp-token": oidcToken } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    throw new PlatformError("unavailable"); // the original error may contain the URL; drop it
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

function fail(status: number, data: Record<string, unknown>): never {
  if (status === 503 && data.error === "intake_disabled") throw new PlatformError("disabled");
  if (status === 503 && data.error === "consent_unavailable") throw new PlatformError("consent_unavailable");
  if (status >= 500 || status === 401) throw new PlatformError("unavailable");
  throw new PlatformError("rejected");
}

export interface PlatformLead {
  idempotencyKey: string;
  name: string;
  phone: string;
  date: string;
  children: number | null;
  packageId: string;
  roomId: string | null;
  slotId: number | null;
  page: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  clientIp: string;
  userAgent: string;
}

/** Resolves only after the platform has COMMITTED the enquiry (HTTP 2xx). Anything else throws PlatformError. */
export async function sendLeadToPlatform(lead: PlatformLead): Promise<{ duplicate: boolean }> {
  const { status, data } = await call("/api/intake/lead", { method: "POST", body: { ...lead, consent: true } }, 7000);
  if (status === 200 || status === 201) return { duplicate: data.duplicate === true };
  return fail(status, data);
}

export interface PlatformDocument {
  kind: string;
  version: number;
  title: string;
  body: string;
}

export async function fetchPublishedDocuments(): Promise<PlatformDocument[]> {
  const { status, data } = await call("/api/public/legal", { method: "GET" }, 5000);
  if (status !== 200 || !Array.isArray(data.documents)) return fail(status, data);
  return data.documents as PlatformDocument[];
}

export async function sendConsentToPlatform(input: {
  idempotencyKey: string;
  name: string;
  /** Optional: the QR registration may be made without a phone. */
  phone?: string | null;
  acceptRules: true;
  acceptPersonalData: true;
  clientIp: string;
  userAgent: string;
}): Promise<{ duplicate: boolean }> {
  const { status, data } = await call("/api/intake/consent", { method: "POST", body: input }, 7000);
  if (status === 200 || status === 201) return { duplicate: data.duplicate === true };
  return fail(status, data);
}

/** Availability for the public calendar. Throws PlatformError when the platform cannot answer: the UI then says so (never "free"). */
export async function fetchAvailability(query: { date: string } | { month: string }): Promise<Record<string, unknown>> {
  const qs = "date" in query ? `date=${encodeURIComponent(query.date)}` : `month=${encodeURIComponent(query.month)}`;
  const { status, data } = await call(`/api/public/availability?${qs}`, { method: "GET" }, 5000);
  if (status !== 200 || data.ok !== true) return fail(status, data);
  return data;
}

// ── News (published content only; the platform decides what is public) ────────────────────────────────────────

export type NewsKind = "news" | "promo";
export interface NewsSummary {
  slug: string;
  kind: NewsKind;
  title: string;
  excerpt: string;
  publishedAt: string;
  validUntil: string | null;
  cover: { id: string; alt: string; width: number; height: number } | null;
}
export type NewsInline = { t: "text"; v: string } | { t: "strong"; v: string } | { t: "link"; href: string; v: string } | { t: "br" };
export type NewsBlock =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; inlines: NewsInline[] }
  | { type: "ul"; items: NewsInline[][] }
  | { type: "img"; imageId: string; alt: string; width: number; height: number };
export interface NewsPost extends NewsSummary {
  blocks: NewsBlock[];
  updatedAt: string;
  seoTitle: string | null;
  seoDescription: string;
  expired: boolean;
}

export const newsEnabled = (): boolean => process.env.NEXT_PUBLIC_NEWS === "1";

/** Cached for a minute and tagged "news" so the platform can refresh it on demand (publish, edit, unpublish). */
async function cachedGet(path: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const { url, token, oidcToken } = await endpoint(path);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, ...(oidcToken ? { "x-vercel-trusted-oidc-idp-token": oidcToken } : {}) },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 60, tags: ["news"] },
      redirect: "manual",
    });
  } catch {
    throw new PlatformError("unavailable");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export async function fetchNewsList(kind?: NewsKind, limit = 30): Promise<NewsSummary[]> {
  const { status, data } = await cachedGet(`/api/public/news?limit=${limit}${kind ? `&kind=${kind}` : ""}`);
  if (status !== 200 || !Array.isArray(data.posts)) throw new PlatformError("unavailable");
  return data.posts as NewsSummary[];
}

/** `null` = the platform answered and there is no such PUBLISHED post. A platform failure throws (never shown as "not found"). */
export async function fetchNewsPost(slug: string): Promise<NewsPost | null> {
  const { status, data } = await cachedGet(`/api/public/news/${encodeURIComponent(slug)}`);
  if (status === 404) return null;
  if (status !== 200 || !data.post) throw new PlatformError("unavailable");
  return data.post as NewsPost;
}

export async function fetchNewsSlugs(): Promise<Array<{ slug: string; updatedAt: string }>> {
  const { status, data } = await cachedGet("/api/public/news?slugs=1");
  if (status !== 200 || !Array.isArray(data.posts)) throw new PlatformError("unavailable");
  return data.posts as Array<{ slug: string; updatedAt: string }>;
}

/** Image bytes for the public proxy route. */
export async function fetchNewsImage(id: string): Promise<{ status: number; contentType: string; body: ArrayBuffer | null }> {
  const { url, token, oidcToken } = await endpoint(`/api/public/news/image/${encodeURIComponent(id)}`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, ...(oidcToken ? { "x-vercel-trusted-oidc-idp-token": oidcToken } : {}) },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    throw new PlatformError("unavailable");
  }
  if (!res.ok) return { status: res.status === 404 ? 404 : 502, contentType: "", body: null };
  return { status: 200, contentType: res.headers.get("content-type") ?? "application/octet-stream", body: await res.arrayBuffer() };
}
