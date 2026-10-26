import "server-only";
import { cookies } from "next/headers";
import { fastapiClient } from "../fastapi";
import { getChildren, getProfile, getRequests, logoutTokens, refreshTokens, type MobileAuthResponse } from "../fastapi/core.ts";
import { buildCabinet, callAsParent, parentLoginState, randomToken, type ParentCabinet, type ParentCallDeps, type ParentLoginState, type SessionRecord, type SessionStore, type PendingLogin } from "./core.ts";
import { pendingSealerFromEnv, type PendingSealer } from "./pending.ts";
import { platformSessionStore } from "./session-store.ts";

/**
 * Server side of the parent account. The browser holds two opaque, HttpOnly cookies:
 *  - the session id (bb_parent_session) → the server looks it up in the SHARED store (the platform's database);
 *  - the sealed pending login (bb_parent_pending) → phone + verification id, encrypted, expires by itself.
 * FastAPI tokens and the phone never leave the server. Nothing here keeps state in process memory.
 */

export const PARENT_SESSION_COOKIE = "bb_parent_session";
export const PARENT_PENDING_COOKIE = "bb_parent_pending";

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PENDING_TTL_SECONDS = 10 * 60;

export function parentState(): ParentLoginState {
  return parentLoginState(process.env);
}

let cachedStore: SessionStore | undefined;
let cachedSealer: PendingSealer | undefined;

/** The shared store (platform internal API). Built once per process from its environment. */
export function sessionStore(): SessionStore {
  cachedStore ??= platformSessionStore({
    baseUrl: process.env.PLATFORM_URL ?? "",
    token: process.env.PARENT_SESSION_SERVICE_TOKEN ?? "",
  });
  return cachedStore;
}

function pendingSealer(): PendingSealer {
  cachedSealer ??= pendingSealerFromEnv(process.env);
  return cachedSealer;
}

function cookieBase(path: string, sameSite: "lax" | "strict") {
  return { httpOnly: true, secure: true, sameSite, path } as const;
}

/** Reads the session for this request, or null. Throws SessionStoreUnavailable when the store cannot answer. */
export async function currentSession(): Promise<{ sid: string; session: SessionRecord } | null> {
  const sid = (await cookies()).get(PARENT_SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = await sessionStore().lookup(sid);
  return session ? { sid, session } : null;
}

/** Route handlers: seals the pending phone login into a cookie (no server state). */
export async function startPendingLogin(login: PendingLogin): Promise<void> {
  const sealed = pendingSealer().seal({ phone: login.phone, verificationId: login.verificationId, expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000 });
  (await cookies()).set(PARENT_PENDING_COOKIE, sealed, { ...cookieBase("/api/parent", "strict"), maxAge: PENDING_TTL_SECONDS });
}

/** Route handlers: the pending login from the cookie, or null when missing, forged, or expired. */
export async function currentPendingLogin(): Promise<PendingLogin | null> {
  const value = (await cookies()).get(PARENT_PENDING_COOKIE)?.value;
  const p = pendingSealer().open(value);
  return p ? { phone: p.phone, verificationId: p.verificationId } : null;
}

export async function clearPendingLogin(): Promise<void> {
  (await cookies()).set(PARENT_PENDING_COOKIE, "", { ...cookieBase("/api/parent", "strict"), maxAge: 0 });
}

/**
 * Route handlers, after a verified OTP. A NEW opaque session id is always issued (no session fixation): if the browser
 * already held a session, that one is revoked first.
 */
export async function establishSession(auth: MobileAuthResponse): Promise<{ csrfToken: string }> {
  const store = sessionStore();
  const previous = (await cookies()).get(PARENT_SESSION_COOKIE)?.value;
  if (previous) await store.revoke(previous);

  const sid = randomToken();
  const csrfToken = randomToken();
  await store.create(
    sid,
    {
      userId: auth.user.id,
      csrf: csrfToken,
      access: auth.access_token,
      refresh: auth.refresh_token,
      accessExpiresAt: Date.now() + auth.expires_in_seconds * 1000 - 30_000,
    },
    SESSION_TTL_SECONDS,
  );
  (await cookies()).set(PARENT_SESSION_COOKIE, sid, { ...cookieBase("/", "lax"), maxAge: SESSION_TTL_SECONDS });
  return { csrfToken };
}

function deps(): ParentCallDeps {
  return {
    client: fastapiClient(),
    store: sessionStore(),
    refresh: (client, refreshToken) => refreshTokens(client, refreshToken),
  };
}

/** Logs out at FastAPI (best effort), revokes the session in the shared store, and clears the cookie. */
export async function logoutEverywhere(sid: string): Promise<void> {
  const store = sessionStore();
  const session = await store.lookup(sid);
  if (session) {
    try {
      await logoutTokens(fastapiClient(), session.access);
    } catch {
      /* FastAPI unavailable: the local session is still revoked; the access token expires on its own */
    }
  }
  await store.revoke(sid);
  (await cookies()).set(PARENT_SESSION_COOKIE, "", { ...cookieBase("/", "lax"), maxAge: 0 });
}

/** Loads the cabinet through FastAPI. Throws ParentSessionEnded, SessionStoreUnavailable or FastapiError. */
export async function loadCabinet(sid: string): Promise<ParentCabinet> {
  return callAsParent(deps(), sid, async (accessToken) => {
    const client = fastapiClient();
    const [profile, children, requests] = await Promise.all([
      getProfile(client, accessToken),
      getChildren(client, accessToken),
      getRequests(client, accessToken),
    ]);
    return buildCabinet(profile, children, requests);
  });
}
