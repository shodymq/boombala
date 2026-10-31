import type { Metadata, Viewport } from "next";
import { DM_Sans, Manrope } from "next/font/google";
import "./globals.css";
import "./snow-shell.css";
import "./snow-overview.css";
import "./(admin)/requests/snow-requests.css";
import "./snow-pages.css";

const bodyFont = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-body" });
const headingFont = Manrope({ subsets: ["latin", "cyrillic"], variable: "--font-heading" });

export const metadata: Metadata = {
  title: { default: "Boom Bala — управление", template: "%s — Boom Bala" },
  // The admin panel must never be indexed.
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#3b1485" };

// Per-request CSP nonces require dynamic rendering.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={[bodyFont.variable, headingFont.variable].join(" ")}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
