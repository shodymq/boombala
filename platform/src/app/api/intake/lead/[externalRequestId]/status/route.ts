import { externalLeadStatus } from "../../../../../../core/intake.ts";
import { intakeSourceFromBearer } from "../../../../../../core/intake-auth.ts";
import { json } from "../../../../../../server/api.ts";
import { getPool } from "../../../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only status of an enquiry. The bearer token's source must be the enquiry's source: an unknown id and a foreign source
 * both answer 404 with the same body, so ids cannot be probed. Returns the status and when it last changed, nothing else.
 */
export async function GET(request: Request, { params }: { params: Promise<{ externalRequestId: string }> }) {
  const source = intakeSourceFromBearer(request);
  if (!source) return json({ ok: false, error: "unauthorized" }, 401);
  const { externalRequestId } = await params;
  const status = UUID.test(externalRequestId) ? await externalLeadStatus(getPool(), source, externalRequestId) : null;
  if (!status) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, status: status.status, statusChangedAt: status.statusChangedAt.toISOString() });
}
