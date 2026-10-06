/**
 * Single place for site-level configuration.
 * Fill `opening.time` / `contacts.whatsapp` when they are confirmed — the UI
 * switches on automatically (countdown, WhatsApp CTA).
 */
export const siteConfig = {
  name: "Boom Bala",
  city: "Алматы",
  opening: {
    /** Local date in Asia/Almaty, YYYY-MM-DD. */
    date: "2026-10-07",
    /** Local time "HH:mm". `null` until the exact time is announced. */
    time: null as string | null,
    timeZone: "Asia/Almaty",
    /** Fixed UTC offset of the opening time zone (Kazakhstan is UTC+5 year-round). */
    utcOffset: "+05:00",
  },
  contacts: {
    instagram: "https://www.instagram.com/boombala.almaty",
    instagramHandle: "@boombala.almaty",
    /** Digits only with country code, e.g. "77001234567". `null` until confirmed. */
    whatsapp: null as string | null,
  },
  /** Base URL of the shared REST backend. `null` = use local data. */
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? null,
} as const;

export type SiteConfig = typeof siteConfig;

export interface ContactChannel {
  kind: "whatsapp" | "instagram";
  href: string;
  label: string;
}

export async function getSiteConfig(): Promise<SiteConfig> {
  return siteConfig;
}

/** Primary contact CTA: WhatsApp when configured, Instagram otherwise. */
export function getPrimaryContact(): ContactChannel {
  const { whatsapp, instagram } = siteConfig.contacts;
  if (whatsapp) {
    return { kind: "whatsapp", href: `https://wa.me/${whatsapp}`, label: "WhatsApp" };
  }
  return { kind: "instagram", href: instagram, label: "Instagram" };
}
