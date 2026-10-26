/**
 * Which backend answers the public calendar. Pure function of the environment, so it can be tested.
 *
 *  - "platform"    today's behaviour: the Next.js platform API. Used whenever the FastAPI `calendar` feature is off.
 *  - "fastapi"     FastAPI availability, only when the feature is on AND the FastAPI base URL and the catalog map are valid.
 *  - "unavailable" the feature is on but misconfigured. We do NOT fall back to another source silently: the visitor gets
 *                  an error, never a guess.
 */
import { enabledFeatures, parseFastapiConfig } from "../fastapi/core.ts";
import { parseCatalogMap, AvailabilityAdapterError, type CatalogMap, type SiteVocabulary } from "./adapter.ts";

export type AvailabilitySource =
  | { kind: "platform" }
  | { kind: "fastapi"; map: CatalogMap }
  | { kind: "unavailable"; reason: "fastapi_misconfigured" };

export function availabilitySource(env: Record<string, string | undefined>, vocab: SiteVocabulary): AvailabilitySource {
  if (!enabledFeatures(env.FASTAPI_FEATURES).has("calendar")) return { kind: "platform" };
  try {
    parseFastapiConfig(env);
    return { kind: "fastapi", map: parseCatalogMap(env.FASTAPI_CATALOG_MAP, vocab) };
  } catch (error) {
    if (error instanceof AvailabilityAdapterError || error instanceof Error) return { kind: "unavailable", reason: "fastapi_misconfigured" };
    throw error;
  }
}
