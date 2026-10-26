import "server-only";
import { cookies } from "next/headers";
import { fastapiClient } from "../fastapi";
import { getChildren, getProfile, getRequests, logoutTokens, refreshTokens, type MobileAuthResponse } from "../fastapi/core.ts";
import {
  buildCabinet,
  callAsParent,
  ExpiringStore,
  parentLoginState,
  randomToken,
  type ParentCabinet,
  type ParentCallDeps,
  type ParentLoginState,
  type ParentSession,
  type PendingLogin,
} from "./core.ts";

/**
 * Server side of the parent account: cookies, the process-wide stores and the cabinet loader.
 * The browser holds only two opaque, HttpOnly ids. FastAPI tokens and the phone number never leave the server.
 *
 * Production note: the stores below are in process memory. That is correct for development and for one
 * server process, but NOT for several instances. parentLoginState() keeps production closed until a shared
 * store exists (see core.ts).
 */

export const PARENT_SESSION_COOKIE = "bb_parent_session";
export const PARENT_PENDING_COOKIE = "bb_parent_pending";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * One pair of stores per Node process. Next compiles each route handler into its own bundle, and each bundle would
 * otherwise get its own module-level Map: a login started in one route could not be finished in another.
 */
type ParentStores = { sessions: ExpiringStore<ParentSession>; pendings: ExpiringStore<PendingLogin> };
const globalForParent = globalThis as typeof globalThis & { __bbParentStores?: ParentStores };
const stores: ParentStores = (globalForParent.__bbParentStores ??= {
  sessions: new ExpiringStore<ParentSession>({ ttlMs: SESSION_TTL_MS, maxEntries: 5000 }),
  pendings: new ExpiringStore<PendingLogin>({ ttlMs: PENDING_TTL_MS, maxEntries: 5000 }),
});
const sessions = stores.sessions;
const pendings = stores.pendings;

export function parentState(): ParentLoginState {
  return parentLoginState(process.env);
}

function cookieBase(path: string, sameSite: "lax" | "strict") {
  return { httpOnly: true, secure: true, sameSite, path } as const;
}

/** Reads the session for this request, or null. Does not check the feature flag: callers do. */
export async function currentSession(): Promise<{ sid: string; session: ParentSession } | null> {
  const sid = (await cookies()).get(PARENT_SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = sessions.get(sid);
  return session ? { sid, session } : null;
}

/** Route handlers only: stores the pending OTP (phone + verification id) server-side and sets a pointer cookie. */
export async function startPendingLogin(login: PendingLogin): Promise<void> {
  const pid = randomToken();
  pendings.set(pid, login, PENDING_TTL_MS);
  (await cookies()).set(PARENT_PENDING_COOKIE, pid, { ...cookieBase("/api/parent", "strict"), maxAge: PENDING_TTL_MS / 1000 });
}

export async function currentPendingLogin(): Promise<{ pid: string; login: PendingLogin } | null> {
  const pid = (await cookies()).get(PARENT_PENDING_COOKIE)?.value;
  if (!pid) return null;
  const login = pendings.get(pid);
  return login ? { pid, login } : null;
}

export async function clearPendingLogin(pid?: string): Promise<void> {
  if (pid) pendings.delete(pid);
  (await cookies()).set(PARENT_PENDING_COOKIE, "", { ...cookieBase("/api/parent", "strict"), maxAge: 0 });
}

/** Route handlers only: after a verified OTP, keep the FastAPI tokens server-side and return the CSRF token. */
export async function establishSession(auth: MobileAuthResponse): Promise<{ csrfToken: string }> {
  const sid = randomToken();
  const csrfToken = randomToken();
  sessions.set(
    sid,
    {
      csrfToken,
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      accessExpiresAt: Date.now() + auth.expires_in_seconds * 1000 - 30_000,
      userId: auth.user.id,
    },
    SESSION_TTL_MS,
  );
  (await cookies()).set(PARENT_SESSION_COOKIE, sid, { ...cookieBase("/", "lax"), maxAge: SESSION_TTL_MS / 1000 });
  return { csrfToken };
}

/** Route handlers only: forget the session on this server and clear the cookie. */
export async function endSession(sid: string): Promise<void> {
  sessions.delete(sid);
  (await cookies()).set(PARENT_SESSION_COOKIE, "", { ...cookieBase("/", "lax"), maxAge: 0 });
}

function deps(): ParentCallDeps {
  return {
    client: fastapiClient(),
    sessions,
    refresh: (client, refreshToken) => refreshTokens(client, refreshToken),
  };
}

/** Logs out at FastAPI (best effort) and ends the session here. The local session always ends. */
export async function logoutEverywhere(sid: string): Promise<void> {
  const session = sessions.get(sid);
  if (session) {
    try {
      await logoutTokens(fastapiClient(), session.accessToken);
    } catch {
      /* FastAPI unavailable: the local session still ends; the access token expires on its own */
    }
  }
  await endSession(sid);
}

/** Loads the cabinet for a session through FastAPI. Throws ParentSessionEnded or FastapiError. */
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
