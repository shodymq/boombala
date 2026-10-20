import { timingSafeEqual, createHash } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { newsEnabled } from "@/lib/platform";

export const runtime = "nodejs";

/** Called by the platform after publish / edit / unpublish / delete so a takedown shows up immediately. */
export async function POST(request: Request) {
  if (!newsEnabled()) return Response.json({ ok: false }, { status: 404 });
  const secret = (process.env.PLATFORM_INTAKE_TOKEN ?? "").trim();
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const same = secret.length >= 24 && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());
  if (!same) return Response.json({ ok: false }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { slugs?: unknown };
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s): s is string => typeof s === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)).slice(0, 10) : [];
  revalidateTag("news", { expire: 0 }); // cached platform answers are dropped, not served stale
  revalidatePath("/news");
  for (const slug of slugs) revalidatePath(`/news/${slug}`);
  revalidatePath("/sitemap.xml");
  return Response.json({ ok: true });
}
