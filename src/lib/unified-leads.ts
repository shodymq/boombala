import "server-only";

import {
  buildWebsiteBirthdayLead,
  FastapiError,
  fastapiClient,
  parseWebsiteLeadConfig,
  postBirthdayLead,
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
  return postBirthdayLead(client, buildWebsiteBirthdayLead(input, config), requestId);
}
