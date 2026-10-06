import { pricingTable } from "@/data/pricing";
import type { PricingTable } from "@/types";
import { resolve } from "./http";

/** GET /prices */
export function getPricing(): Promise<PricingTable> {
  return resolve("/prices", () => pricingTable);
}
