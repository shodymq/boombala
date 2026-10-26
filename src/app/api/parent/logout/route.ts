import { guardPost } from "@/lib/parent/core";
import { guardResponse, hostOf, json, notFoundJson } from "@/lib/parent/http";
import { currentSession, logoutEverywhere, parentState } from "@/lib/parent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the parent's session here and at FastAPI. Requires the session CSRF token. */
export async function POST(request: Request) {
  if (!parentState().enabled) return notFoundJson();

  const current = await currentSession();
  if (!current) return json({ ok: false, error: "no_session" }, 401);

  const guard = guardPost({
    origin: request.headers.get("origin"),
    host: hostOf(request.headers),
    contentType: request.headers.get("content-type"),
    csrfHeader: request.headers.get("x-csrf-token"),
    expectedCsrf: current.session.csrfToken,
  });
  if (guard) return guardResponse(guard);

  await logoutEverywhere(current.sid);
  return json({ ok: true });
}
