import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors.ts";
import { json, readJson } from "./api.ts";
import { passkeyProblems, passkeys, SESSION_COOKIE } from "./env.ts";

/** Common checks of the four passkey endpoints: enabled and well configured, a same-origin JSON POST of a sane size. */
export async function passkeyRequest(request: Request): Promise<{ body: Record<string, unknown> } | NextResponse> {
  if (!passkeys.enabled) return json({ ok: false, error: "disabled" }, 404);
  if (passkeyProblems.length) return json({ ok: false, error: "misconfigured" }, 503);
  // The browser always sends Origin on a POST; it must be exactly one of the configured origins (a cross-site page cannot ask for a sign-in).
  const origin = request.headers.get("origin");
  if (!origin || !passkeys.origins.includes(origin)) return json({ ok: false, error: "origin" }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ ok: false, error: "content_type" }, 415);
  const body = await readJson(request, 16_000);
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_request" }, 400);
  return { body: body as Record<string, unknown> };
}

/**
 * Guard for the endpoints that are not WebAuthn ceremonies themselves (step-up by code, revocation, enrolment codes): a same-origin JSON POST of a
 * sane size. They work whether or not passkeys are switched on (the enrolment code and the code step-up do not need them).
 */
export async function jsonPost(request: Request): Promise<{ body: Record<string, unknown> } | NextResponse> {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let ok = false;
  try {
    ok = !!origin && !!host && new URL(origin).host === host;
  } catch {
    ok = false;
  }
  if (!ok) return json({ ok: false, error: "origin" }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ ok: false, error: "content_type" }, 415);
  const body = await readJson(request, 16_000);
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_request" }, 400);
  return { body: body as Record<string, unknown> };
}

export async function sessionCookieValue(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Domain errors to answers; no stack, SQL or detail reaches the browser. */
export function passkeyError(error: unknown): NextResponse {
  if (error instanceof ValidationError) return json({ ok: false, error: "validation", fields: error.fields }, 422);
  if (error instanceof ForbiddenError) return json({ ok: false, error: error.message === "step_up_required" ? "step_up_required" : "forbidden" }, error.message === "step_up_required" ? 401 : 403);
  if (error instanceof NotFoundError) return json({ ok: false, error: "not_found" }, 404);
  if (error instanceof ConflictError) {
    const locked = /^locked:(\d+)$/.exec(error.message);
    if (locked) return json({ ok: false, error: "locked", retryAfterSeconds: Number(locked[1]) }, 429);
    return json({ ok: false, error: error.message === "conflict" ? "conflict" : error.message }, 409);
  }
  console.error(JSON.stringify({ event: "passkey.error", name: error instanceof Error ? error.name : "unknown" }));
  return json({ ok: false, error: "server" }, 500);
}
