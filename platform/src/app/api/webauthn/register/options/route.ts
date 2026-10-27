import { beginRegistration } from "../../../../../core/passkeys.ts";
import { json } from "../../../../../server/api.ts";
import { getSession } from "../../../../../server/dal.ts";
import { getPool } from "../../../../../server/db.ts";
import { passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

/** A signed-in person asks for the options to add a device (Face ID / Touch ID). */
export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    const options = await beginRegistration(getPool(), passkeys, session.user, { ...(await requestMeta()), sessionId: session.sessionId });
    return json({ ok: true, options });
  } catch (error) {
    return passkeyError(error);
  }
}
