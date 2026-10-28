import { NextResponse } from "next/server";
import { beginPasskeyRegistration } from "@/core/passkeys";
import { getSession } from "@/server/dal";
import { getPool } from "@/server/db";
import { webAuthnConfig } from "@/server/env";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const options = await beginPasskeyRegistration(getPool(), session.user.id, webAuthnConfig());
    return NextResponse.json(options, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "passkey_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
