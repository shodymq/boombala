import { fetchNewsImage, newsEnabled } from "@/lib/platform";

export const runtime = "nodejs";

/** Public picture of a PUBLISHED post, fetched from the platform (which refuses everything else). Short cache so takedowns are quick. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!newsEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return new Response(null, { status: 404 });
  try {
    const img = await fetchNewsImage(id);
    if (img.status !== 200 || !img.body) return new Response(null, { status: img.status });
    return new Response(img.body, {
      headers: { "Content-Type": img.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=300, s-maxage=300" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
