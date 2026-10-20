import { ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { MAX_UPLOAD_BYTES } from "../../../core/images.ts";
import { addImage } from "../../../core/news.ts";
import { can } from "../../../core/rbac.ts";
import { getSession } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const back = (request: Request, query: string) => new Response(null, { status: 303, headers: { Location: new URL(`/news/media?${query}`, request.url).toString() } });

/** Image upload from the admin form. Same-origin POST, staff session with news permission, 4 MB cap, re-encoded server side. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.headers.get("host")) return new Response(null, { status: 403 });
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  if (!can(session.user.role, "news.manage")) return new Response(null, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) return back(request, "error=too_big");
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError({ file: "Выберите файл" });
    await addImage(getPool(), { id: session.user.id, role: session.user.role }, Buffer.from(await file.arrayBuffer()), String(form.get("alt") ?? ""), await requestMeta());
    return back(request, "notice=uploaded");
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(null, { status: 403 });
    if (error instanceof ValidationError) return back(request, `error=${"alt" in error.fields ? "alt" : "file"}`);
    return back(request, "error=failed");
  }
}
