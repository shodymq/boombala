import "server-only";
import { createHmac } from "node:crypto";
import type { Role } from "../core/rbac.ts";
import { FastApiCrmConfigurationError, FastApiCrmError, type FastApiCrmActor } from "./fastapi-crm.ts";

const API_ROLE_BY_PLATFORM_ROLE: Record<Role, string | null> = {
  owner: "super_admin",
  manager: "sales_manager",
  editor: null,
};

/**
 * Server-to-server staff bridge. The Platform has already authenticated the staff member through its own database
 * session; this asks FastAPI for a short-lived access token for the linked admin with the same email.
 *
 * - The email comes only from the verified session passed in by the caller, never from a form or query string.
 * - The shared secret is read from the server environment and never leaves the server.
 * - The token is returned to server code only. It must not be placed in a cookie, a page prop, or a client bundle.
 * - Every failure is fail-closed: the caller gets an error and performs no FastAPI write.
 */
export async function fastApiActorForStaff(
  staff: { id: string; email: string; role: Role },
  options: { requestId: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<FastApiCrmActor> {
  const expectedApiRole = API_ROLE_BY_PLATFORM_ROLE[staff.role];
  if (!expectedApiRole) throw new FastApiCrmError(403, "staff_role_mismatch", options.requestId);
  const serviceToken = (process.env.CRM_SERVICE_TOKEN ?? "").trim();
  const assertionSecret = (process.env.CRM_STAFF_ASSERTION_SECRET ?? "").trim();
  if (serviceToken.length < 32 || assertionSecret.length < 32) throw new FastApiCrmConfigurationError("crm_actor_missing");
  const base = fastApiBase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const email = staff.email.trim().toLowerCase();
  const issuedAt = Math.floor(Date.now() / 1000);
  const encodedAssertion = Buffer.from(JSON.stringify({
    staffId: staff.id,
    email,
    requestId: options.requestId,
    issuedAt,
    expiresAt: issuedAt + 60,
  })).toString("base64url");
  const signature = createHmac("sha256", assertionSecret).update(encodedAssertion, "ascii").digest("hex");
  const response = await fetchImpl(`${base}/api/v1/admin/auth/service/staff-access-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CRM-Service-Token": serviceToken,
      "X-CRM-Staff-Assertion": `v1.${encodedAssertion}.${signature}`,
      "X-Request-ID": options.requestId,
    },
    body: JSON.stringify({ email, requestId: options.requestId }),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(Math.max(options.timeoutMs ?? 5000, 1000), 10000)),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw new FastApiCrmError(response.status, errorCode(body), options.requestId);
  const tokenResponse = body as {
    access_token?: unknown;
    user?: { email?: unknown; role?: unknown } | null;
  } | null;
  const accessToken = tokenResponse?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new FastApiCrmError(502, "staff_token_missing", options.requestId);
  if (
    typeof tokenResponse?.user?.email !== "string" ||
    tokenResponse.user.email.trim().toLowerCase() !== email ||
    tokenResponse.user.role !== expectedApiRole
  ) {
    throw new FastApiCrmError(403, "staff_role_mismatch", options.requestId);
  }
  return { accessToken, requestId: options.requestId };
}

function fastApiBase(): string {
  const raw = (process.env.FASTAPI_ADMIN_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new FastApiCrmConfigurationError("crm_base_url_missing");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FastApiCrmConfigurationError("crm_base_url_invalid");
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new FastApiCrmConfigurationError("crm_base_url_invalid");
  return parsed.toString().replace(/\/+$/, "");
}

function errorCode(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
      return (error as { code: string }).code;
    }
  }
  return "fastapi_error";
}
