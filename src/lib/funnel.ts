"use client";

import { ROOM_IDS } from "@/data/birthdayRooms";
import { PACKAGE_OPTIONS } from "@/lib/lead";
import { gaSend } from "@/lib/analytics";
import {
  createDeduper,
  sanitizeBirthdayParams,
  type BirthdayEvent,
  type BirthdayParams,
} from "@/lib/funnel-core";

export { errorTypeFromStatus } from "@/lib/funnel-core";
export type { BirthdayEvent, BirthdayParams };

const allowed = { packages: PACKAGE_OPTIONS.map((o) => o.value), rooms: ROOM_IDS } as const;
const once = createDeduper(800);

/**
 * Send one birthday-funnel event to GA4 (only). Params are whitelisted and normalised; PII cannot pass.
 * No-op when GA4 is not configured. Not sent to Meta Pixel (no ad pixel decision yet).
 */
export function trackBirthday(event: BirthdayEvent, raw: BirthdayParams = {}): void {
  if (typeof window === "undefined") return;
  const params = sanitizeBirthdayParams({ ...raw, page_path: raw.page_path ?? window.location.pathname }, allowed);
  if (!once(`${event}|${params.package_id}|${params.room_id}|${params.cta_source}|${params.error_type}|${params.page_path}`)) return;
  gaSend(event, params);
}
