"use client";

const KEY = "bb_attr";

export interface Attribution {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referrer: string;
}

/** Remember first-touch UTM + external referrer for the session (survives client navigation). */
export function captureAttribution(): void {
  try {
    if (sessionStorage.getItem(KEY)) return;
    const q = new URLSearchParams(window.location.search);
    const ref = document.referrer && !document.referrer.startsWith(window.location.origin) ? document.referrer : "";
    const attr: Attribution = {
      utm_source: q.get("utm_source") ?? "",
      utm_medium: q.get("utm_medium") ?? "",
      utm_campaign: q.get("utm_campaign") ?? "",
      referrer: ref,
    };
    sessionStorage.setItem(KEY, JSON.stringify(attr));
  } catch {
    /* storage unavailable: attribution is optional */
  }
}

export function getAttribution(): Attribution {
  const empty: Attribution = { utm_source: "", utm_medium: "", utm_campaign: "", referrer: "" };
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}
