import { revokePasskey } from "../../../../core/passkeys.ts";
import { json } from "../../../../server/api.ts";
import { getSession } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";
import { passkeys } from "../../../../server/env.ts";
import { jsonPost, passkeyError } from "../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../server/request.ts";

/** Revokes ONE key (the person's own; the Owner may revoke anyone's). Consumes a fresh step-up grant. */
export async function POST(request: Request) {
  if (!passkeys.enabled) return json({ ok: false, error: "disabled" }, 404);
  const checked = await jsonPost(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  const { id } = checked.body;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: "bad_request" }, 400);
  try {
    await revokePasskey(getPool(), { id: session.user.id, role: session.user.role }, id, { ...(await requestMeta()), sessionId: session.sessionId });
    return json({ ok: true });
  } catch (error) {
    return passkeyError(error);
  }
}
