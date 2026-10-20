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

function endpoint(path: string, env: Record<string, string | undefined> = process.env): { url: string; token: string } {
  const base = (env.PLATFORM_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.PLATFORM_INTAKE_TOKEN ?? "").trim();
  const safeBase = /^https:\/\/[^/]+$/.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
  if (!safeBase || token.length < 24) throw new PlatformError("not_configured");
  return { url: `${base}${path}`, token };
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
  const { url, token } = endpoint(path);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
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
  phone: string;
  acceptRules: true;
  acceptPersonalData: true;
  clientIp: string;
  userAgent: string;
}): Promise<{ duplicate: boolean }> {
  const { status, data } = await call("/api/intake/consent", { method: "POST", body: input }, 7000);
  if (status === 200 || status === 201) return { duplicate: data.duplicate === true };
  return fail(status, data);
}
