import { publicImage } from "../../../../../../core/news.ts";
import { bearerOk } from "../../../../../../server/api.ts";
import { getPool } from "../../../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bytes of a picture that a PUBLISHED post uses. Anything else (drafts, unused uploads) is a plain 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return new Response(null, { status: 401 });
  const { id } = await params;
  try {
    const img = await publicImage(getPool(), id);
    if (!img) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(img.data), { headers: { "Content-Type": img.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  } catch {
    return new Response(null, { status: 500 });
  }
}
