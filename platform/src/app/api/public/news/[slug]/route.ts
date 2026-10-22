import { publicPost } from "../../../../../core/news.ts";
import { bearerOk, json } from "../../../../../server/api.ts";
import { getPool } from "../../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  const { slug } = await params;
  try {
    const post = await publicPost(getPool(), slug);
    return post ? json({ ok: true, post }) : json({ ok: false, error: "not_found" }, 404);
  } catch {
    console.error(JSON.stringify({ event: "news.public_error" }));
    return json({ ok: false, error: "server" }, 500);
  }
}
