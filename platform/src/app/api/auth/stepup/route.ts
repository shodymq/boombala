import { stepUpWithCode, isStepUpPurpose } from "../../../../core/stepup.ts";
import { json } from "../../../../server/api.ts";
import { getPool } from "../../../../server/db.ts";
import { mfaKey, mfaRequired } from "../../../../server/env.ts";
import { jsonPost, passkeyError, sessionCookieValue } from "../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../server/request.ts";

/** Step-up with a code from the authenticator app (or a recovery code): a fresh proof before a sensitive action. Needs a signed-in session. */
export async function POST(request: Request) {
  const checked = await jsonPost(request);
  if ("status" in checked) return checked;
  const { purpose, code } = checked.body;
  if (!isStepUpPurpose(purpose) || typeof code !== "string") return json({ ok: false, error: "bad_request" }, 400);
  try {
    const meta = await requestMeta();
    const r = await stepUpWithCode(getPool(), { sessionToken: await sessionCookieValue(), purpose, code, mfaKey, requireMfa: mfaRequired, ip: meta.ip, userAgent: meta.userAgent });
    if (r.ok) return json({ ok: true });
    if (r.reason === "locked") return json({ ok: false, error: "locked", retryAfterSeconds: r.retryAfterSeconds }, 429);
    return json({ ok: false, error: r.reason === "expired" ? "unauthorized" : "invalid" }, r.reason === "expired" ? 401 : 403);
  } catch (error) {
    return passkeyError(error);
  }
}
