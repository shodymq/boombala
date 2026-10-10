"use client";

export type TrackEvent =
  | "ViewPrices"
  | "ViewBirthdays"
  | "ViewMenu"
  | "ViewPackage"
  | "ClickRoute"
  | "ClickInstagram";

type Params = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    fbq?: (...args: unknown[]) => void;
  }
}

const GA_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_GA_ID);

/**
 * Analytics consent. The consent to process lead data (the form checkbox) is NOT consent to analytics,
 * so nothing is loaded or sent until a visitor explicitly agrees: call `grantAnalyticsConsent()` from a
 * future consent banner. There is no banner yet, so with GA configured nothing runs until one exists.
 */
export const CONSENT_KEY = "bb-analytics-consent";
export const CONSENT_EVENT = "bb:analytics-consent";

export function hasAnalyticsConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

/** Call once the visitor has agreed to analytics (consent banner). Starts GA4; no reload needed. */
export function grantAnalyticsConsent(): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, "granted");
  } catch {
    /* storage unavailable: consent then only lasts for this page view */
  }
  try {
    window.dispatchEvent(new Event(CONSENT_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * Send a GA4 event. Does nothing unless NEXT_PUBLIC_GA_ID is set AND the visitor consented, so nothing
 * leaves the browser otherwise. Before gtag.js has loaded the command is queued in dataLayer.
 */
export function gaSend(name: string, params: Record<string, string | number | boolean | undefined> = {}): void {
  try {
    if (typeof window === "undefined" || !GA_CONFIGURED || !hasAnalyticsConsent()) return;
    if (window.gtag) {
      window.gtag("event", name, params);
      return;
    }
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer || [];
    // gtag.js only understands `arguments` objects in the dataLayer.
    const queue = function () {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    } as (...args: unknown[]) => void;
    queue("event", name, params);
  } catch {
    /* tracking must never break the site */
  }
}

/** Fire a legacy (non-funnel) event to GA4 and Meta Pixel when they are loaded. Never throws. */
export function track(event: TrackEvent, params: Params = {}): void {
  try {
    if (typeof window === "undefined") return;
    gaSend(event, params);
    if (hasAnalyticsConsent()) window.fbq?.("trackCustom", event, params);
  } catch {
    /* tracking must never break the site */
  }
}
