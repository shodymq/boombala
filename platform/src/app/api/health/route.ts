import { getPool } from "../../../server/db.ts";
import { bridgeHealth, legacyBridgeEnabled } from "../../../server/bridge-client.ts";

export const dynamic = "force-dynamic";

/** Liveness + database check for monitoring. Reveals nothing about the data or the configuration. */
export async function GET() {
  try {
    if (legacyBridgeEnabled()) await bridgeHealth();
    else await getPool().query("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
