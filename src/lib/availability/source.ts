/**
 * Which backend answers the public calendar. Pure function of the environment, so it can be tested.
 *
 *  - "platform"    today's behaviour: the Next.js platform API. Used whenever the FastAPI `calendar` feature is off.
 *  - "fastapi"     FastAPI availability, only when the feature is on AND the FastAPI base URL and branch are valid.
 *  - "unavailable" the feature is on but misconfigured. We do NOT fall back to another source silently: the visitor gets
 *                  an error, never a guess.
 */
import { enabledFeatures, isSafeBranchId, parseFastapiConfig } from "../fastapi/core.ts";

export type AvailabilitySource =
  | { kind: "platform" }
  | { kind: "fastapi"; branchId: string }
  | { kind: "unavailable"; reason: "fastapi_misconfigured" };

export function availabilitySource(env: Record<string, string | undefined>): AvailabilitySource {
  if (!enabledFeatures(env.FASTAPI_FEATURES).has("calendar")) return { kind: "platform" };
  const branchId = (env.FASTAPI_SITE_BRANCH_ID ?? "").trim();
  try {
    parseFastapiConfig(env);
  } catch {
    return { kind: "unavailable", reason: "fastapi_misconfigured" };
  }
  if (!isSafeBranchId(branchId)) return { kind: "unavailable", reason: "fastapi_misconfigured" };
  return { kind: "fastapi", branchId };
}
