import { getPublished } from "../../../../core/legal.ts";
import { bearerOk, json } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Published legal documents (no personal data). Server-to-server for the site's /consent page. */
export async function GET(request: Request) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  const docs = await getPublished(getPool());
  return json({ ok: true, documents: docs.map((d) => ({ kind: d.kind, version: d.version, title: d.title, body: d.body, publishedAt: d.publishedAt })) });
}
