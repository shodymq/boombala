import type { Metadata, Viewport } from "next";
import "../globals.css";
import { SiteShell } from "@/components/layout/SiteShell";
import { nunito, onest } from "../fonts";
import { Analytics } from "@/components/analytics/Analytics";
import { getSiteUrl } from "@/lib/site-url";
import { siteConfig } from "@/services/config";

const siteUrl = getSiteUrl();

const localBusinessJsonLd = {
  "@context": "https://schema.org",
  "@type": "EntertainmentBusiness",
  "@id": `${siteUrl}/#business`,
  name: "Boom Bala",
  alternateName: "Бум Бала",
  url: siteUrl,
  telephone: siteConfig.contacts.phone.tel,
  address: {
    "@type": "PostalAddress",
    streetAddress: "ул. Шолохова, 29, ТРК «Жібек жолы», 3 этаж",
    addressLocality: "Алматы",
    addressCountry: "KZ",
  },
  sameAs: ["https://www.instagram.com/boombala.almaty"],
} as const;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  alternates: { canonical: "/" },
  title: {
    default: "Boom Bala — детский развлекательный центр в Алматы",
    template: "%s — Boom Bala",
  },
  description:
    "Бум Бала (Boom Bala) — детский игровой и развлекательный центр в Алматы. Цены, дни рождения и меню.",
  openGraph: {
    title: "Boom Bala — детский развлекательный центр в Алматы",
    description: "Бум Бала (Boom Bala) — детский игровой и развлекательный центр в Алматы. Цены, дни рождения и меню.",
    siteName: "Boom Bala",
    url: "/",
    locale: "ru_RU",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Boom Bala — детский развлекательный центр в Алматы",
    description: "Цены, развлечения, дни рождения и годовой абонемент в Boom Bala, Алматы.",
    images: ["/opengraph-image"],
  },
};

export const viewport: Viewport = {
  themeColor: "#4d1ba3",
  width: "device-width",
  initialScale: 1,
  // Android Chrome: resize the layout (not just the visual viewport) when the keyboard opens.
  interactiveWidget: "resizes-content",
};

export default function RuLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${nunito.variable} ${onest.variable}`}>
      <body className="min-h-dvh antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd).replace(/</g, "\\u003c") }}
        />
        <SiteShell locale="ru">{children}</SiteShell>
        <Analytics />
      </body>
    </html>
  );
}
