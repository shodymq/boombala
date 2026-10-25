import { beginLogin } from "../../../../../core/passkeys.ts";
import { json } from "../../../../../server/api.ts";
import { getPendingSession } from "../../../../../server/dal.ts";
import { getPool } from "../../../../../server/db.ts";
import { passkeys } from "../../../../../server/env.ts";
import { passkeyError, passkeyRequest } from "../../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../../server/request.ts";

/** Options to sign in with a passkey. Public (nobody is signed in yet); with a pending password session only that person's keys are offered. */
export async function POST(request: Request) {
  const checked = await passkeyRequest(request);
  if ("status" in checked) return checked;
  try {
    const pending = await getPendingSession();
    const options = await beginLogin(getPool(), passkeys, { pendingUserId: pending?.user.id ?? null }, await requestMeta());
    return json({ ok: true, options });
  } catch (error) {
    return passkeyError(error);
  }
}
