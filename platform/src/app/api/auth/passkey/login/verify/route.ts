import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { finishPasskeyLogin, PasskeyLockedError } from "@/core/passkeys";
import { getPendingSession } from "@/server/dal";
import { getPool } from "@/server/db";
import { SESSION_COOKIE, isHttps, webAuthnConfig } from "@/server/env";
import { requestMeta } from "@/server/request";
import { hasExpectedOrigin, hasResponseShape } from "@/server/webauthn-http";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = webAuthnConfig();
  } catch {
    return NextResponse.json({ error: "passkey_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!hasExpectedOrigin(request, config.origin)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const pending = await getPendingSession();
  if (!pending) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const body = await request.json().catch(() => null);
  if (!hasResponseShape(body)) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const result = await finishPasskeyLogin(
      getPool(),
      { userId: pending.user.id, pendingToken: (await cookies()).get(SESSION_COOKIE)?.value ?? "", response: body.response as unknown as AuthenticationResponseJSON, config },
      await requestMeta(),
    );
    (await cookies()).set(SESSION_COOKIE, result.token, { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", expires: result.expiresAt });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PasskeyLockedError) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSeconds) } });
    return NextResponse.json({ error: "passkey_invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
