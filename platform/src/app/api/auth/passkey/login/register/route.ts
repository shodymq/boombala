import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { finishPasskeyRegistration, PasskeyLockedError } from "@/core/passkeys";
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
  const label = typeof (body as { label?: unknown }).label === "string" ? (body as { label: string }).label : "Это устройство";
  try {
    const result = await finishPasskeyRegistration(
      getPool(),
      { userId: pending.user.id, pendingToken: (await cookies()).get(SESSION_COOKIE)?.value, response: body.response as unknown as RegistrationResponseJSON, label, config },
      await requestMeta(),
    );
    if (!result.token || !result.expiresAt) throw new Error("missing session");
    (await cookies()).set(SESSION_COOKIE, result.token, { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", expires: result.expiresAt });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PasskeyLockedError) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSeconds) } });
    const code = (error as { message?: string }).message === "passkey_exists" ? "passkey_exists" : "passkey_invalid";
    return NextResponse.json({ error: code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
