import { cookies } from "next/headers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { finishLogin } from "../../../../../core/passkeys.ts";
import { json } from "../../../../../server/api.ts";
import { getPendingSession } from "../../../../../server/dal.ts";
import { getPool } from "../../../../../server/db.ts";
import { SESSION_COOKIE, isHttps, passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest, sessionCookieValue } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

/** Checks the answer of the authenticator and, if it is valid, issues a complete session (a passkey with user verification counts as the second factor). */
export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  const { response } = checked.body;
  if (!response || typeof response !== "object") return json({ ok: false, error: "bad_request" }, 400);
  try {
    const meta = await requestMeta();
    const pending = await getPendingSession();
    const result = await finishLogin(getPool(), passkeys, {
      response: response as AuthenticationResponseJSON,
      pendingToken: pending ? await sessionCookieValue() : undefined,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (!result.ok) {
      if (result.reason === "locked") return json({ ok: false, error: "locked", retryAfterSeconds: result.retryAfterSeconds }, 429);
      return json({ ok: false, error: "invalid" }, 401);
    }
    (await cookies()).set(SESSION_COOKIE, result.token, { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", expires: result.expiresAt });
    return json({ ok: true });
  } catch (error) {
    return passkeyError(error);
  }
}
