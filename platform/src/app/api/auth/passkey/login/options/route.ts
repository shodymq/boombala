import { NextResponse } from "next/server";
import { beginPasskeyLogin } from "@/core/passkeys";
import { getPendingSession } from "@/server/dal";
import { getPool } from "@/server/db";
import { webAuthnConfig } from "@/server/env";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const pending = await getPendingSession();
  if (!pending) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const result = await beginPasskeyLogin(getPool(), pending.user.id, webAuthnConfig());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "passkey_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
