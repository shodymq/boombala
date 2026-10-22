import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="ru">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
