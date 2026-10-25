import { NextRequest, NextResponse } from "next/server";
import { revokePasskey } from "@/core/passkeys";
import { getSession } from "@/server/dal";
import { getPool } from "@/server/db";
import { webAuthnConfig } from "@/server/env";
import { requestMeta } from "@/server/request";
import { hasExpectedOrigin } from "@/server/webauthn-http";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = webAuthnConfig();
  } catch {
    return NextResponse.json({ error: "passkey_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!hasExpectedOrigin(request, config.origin)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const body = await request.json().catch(() => null);
  const id = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  try {
    await revokePasskey(getPool(), session.user.id, id, await requestMeta());
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "passkey_not_found" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
