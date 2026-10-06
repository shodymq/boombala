import type { Metadata, Viewport } from "next";
import { Nunito, Onest } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { HashScroll } from "@/components/layout/HashScroll";
import { LeadFormProvider } from "@/components/lead/LeadFormProvider";
import { StickyBookingCta } from "@/components/lead/StickyBookingCta";
import { SelectedPackageProvider } from "@/components/lead/SelectedPackage";
import { Analytics } from "@/components/analytics/Analytics";
import { getSiteUrl } from "@/lib/site-url";

const nunito = Nunito({
  subsets: ["latin", "cyrillic"],
  weight: ["700", "800", "900"],
  variable: "--font-nunito",
  display: "swap",
});

const onest = Onest({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-onest",
  display: "swap",
});

const siteUrl = getSiteUrl();

const localBusinessJsonLd = {
  "@context": "https://schema.org",
  "@type": "EntertainmentBusiness",
  "@id": `${siteUrl}/#business`,
  name: "Boom Bala",
  url: siteUrl,
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
    "Boom Bala — детский развлекательный центр в Алматы. Цены, дни рождения и годовой абонемент.",
  openGraph: {
    title: "Boom Bala — детский развлекательный центр в Алматы",
    description: "Цены, развлечения, дни рождения и годовой абонемент в Boom Bala, Алматы.",
    siteName: "Boom Bala",
    url: "/",
    locale: "ru_RU",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Boom Bala — детский развлекательный центр в Алматы",
    description: "Цены, развлечения, дни рождения и годовой абонемент в Boom Bala, Алматы.",
    images: ["/opengraph-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#4d1ba3",
  width: "device-width",
  initialScale: 1,
  // Android Chrome: resize the layout (not just the visual viewport) when the keyboard opens.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${nunito.variable} ${onest.variable}`}>
      <body className="min-h-dvh antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd).replace(/</g, "\\u003c") }}
        />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-grape-700 focus:px-5 focus:py-3 focus:text-white"
        >
          К содержимому
        </a>
        <SelectedPackageProvider>
        <LeadFormProvider>
          <HashScroll />
          <Header />
          <main id="main">{children}</main>
          <Footer />
          <StickyBookingCta />
        </LeadFormProvider>
        </SelectedPackageProvider>
        <Analytics />
      </body>
    </html>
  );
}
