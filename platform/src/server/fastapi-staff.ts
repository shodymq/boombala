import "server-only";
import { FastApiCrmConfigurationError, FastApiCrmError, type FastApiCrmActor } from "./fastapi-crm.ts";

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
  staff: { email: string },
  options: { requestId: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<FastApiCrmActor> {
  const serviceToken = (process.env.CRM_SERVICE_TOKEN ?? "").trim();
  if (serviceToken.length < 32) throw new FastApiCrmConfigurationError("crm_actor_missing");
  const base = fastApiBase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${base}/api/v1/admin/auth/service/staff-access-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CRM-Service-Token": serviceToken,
      "X-Request-ID": options.requestId,
    },
    body: JSON.stringify({ email: staff.email, requestId: options.requestId }),
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
  const accessToken = (body as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new FastApiCrmError(502, "staff_token_missing", options.requestId);
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
