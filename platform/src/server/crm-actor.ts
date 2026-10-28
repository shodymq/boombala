import "server-only";
import type { FastApiCrmActor } from "./fastapi-crm.ts";
import { fastApiActorForStaff } from "./fastapi-staff.ts";

/**
 * FastAPI keeps one live bridge session per staff member: issuing a new token revokes the previous one. Without a cache,
 * a calendar load and an action in the same browser would revoke each other's token.
 *
 * The cache holds the token in server memory only, keyed by the Platform session id. It is never serialized into a page,
 * a cookie or a client bundle. Concurrent requests for the same session share one issuance.
 */
const REUSE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

type Entry = { accessToken: string; reuseUntil: number };

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<string>>();

export async function crmActorForSession(
  session: { sessionId: string; user: { email: string } },
  requestId: string,
): Promise<FastApiCrmActor> {
  const now = Date.now();
  const hit = cache.get(session.sessionId);
  if (hit && hit.reuseUntil > now) return { accessToken: hit.accessToken, requestId };

  let issuing = pending.get(session.sessionId);
  if (!issuing) {
    issuing = fastApiActorForStaff({ email: session.user.email }, { requestId })
      .then((actor) => {
        remember(session.sessionId, actor.accessToken);
        return actor.accessToken;
      })
      .finally(() => pending.delete(session.sessionId));
    pending.set(session.sessionId, issuing);
  }
  return { accessToken: await issuing, requestId };
}

/** Drops the cached token when the Platform session ends (logout or expiry). */
export function forgetCrmActor(sessionId: string): void {
  cache.delete(sessionId);
}

function remember(sessionId: string, accessToken: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.reuseUntil <= now) cache.delete(key);
    }
    // Still full: evict the oldest insertion. This only costs one re-issuance for that session.
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  cache.set(sessionId, { accessToken, reuseUntil: Date.now() + REUSE_MS });
}
