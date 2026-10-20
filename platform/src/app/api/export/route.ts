import { ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { exportContacts, type ExportFormat } from "../../../core/export.ts";
import { canExport } from "../../../core/rbac.ts";
import { json } from "../../../server/api.ts";
import { getSession } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Contact export. POST only, same-origin only (blocks cross-site form posts), staff session required, permission checked
 * again in the data layer. The file is a download, never rendered.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.headers.get("host")) return json({ ok: false, error: "origin" }, 403);
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  const user = session.user;
  if (!canExport(user)) return json({ ok: false, error: "forbidden" }, 403);

  const form = await request.formData();
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  try {
    const result = await exportContacts(
      getPool(),
      { id: user.id, role: user.role, canExport: user.canExport },
      {
        format: (str("format") ?? "csv") as ExportFormat,
        columns: form.getAll("columns").filter((v): v is string => typeof v === "string"),
        from: str("from"),
        to: str("to"),
        filters: { q: str("q"), source: str("source") as never, verification: str("verification") as never },
      },
      await requestMeta(),
    );
    return new Response(new Uint8Array(result.body), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return json({ ok: false, error: "forbidden" }, 403);
    if (error instanceof ValidationError) return json({ ok: false, error: "validation", fields: error.fields }, 422);
    return json({ ok: false, error: "server" }, 500);
  }
}
