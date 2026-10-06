import { attractions } from "@/data/attractions";
import type { Attraction } from "@/types";
import { resolve } from "./http";

/** GET /attractions */
export function getAttractions(): Promise<Attraction[]> {
  return resolve("/attractions", () => attractions);
}
