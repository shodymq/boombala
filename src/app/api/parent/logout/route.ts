import { guardPost, SessionStoreUnavailable } from "@/lib/parent/core";
import { guardResponse, hostOf, json, notFoundJson } from "@/lib/parent/http";
import { currentSession, logoutEverywhere, parentState } from "@/lib/parent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the parent's session here and at FastAPI. Requires the session CSRF token. */
export async function POST(request: Request) {
  if (!parentState().enabled) return notFoundJson();

  let current: Awaited<ReturnType<typeof currentSession>>;
  try {
    current = await currentSession();
  } catch (error) {
    if (error instanceof SessionStoreUnavailable) return json({ ok: false, error: "unavailable" }, 503);
    throw error;
  }
  if (!current) return json({ ok: false, error: "no_session" }, 401);

  const guard = guardPost({
    origin: request.headers.get("origin"),
    host: hostOf(request.headers),
    contentType: request.headers.get("content-type"),
    csrfHeader: request.headers.get("x-csrf-token"),
    expectedCsrf: current.session.csrf,
  });
  if (guard) return guardResponse(guard);

  try {
    await logoutEverywhere(current.sid);
  } catch (error) {
    if (error instanceof SessionStoreUnavailable) return json({ ok: false, error: "unavailable" }, 503);
    throw error;
  }
  return json({ ok: true });
}
