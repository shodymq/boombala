import { issueEnrollmentCode } from "../../../../core/enrollment.ts";
import { consumeStepUp } from "../../../../core/stepup.ts";
import { assertCan } from "../../../../core/rbac.ts";
import { json } from "../../../../server/api.ts";
import { getSession } from "../../../../server/dal.ts";
import { getPool } from "../../../../server/db.ts";
import { jsonPost, passkeyError } from "../../../../server/passkeys-http.ts";
import { requestMeta } from "../../../../server/request.ts";

/**
 * The Owner issues a ONE-TIME enrolment code for a person who has no second factor yet (a new employee, or after a reset). The code is returned
 * once and never stored in clear. Needs the Owner's fresh step-up.
 */
export async function POST(request: Request) {
  const checked = await jsonPost(request);
  if ("status" in checked) return checked;
  const session = await getSession();
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  const { userId } = checked.body;
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) return json({ ok: false, error: "bad_request" }, 400);
  try {
    const actor = { id: session.user.id, role: session.user.role };
    assertCan(actor, "users.manage");
    await consumeStepUp(getPool(), actor.id, session.sessionId, "enrollment_code");
    const r = await issueEnrollmentCode(getPool(), actor, userId, await requestMeta());
    return json({ ok: true, code: r.code, expiresAt: r.expiresAt });
  } catch (error) {
    return passkeyError(error);
  }
}
