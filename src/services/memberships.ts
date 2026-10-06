import { membership } from "@/data/membership";
import type { Membership } from "@/types";
import { resolve } from "./http";

/** GET /membership */
export function getMembership(): Promise<Membership> {
  return resolve("/membership", () => membership);
}
