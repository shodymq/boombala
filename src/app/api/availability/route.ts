import { fastapiClient } from "@/lib/fastapi";
import { getAvailabilityDay, getAvailabilityMonth } from "@/lib/fastapi/core.ts";
import { availabilitySource } from "@/lib/availability/source";
import { fetchAvailability, PlatformError } from "@/lib/platform";
import { rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";

export const runtime = "nodejs";

const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Availability proxy for the public calendar (the platform token never reaches the browser). Off unless
 * NEXT_PUBLIC_BOOKING_CALENDAR=1. The data source is chosen by availabilitySource(): the platform (default) or FastAPI
 * (FASTAPI_FEATURES=calendar). If the source cannot answer the visitor gets an error, never an invented "free".
 */
export async function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_BOOKING_CALENDAR !== "1") return json({ ok: false, error: "disabled" }, 404);
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const month = url.searchParams.get("month");
  const query = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : month && /^\d{4}-\d{2}$/.test(month) ? { month } : null;
  if (!query) return json({ ok: false, error: "bad_request" }, 400);

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const key = `availability:${ip}`;
  const check = rateLimitCheck(key, 120);
  if (!check.ok) return json({ ok: false, error: "rate_limited" }, 429);
  rateLimitRecord(key);

  const source = availabilitySource(process.env);
  if (source.kind === "unavailable") {
    console.error(JSON.stringify({ event: "availability.unavailable", reason: source.reason }));
    return json({ ok: false, error: "unavailable" }, 503);
  }

  try {
    if (source.kind === "fastapi") {
      const client = fastapiClient();
      const branch = { branchId: source.branchId };
      const data = query.date ? await getAvailabilityDay(client, query.date, branch) : await getAvailabilityMonth(client, query.month ?? "", branch);
      return json({ ...data, ok: true });
    }
    const data = await fetchAvailability(query);
    return json({ ...data, ok: true });
  } catch (error) {
    const kind = error instanceof PlatformError ? error.kind : error instanceof Error ? error.name : "unknown";
    console.warn(`[availability] source unavailable (${source.kind}, ${kind})`);
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
