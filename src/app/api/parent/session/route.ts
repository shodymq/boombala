import { currentSession, parentState } from "@/lib/parent/server";
import { json, notFoundJson } from "@/lib/parent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the page whether a parent is signed in. Returns the CSRF token of that session, nothing else. */
export async function GET() {
  if (!parentState().enabled) return notFoundJson();
  const current = await currentSession();
  if (!current) return json({ ok: true, authenticated: false });
  return json({ ok: true, authenticated: true, csrfToken: current.session.csrfToken });
}
