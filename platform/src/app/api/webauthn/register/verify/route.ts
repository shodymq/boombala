import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { finishRegistration } from "../../../../../core/passkeys.ts";
import { json } from "../../../../../server/api.ts";
import { getSession } from "../../../../../server/dal.ts";
import { getPool } from "../../../../../server/db.ts";
import { passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  const { response, label } = checked.body;
  if (!response || typeof response !== "object" || typeof label !== "string") return json({ ok: false, error: "bad_request" }, 400);
  try {
    const passkey = await finishRegistration(getPool(), passkeys, session.user, response as RegistrationResponseJSON, label, { ...(await requestMeta()), sessionId: session.sessionId });
    return json({ ok: true, passkey });
  } catch (error) {
    return passkeyError(error);
  }
}
