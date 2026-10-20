import { after } from "next/server";
import { submitLead } from "../../../../core/intake.ts";
import { bearerOk, errorResponse, intakeEnabled, json, readJson, tryDeliver } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-to-server only (the public site). Success is returned after the database transaction has committed. */
export async function POST(request: Request) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!intakeEnabled()) return json({ ok: false, error: "intake_disabled" }, 503);
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);
  try {
    const meta = {
      ip: typeof body.clientIp === "string" ? body.clientIp.slice(0, 64) : null,
      userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
      ipPepper: process.env.PLATFORM_IP_PEPPER,
    };
    const result = await submitLead(getPool(), body as never, meta);
    // Best-effort immediate Telegram message; the response does not wait for the retry machinery. Failures stay in the outbox.
    after(() => tryDeliver(result.duplicate ? undefined : result.leadId));
    return json({ ok: true, leadId: result.leadId, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
