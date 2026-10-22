import "server-only";
import { getVercelOidcToken } from "@vercel/oidc";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ConsentUnavailableError, ValidationError } from "../core/errors.ts";
import { telegramConfigFromEnv, sendTelegram } from "../core/telegram.ts";
import { drainOutbox } from "../core/outbox.ts";
import { getPool } from "./db.ts";

/** Constant-time check of `Authorization: Bearer <secret>` against an environment secret. A missing secret denies everything. */
export function bearerOk(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 24) return false;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Personal data is accepted only when the owner has explicitly switched it on. */
export const intakeEnabled = () => process.env.PII_INTAKE_ENABLED === "1";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function readJson(request: Request, maxBytes = 8_000): Promise<unknown | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Maps domain errors to HTTP answers. Unknown errors become a bare 500 and are logged without the payload. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ValidationError) return json({ ok: false, error: "validation", fields: error.fields }, 422);
  if (error instanceof ConsentUnavailableError) return json({ ok: false, error: "consent_unavailable" }, 503);
  console.error(JSON.stringify({ event: "api.error", name: error instanceof Error ? error.name : "unknown" }));
  return json({ ok: false, error: "server" }, 500);
}

export const notifyLevel = (): "full" | "minimal" => (process.env.TELEGRAM_NOTIFY_LEVEL === "minimal" ? "minimal" : "full");

/** Immediate best-effort delivery for one enquiry (bounded); anything that fails stays in the outbox for the retry worker. */
export async function tryDeliver(refId?: string): Promise<void> {
  const config = telegramConfigFromEnv();
  if (!config) return;
  try {
    await drainOutbox(getPool(), { send: (t) => sendTelegram(config, t, 4000), level: notifyLevel(), onlyRefId: refId, limit: refId ? 1 : 10 });
  } catch {
    /* the task is still in the outbox */
  }
}

/** Tells the public site to refresh its cached news pages (best effort: pages also refresh on their own every minute). */
export async function notifySite(slugs: string[]): Promise<void> {
  const base = (process.env.SITE_REVALIDATE_URL ?? "").trim().replace(/\/+$/, "");
  // The admin deployment holds REVALIDATE_TOKEN only; the shared intake token is the fallback for the current Preview.
  const token = process.env.REVALIDATE_TOKEN || process.env.PLATFORM_INTAKE_TOKEN;
  if (!/^https?:\/\/[^/]+$/.test(base) || !token) return;
  try {
    const oidcToken = await getVercelOidcToken().catch(() => "");
    await fetch(`${base}/api/revalidate-news`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(oidcToken ? { "x-vercel-trusted-oidc-idp-token": oidcToken } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slugs: slugs.slice(0, 10) }),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
  } catch {
    /* the site refreshes by itself within a minute */
  }
}
