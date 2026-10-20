import { adminImage } from "../../../../core/news.ts";
import { can } from "../../../../core/rbac.ts";
import { getSession } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Picture for the admin preview: staff session with news permission only (drafts must not leak). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !can(session.user.role, "news.manage")) return new Response(null, { status: 401 });
  const { id } = await params;
  const img = await adminImage(getPool(), { id: session.user.id, role: session.user.role }, id);
  if (!img) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(img.data), { headers: { "Content-Type": img.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
}
