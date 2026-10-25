import { beginStepUp } from "../../../../../core/passkeys.ts";
import { json } from "../../../../../server/api.ts";
import { getSession } from "../../../../../server/dal.ts";
import { getPool } from "../../../../../server/db.ts";
import { passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

/** Options for the step-up with a passkey: only the signed-in person's own keys are offered. */
export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    return json({ ok: true, options: await beginStepUp(getPool(), passkeys, session.user, await requestMeta()) });
  } catch (error) {
    return passkeyError(error);
  }
}
