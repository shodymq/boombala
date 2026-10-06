import type { EventItem, Promotion } from "@/types";
import { resolve } from "./http";

/** GET /promotions — nothing confirmed yet, so the local fallback is empty. */
export function getPromotions(): Promise<Promotion[]> {
  return resolve("/promotions", () => []);
}

/** GET /events — nothing confirmed yet, so the local fallback is empty. */
export function getEvents(): Promise<EventItem[]> {
  return resolve("/events", () => []);
}
