import { fastapiClient } from "@/lib/fastapi";
import { FastapiError, verifyOtp } from "@/lib/fastapi/core.ts";
import { guardPost, SessionStoreUnavailable } from "@/lib/parent/core";
import { failureResponse, guardResponse, hostOf, json, notFoundJson, readJsonBody } from "@/lib/parent/http";
import { clearPendingLogin, currentPendingLogin, establishSession, parentState } from "@/lib/parent/server";
import { rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_LIMIT = 10;

/** Completes the phone login. Tokens go to the server-side session; the browser gets a CSRF token and nothing else. */
export async function POST(request: Request) {
  if (!parentState().enabled) return notFoundJson();

  const guard = guardPost({
    origin: request.headers.get("origin"),
    host: hostOf(request.headers),
    contentType: request.headers.get("content-type"),
  });
  if (guard) return guardResponse(guard);

  const body = await readJsonBody(request);
  const code = body && typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: "invalid_code" }, 400);

  const pending = await currentPendingLogin();
  if (!pending) return json({ ok: false, error: "login_expired" }, 400);

  const key = `parent-verify:${pending.phone}`;
  if (!rateLimitCheck(key, CODE_LIMIT).ok) return json({ ok: false, error: "rate_limited" }, 429);
  rateLimitRecord(key);

  try {
    const auth = await verifyOtp(fastapiClient(), { phone: pending.phone, code, verification_id: pending.verificationId });
    const { csrfToken } = await establishSession(auth);
    await clearPendingLogin();
    return json({ ok: true, csrfToken });
  } catch (error) {
    if (error instanceof SessionStoreUnavailable) return json({ ok: false, error: "unavailable" }, 503);
    if (error instanceof FastapiError && error.kind === "rejected" && (error.status === 400 || error.status === 401 || error.status === 422)) {
      return json({ ok: false, error: "invalid_code" }, 401);
    }
    return failureResponse(error);
  }
}
