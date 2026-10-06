/**
 * Single place for site-level configuration.
 * Opening timeline (Asia/Almaty):
 *   opening      — 7 Oct 2026 12:00: the centre starts working and welcomes visitors.
 *   grandOpening — 24 Oct 2026 10:00: the big public opening event.
 * The UI switches phase automatically: before -> working -> open.
 * Fill `contacts.whatsapp` when it is confirmed — the WhatsApp CTA switches on.
 */
export const siteConfig = {
  name: "Boom Bala",
  city: "Алматы",
  opening: {
    /** Start of work, local date in Asia/Almaty, YYYY-MM-DD. */
    date: "2026-10-07",
    /** Local time "HH:mm". */
    time: "12:00",
    timeZone: "Asia/Almaty",
    /** Fixed UTC offset of the opening time zone (Kazakhstan is UTC+5 year-round). */
    utcOffset: "+05:00",
  },
  /** The big public opening. Same time zone as `opening`. */
  grandOpening: {
    date: "2026-10-24",
    time: "10:00",
  },
  /** Confirmed venue address. Working hours are NOT confirmed yet, so none are shown. */
  location: {
    city: "Алматы",
    street: "ул. Шолохова, 29",
    mall: "ТРК «Жібек жолы»",
    floor: "3 этаж",
    /** Route link (2GIS). NEXT_PUBLIC_MAP_URL overrides. `null` hides the route button. */
    mapUrl: (process.env.NEXT_PUBLIC_MAP_URL || "https://go.2gis.com/6zqEx") as string | null,
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
