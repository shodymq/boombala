import { after } from "next/server";
import { submitExternalLead, submitLead } from "../../../../core/intake.ts";
import { intakeSourceFromBearer } from "../../../../core/intake-auth.ts";
import { errorResponse, intakeEnabled, json, readJson, tryDeliver } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-to-server only. The bearer token selects the source: the public site (`PLATFORM_INTAKE_TOKEN`, idempotency by
 * `idempotencyKey`) or the mobile app (`PLATFORM_MOBILE_INTAKE_TOKEN`, idempotency by `external_request_id`). The body cannot
 * change the source. Success is returned after the database transaction has committed.
 */
export async function POST(request: Request) {
  const source = intakeSourceFromBearer(request);
  if (!source) return json({ ok: false, error: "unauthorized" }, 401);
  if (!intakeEnabled()) return json({ ok: false, error: "intake_disabled" }, 503);
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);
  if (body.source !== undefined && body.source !== source) return json({ ok: false, error: "source_mismatch" }, 403);
  try {
    const meta = {
      ip: typeof body.clientIp === "string" ? body.clientIp.slice(0, 64) : null,
      userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
      ipPepper: process.env.PLATFORM_IP_PEPPER,
      fingerprintSecret: process.env.PLATFORM_INTAKE_FINGERPRINT_SECRET,
    };
    const result = source === "mobile_app" ? await submitExternalLead(getPool(), body, meta) : await submitLead(getPool(), body as never, meta);
    // Best-effort immediate Telegram message; the response does not wait for the retry machinery. Failures stay in the outbox.
    after(() => tryDeliver(result.duplicate ? undefined : result.leadId));
    return json({ ok: true, leadId: result.leadId, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
