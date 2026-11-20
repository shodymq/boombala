import type { Metadata, Viewport } from "next";
import "../globals.css";
import { SiteShell } from "@/components/layout/SiteShell";
import { nunito, onest } from "../fonts";
import { Analytics } from "@/components/analytics/Analytics";
import { getSiteUrl } from "@/lib/site-url";

/** The Kazakh root: its own document language (lang="kk") and the same frame. Page metadata is set by each Kazakh page. */
export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "Boom Bala — балаларға арналған ойын-сауық орталығы, Алматы",
    template: "%s — Boom Bala",
  },
  openGraph: { siteName: "Boom Bala", locale: "kk_KZ", type: "website" },
};

export const viewport: Viewport = {
  themeColor: "#4d1ba3",
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function KkLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="kk" className={`${nunito.variable} ${onest.variable}`}>
      <body className="min-h-dvh antialiased">
        <SiteShell locale="kk">{children}</SiteShell>
        <Analytics />
      </body>
    </html>
  );
}
