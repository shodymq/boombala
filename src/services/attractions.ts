import { attractions } from "@/data/attractions";
import type { Attraction } from "@/types";
import { resolve } from "./http";

/** GET /attractions — every attraction (published or not). */
export function getAllAttractions(): Promise<Attraction[]> {
  return resolve("/attractions", () => attractions);
}

/** What the public site shows. */
export async function getAttractions(): Promise<Attraction[]> {
  return (await getAllAttractions()).filter((a) => a.published);
}
