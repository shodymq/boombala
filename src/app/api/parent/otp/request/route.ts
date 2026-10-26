import { fastapiClient } from "@/lib/fastapi";
import { requestOtp } from "@/lib/fastapi/core.ts";
import { guardPost, normalizeKzMobile } from "@/lib/parent/core";
import { clientIp, failureResponse, guardResponse, hostOf, json, notFoundJson, readJsonBody } from "@/lib/parent/http";
import { parentState, startPendingLogin } from "@/lib/parent/server";
import { rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 20;
const PHONE_LIMIT = 5;

/**
 * Starts a phone login: FastAPI sends the SMS (or refuses). The site keeps only the pending id in an HttpOnly cookie,
 * and answers the same way whether or not the number has an account (no enumeration).
 */
export async function POST(request: Request) {
  if (!parentState().enabled) return notFoundJson();

  const guard = guardPost({
    origin: request.headers.get("origin"),
    host: hostOf(request.headers),
    contentType: request.headers.get("content-type"),
  });
  if (guard) return guardResponse(guard);

  const body = await readJsonBody(request);
  const phone = body && typeof body.phone === "string" ? normalizeKzMobile(body.phone) : null;
  if (!phone) return json({ ok: false, error: "invalid_phone" }, 400);

  const ipKey = `parent-otp-ip:${clientIp(request.headers)}`;
  const phoneKey = `parent-otp-phone:${phone}`;
  if (!rateLimitCheck(ipKey, IP_LIMIT).ok || !rateLimitCheck(phoneKey, PHONE_LIMIT).ok) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }
  rateLimitRecord(ipKey);
  rateLimitRecord(phoneKey);

  try {
    const issued = await requestOtp(fastapiClient(), { phone });
    await startPendingLogin({ phone, verificationId: issued.verification_id });
    return json({ ok: true, expiresInSeconds: issued.expires_in_seconds, resendAfterSeconds: issued.resend_after_seconds });
  } catch (error) {
    return failureResponse(error);
  }
}
