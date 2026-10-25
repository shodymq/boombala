import { revokeAllPasskeys } from "../../../../core/passkeys.ts";
import { json } from "../../../../server/api.ts";
import { getSession } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";
import { passkeys } from "../../../../server/env.ts";
import { jsonPost, passkeyError } from "../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../server/request.ts";

/** The Owner revokes every key of one person and ends their sessions. Owner only; consumes a fresh step-up grant. */
export async function POST(request: Request) {
  if (!passkeys.enabled) return json({ ok: false, error: "disabled" }, 404);
  const checked = await jsonPost(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  const { userId } = checked.body;
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) return json({ ok: false, error: "bad_request" }, 400);
  try {
    const revoked = await revokeAllPasskeys(getPool(), { id: session.user.id, role: session.user.role }, userId, { ...(await requestMeta()), sessionId: session.sessionId });
    return json({ ok: true, revoked });
  } catch (error) {
    return passkeyError(error);
  }
}
