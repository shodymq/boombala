"use client";

export type TrackEvent =
  | "ViewPrices"
  | "ViewBirthdays"
  | "ViewMenu"
  | "ViewPackage"
  | "OpenLeadForm"
  | "SubmitLead"
  | "ClickRoute"
  | "ClickInstagram";

type Params = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    fbq?: (...args: unknown[]) => void;
  }
}

/** Fire an event to GA4 and Meta Pixel when they are loaded. Never throws. */
export function track(event: TrackEvent, params: Params = {}): void {
  try {
    if (typeof window === "undefined") return;
    window.gtag?.("event", event, params);
    if (window.fbq) {
      if (event === "SubmitLead") window.fbq("track", "Lead", params);
      window.fbq("trackCustom", event, params);
    }
  } catch {
    /* tracking must never break the site */
  }
}
