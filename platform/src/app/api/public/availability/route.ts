import { dayAvailability, monthAvailability } from "../../../../core/bookings.ts";
import { ValidationError } from "../../../../core/errors.ts";
import { bearerOk, json } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public availability for the site's calendar (server-to-server). Free/busy only: no names, no phones, no reasons.
 * `?month=YYYY-MM` -> free rooms per slot for the days that have reservations (other days are fully free);
 * `?date=YYYY-MM-DD` -> slots with free room ids and the price of every package on that date.
 * If the database cannot answer, the answer is an error, never an invented "free".
 */
export async function GET(request: Request) {
  if (!bearerOk(request, process.env.PLATFORM_INTAKE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  const url = new URL(request.url);
  try {
    const date = url.searchParams.get("date");
    const month = url.searchParams.get("month");
    if (date) return json({ ok: true, ...(await dayAvailability(getPool(), date)) });
    if (month) return json({ ok: true, ...(await monthAvailability(getPool(), month)) });
    return json({ ok: false, error: "bad_request" }, 400);
  } catch (error) {
    if (error instanceof ValidationError) return json({ ok: false, error: "validation" }, 422);
    console.error(JSON.stringify({ event: "availability.error", name: error instanceof Error ? error.name : "unknown" }));
    return json({ ok: false, error: "server" }, 500);
  }
}
