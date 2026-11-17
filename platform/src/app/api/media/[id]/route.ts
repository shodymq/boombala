import { adminImage } from "../../../../core/news.ts";
import { can } from "../../../../core/rbac.ts";
import { getSession } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";
import { bridgeImage, LegacyBridgeError, legacyBridgeEnabled } from "../../../../server/bridge-client.ts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../../../server/env.ts";
import { json } from "../../../../server/api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Picture for the admin preview: staff session with news permission only (drafts must not leak). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !can(session.user.role, "news.manage")) return new Response(null, { status: 401 });
  const { id } = await params;
  if (legacyBridgeEnabled()) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return new Response(null, { status: 401 });
    try {
      const upstream = await bridgeImage(id, token);
      const headers = new Headers();
      for (const name of ["Content-Type", "Cache-Control", "X-Content-Type-Options"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      if (error instanceof LegacyBridgeError) return json({ ok: false, error: error.code }, error.status);
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  const img = await adminImage(getPool(), { id: session.user.id, role: session.user.role }, id);
  if (!img) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(img.data), { headers: { "Content-Type": img.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
}
