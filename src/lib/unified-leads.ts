import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  buildWebsiteBirthdayLead,
  FastapiError,
  fastapiClient,
  parseWebsiteLeadConfig,
  postWebsiteBirthdayLead,
  type BirthdayLeadSubmittedResponse,
  type WebsiteLeadInput,
} from "@/lib/fastapi";

/** A separate explicit flag prevents the generic FastAPI client from changing website writes. */
export const unifiedWebsiteLeadsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.UNIFIED_FASTAPI_WEBSITE_LEADS === "1";

export async function sendWebsiteLeadToFastapi(input: WebsiteLeadInput, requestId?: string): Promise<BirthdayLeadSubmittedResponse> {
  const config = parseWebsiteLeadConfig(process.env);
  if (!config) throw new FastapiError("disabled", undefined, undefined, requestId);
  const client = fastapiClient();
  if (!client.enabled("leads")) throw new FastapiError("disabled", undefined, undefined, requestId);
  const serviceId = (process.env.UNIFIED_FASTAPI_WEBSITE_SERVICE_ID ?? "").trim();
  const serviceSecret = (process.env.UNIFIED_FASTAPI_WEBSITE_SERVICE_SECRET ?? "").trim();
  if (!serviceId || serviceSecret.length < 32) throw new FastapiError("not_configured", undefined, undefined, requestId);
  const body = JSON.stringify(buildWebsiteBirthdayLead(input, config));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const path = "/api/v1/public/leads/birthday";
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signatureInput = ["POST", path, timestamp, nonce, bodyHash].join("\n");
  const signature = createHmac("sha256", serviceSecret)
    .update(signatureInput)
    .digest("hex");
  return postWebsiteBirthdayLead(client, {
    rawBody: body,
    headers: {
      "X-Service-Id": serviceId,
      "X-Request-Timestamp": timestamp,
      "X-Request-Nonce": nonce,
      "X-Request-Signature": signature,
      "Idempotency-Key": input.idempotencyKey,
    },
  }, requestId);
}
