import "server-only";
import { NextResponse } from "next/server";
import { createPool, type Pool } from "../core/db.ts";
import {
  createParentSession,
  lookupParentSession,
  ParentSessionInputError,
  revokeParentSession,
  rotateParentTokens,
  sealerFromEnv,
  type SessionSealer,
} from "../core/parent-sessions.ts";
import { bearerOk, json, readJson } from "./api.ts";

/**
 * Internal API behind the public site's parent login. Served ONLY by the `api` role process, ONLY when
 * PARENT_SESSIONS_ENABLED=1, ONLY with the service bearer token. It connects with its OWN database role
 * (PARENT_SESSION_DATABASE_URL, role bb_session), which can touch bb.parent_sessions and nothing else.
 * Everything else answers 404, so the endpoint does not reveal itself.
 */

const g = globalThis as unknown as { __bbParentSessionPool?: Pool; __bbParentSealer?: SessionSealer };

export function parentSessionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PARENT_SESSIONS_ENABLED === "1" && env.PLATFORM_ROLE === "api";
}

function sessionDb(): Pool {
  const url = process.env.PARENT_SESSION_DATABASE_URL;
  if (!url) throw new Error("PARENT_SESSION_DATABASE_URL is not set");
  g.__bbParentSessionPool ??= createPool(url, { max: 3 });
  return g.__bbParentSessionPool;
}

function sealer(): SessionSealer {
  g.__bbParentSealer ??= sealerFromEnv(process.env);
  return g.__bbParentSealer;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const ms = (v: unknown): Date | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v) : null);

export type SessionAction = "create" | "lookup" | "rotate" | "revoke";

/** Shared handler of the four routes: gate, bearer, parse, act. Errors carry codes, never values. */
export async function handleParentSessionAction(request: Request, action: SessionAction): Promise<NextResponse> {
  if (!parentSessionsEnabled()) return json({ ok: false, error: "not_found" }, 404);
  if (!bearerOk(request, process.env.PARENT_SESSION_SERVICE_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = (await readJson(request, 8_000)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);

  try {
    const db = sessionDb();
    const sid = str(body.sid, 200);
    if (!sid) return json({ ok: false, error: "validation" }, 422);

    if (action === "create") {
      const userId = str(body.userId, 64);
      const csrf = str(body.csrf, 200);
      const access = str(body.access, 2000);
      const refresh = str(body.refresh, 2000);
      const accessExpiresAt = ms(body.accessExpiresAt);
      const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : NaN;
      if (!userId || !csrf || !access || !refresh || !accessExpiresAt) return json({ ok: false, error: "validation" }, 422);
      await createParentSession(db, sealer(), { sid, userId, csrf, access, refresh, accessExpiresAt, ttlSeconds });
      return json({ ok: true }, 201);
    }

    if (action === "lookup") {
      const session = await lookupParentSession(db, sealer(), sid);
      if (!session) return json({ ok: false, error: "not_found" }, 404);
      return json({
        ok: true,
        session: { userId: session.userId, csrf: session.csrf, access: session.access, refresh: session.refresh, accessExpiresAt: session.accessExpiresAt.getTime() },
      });
    }

    if (action === "rotate") {
      const access = str(body.access, 2000);
      const refresh = str(body.refresh, 2000);
      const accessExpiresAt = ms(body.accessExpiresAt);
      if (!access || !refresh || !accessExpiresAt) return json({ ok: false, error: "validation" }, 422);
      const done = await rotateParentTokens(db, sealer(), sid, { access, refresh, accessExpiresAt });
      return done ? json({ ok: true }) : json({ ok: false, error: "not_found" }, 404);
    }

    await revokeParentSession(db, sid);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof ParentSessionInputError) return json({ ok: false, error: "validation" }, 422);
    // Unknown failure (database down, key mismatch, malformed row): nothing is returned, the caller fails closed.
    console.error(JSON.stringify({ event: "parent_session.error", action, name: error instanceof Error ? error.name : "unknown" }));
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
