import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { finishStepUp } from "../../../../../core/passkeys.ts";
import { isStepUpPurpose } from "../../../../../core/stepup.ts";
import { json } from "../../../../../server/api.ts";
import { getPool } from "../../../../../server/db.ts";
import { mfaRequired, passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest, sessionCookieValue } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  const { response, purpose } = checked.body;
  if (!response || typeof response !== "object" || !isStepUpPurpose(purpose)) return json({ ok: false, error: "bad_request" }, 400);
  try {
    const meta = await requestMeta();
    const r = await finishStepUp(getPool(), passkeys, { response: response as AuthenticationResponseJSON, sessionToken: await sessionCookieValue(), purpose, requireMfa: mfaRequired, ip: meta.ip, userAgent: meta.userAgent });
    if (r.ok) return json({ ok: true });
    if (r.reason === "locked") return json({ ok: false, error: "locked", retryAfterSeconds: r.retryAfterSeconds }, 429);
    return json({ ok: false, error: r.reason === "expired" ? "unauthorized" : "invalid" }, r.reason === "expired" ? 401 : 403);
  } catch (error) {
    return passkeyError(error);
  }
}
