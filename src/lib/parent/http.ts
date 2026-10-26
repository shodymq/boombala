import "server-only";
import { FastapiError } from "../fastapi/core.ts";

/** JSON answers for the parent BFF: no store, and only error CODES (never messages that could echo input). */
export const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const notFoundJson = () => json({ ok: false, error: "not_found" }, 404);

export function hostOf(headers: Headers): string | null {
  return headers.get("x-forwarded-host") ?? headers.get("host");
}

export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

/** Small JSON object bodies only. Anything else is null. */
export async function readJsonBody(request: Request, maxBytes = 2048): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function guardResponse(failure: "forbidden_origin" | "unsupported_media_type" | "forbidden_csrf") {
  if (failure === "unsupported_media_type") return json({ ok: false, error: "unsupported_media_type" }, 415);
  if (failure === "forbidden_csrf") return json({ ok: false, error: "forbidden" }, 403);
  return json({ ok: false, error: "forbidden" }, 403);
}

/** Maps a failed FastAPI call to an answer that tells the browser what to do, without exposing the upstream details. */
export function failureResponse(error: unknown) {
  if (error instanceof FastapiError) {
    if (error.kind === "rejected" && error.status === 429) return json({ ok: false, error: "rate_limited" }, 429);
    if (error.kind === "rejected") return json({ ok: false, error: "invalid_request" }, 400);
  }
  return json({ ok: false, error: "unavailable" }, 503);
}
