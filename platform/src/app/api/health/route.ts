import { getPool } from "../../../server/db.ts";

export const dynamic = "force-dynamic";

/** Liveness + database check for monitoring. Reveals nothing about the data or the configuration. */
export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
