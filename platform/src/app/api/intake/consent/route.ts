import { submitConsent } from "../../../../core/intake.ts";
import { bearerOk, errorResponse, intakeEnabled, json, readJson } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** QR registration (server-to-server). Saves the contact and one consent event per accepted document version. */
export async function POST(request: Request) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!intakeEnabled()) return json({ ok: false, error: "intake_disabled" }, 503);
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);
  try {
    const result = await submitConsent(getPool(), body as never, {
      ip: typeof body.clientIp === "string" ? body.clientIp.slice(0, 64) : null,
      userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
      ipPepper: process.env.PLATFORM_IP_PEPPER,
    });
    return json({ ok: true, registrationId: result.registrationId, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
