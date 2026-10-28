import "server-only";
import { randomUUID } from "node:crypto";
import { FastApiCrmClient, FastApiCrmError, type FastApiCrmActor } from "./fastapi-crm.ts";
import { fastApiActorForStaff } from "./fastapi-staff.ts";
import { getPool } from "./db.ts";

/**
 * FastAPI keeps one live bridge session per staff member: issuing a new token revokes the previous one. Without a cache,
 * a calendar load and an action in the same browser would revoke each other's token.
 *
 * The cache holds a token in server memory only. Its key is the Platform session AND the FastAPI identity read from the
 * database on this call, so unlink or relink never reuses a token issued for the old identity. A 401 from FastAPI drops
 * the entry and issues once more. Tokens are never serialized into a page, a cookie or a client bundle.
 */
const REUSE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

type Entry = { accessToken: string; reuseUntil: number };

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<string>>();

type Staff = { id: string; email: string };

/**
 * Runs one FastAPI operation as the verified staff member. The FastAPI identity is read from the database on every call,
 * never from a cookie or the session object. When the account is not linked, nothing is sent.
 */
export async function withFastApiClient<T>(
  session: { sessionId: string; user: Staff },
  run: (client: FastApiCrmClient) => Promise<T>,
): Promise<T> {
  const identity = await fastApiLinkFor(session.user.id);
  if (!identity) throw new FastApiCrmError(403, "staff_not_linked", "link");
  const key = `${session.sessionId}|${identity}`;
  try {
    return await run(new FastApiCrmClient(await actorFor(key, identity, session.user.email, false)));
  } catch (error) {
    if (!(error instanceof FastApiCrmError) || error.status !== 401) throw error;
    // Expired or revoked token: nothing was processed, so one fresh token and one retry are safe.
    cache.delete(key);
    return run(new FastApiCrmClient(await actorFor(key, identity, session.user.email, true)));
  }
}

async function actorFor(key: string, identity: string, email: string, fresh: boolean): Promise<FastApiCrmActor> {
  const requestId = randomUUID();
  const now = Date.now();
  const hit = cache.get(key);
  if (!fresh && hit && hit.reuseUntil > now) return { accessToken: hit.accessToken, requestId };

  let issuing = pending.get(key);
  if (!issuing) {
    issuing = fastApiActorForStaff({ email, fastapiAdminUserId: identity }, { requestId })
      .then((actor) => {
        remember(key, actor.accessToken);
        return actor.accessToken;
      })
      .finally(() => pending.delete(key));
    pending.set(key, issuing);
  }
  return { accessToken: await issuing, requestId };
}

/**
 * The explicit link from this Platform staff account to its FastAPI AdminUser (migration 014). Null when not linked.
 */
async function fastApiLinkFor(userId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ fastapi_admin_user_id: string | null }>(
    "SELECT fastapi_admin_user_id FROM bb.users WHERE id = $1 AND is_active",
    [userId],
  );
  return rows[0]?.fastapi_admin_user_id ?? null;
}

/** Drops every cached token of a Platform session (logout or expiry). */
export function forgetCrmActor(sessionId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${sessionId}|`)) cache.delete(key);
  }
}

function remember(key: string, accessToken: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, entry] of cache) {
      if (entry.reuseUntil <= now) cache.delete(k);
    }
    // Still full: evict the oldest insertion. This only costs one re-issuance for that session.
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, { accessToken, reuseUntil: Date.now() + REUSE_MS });
}
