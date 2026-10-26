import { BOOKING_SLOTS, PACKAGE_OPTIONS } from "@/lib/lead";
import { birthdayRooms } from "@/data/birthdayRooms";
import { fastapiClient } from "@/lib/fastapi";
import { getPublicAvailability, FastapiError } from "@/lib/fastapi/core.ts";
import { adaptDay, adaptMonth, AvailabilityAdapterError, type SiteVocabulary } from "@/lib/availability/adapter.ts";
import { availabilitySource } from "@/lib/availability/source.ts";
import { fetchAvailability, PlatformError } from "@/lib/platform";
import { rateLimitCheck, rateLimitRecord } from "@/lib/rate-limit";

export const runtime = "nodejs";

const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The ids the calendar renders. The packages list excludes the "undecided" option, which has no price. */
const VOCABULARY: SiteVocabulary = {
  roomIds: birthdayRooms.map((r) => r.id),
  slotIds: BOOKING_SLOTS.map((s) => s.id),
  packageValues: PACKAGE_OPTIONS.filter((o) => o.value !== "undecided").map((o) => o.value),
};

/**
 * Availability proxy for the public calendar (the platform token never reaches the browser). Off unless
 * NEXT_PUBLIC_BOOKING_CALENDAR=1. The source is chosen by availabilitySource(): the platform (default) or FastAPI
 * (FASTAPI_FEATURES=calendar + FASTAPI_CATALOG_MAP). If the source cannot answer, or its answer cannot be read
 * safely, the visitor gets an error, never an invented "free".
 */
export async function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_BOOKING_CALENDAR !== "1") return json({ ok: false, error: "disabled" }, 404);
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const month = url.searchParams.get("month");
  const query: { date: string } | { month: string } | null =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : month && /^\d{4}-\d{2}$/.test(month) ? { month } : null;
  if (!query) return json({ ok: false, error: "bad_request" }, 400);

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const key = `availability:${ip}`;
  const check = rateLimitCheck(key, 120);
  if (!check.ok) return json({ ok: false, error: "rate_limited" }, 429);
  rateLimitRecord(key);

  const source = availabilitySource(process.env, VOCABULARY);
  if (source.kind === "unavailable") {
    console.error(JSON.stringify({ event: "availability.unavailable", reason: source.reason }));
    return json({ ok: false, error: "unavailable" }, 503);
  }

  try {
    if (source.kind === "fastapi") {
      const client = fastapiClient();
      const branchId = source.map.branchId;
      if ("date" in query) {
        const raw = await getPublicAvailability(client, { branchId, date: query.date });
        return json({ ...adaptDay(raw, { branchId, date: query.date }, source.map, VOCABULARY), ok: true });
      }
      const raw = await getPublicAvailability(client, { branchId, month: query.month });
      return json({ ...adaptMonth(raw, { branchId, month: query.month }, source.map, VOCABULARY), ok: true });
    }
    const data = await fetchAvailability(query);
    return json({ ...data, ok: true });
  } catch (error) {
    const kind = error instanceof AvailabilityAdapterError ? error.kind : error instanceof FastapiError ? error.kind : error instanceof PlatformError ? error.kind : "unknown";
    console.warn(`[availability] unavailable (${source.kind}, ${kind})`);
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
