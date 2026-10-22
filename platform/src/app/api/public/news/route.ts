import { publicList, publicSlugs } from "../../../../core/news.ts";
import { bearerOk, json } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Published news and promotions for the public site (server-to-server). `?slugs=1` returns only addresses for the sitemap. */
export async function GET(request: Request) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("slugs") === "1") return json({ ok: true, posts: await publicSlugs(getPool()) });
    const kind = url.searchParams.get("kind");
    const posts = await publicList(getPool(), {
      kind: kind === "news" || kind === "promo" ? kind : undefined,
      limit: Number(url.searchParams.get("limit")) || 20,
      offset: Number(url.searchParams.get("offset")) || 0,
    });
    return json({ ok: true, posts });
  } catch {
    console.error(JSON.stringify({ event: "news.public_error" }));
    return json({ ok: false, error: "server" }, 500);
  }
}
