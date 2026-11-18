import type { ReactNode } from "react";
import type { Locale } from "@/types";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { HashScroll } from "./HashScroll";
import { MenuStateProvider } from "./MenuState";
import { LeadFormProvider } from "@/components/lead/LeadFormProvider";
import { StickyBookingCta } from "@/components/lead/StickyBookingCta";
import { SelectedPackageProvider } from "@/components/lead/SelectedPackage";
import { shellUi } from "@/lib/nav";

/**
 * The frame of every page of one locale: skip link, header, main, footer and the booking bar. Both root layouts (ru, kk) use it, so
 * the two versions cannot drift apart; only the document language and the texts differ.
 */
export function SiteShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-grape-700 focus:px-5 focus:py-3 focus:text-white"
      >
        {shellUi[locale].skip}
      </a>
      <SelectedPackageProvider>
        <MenuStateProvider>
          <LeadFormProvider>
            <HashScroll />
            <Header locale={locale} />
            <main id="main">{children}</main>
            <Footer locale={locale} />
            <StickyBookingCta locale={locale} />
          </LeadFormProvider>
        </MenuStateProvider>
      </SelectedPackageProvider>
    </>
  );
}
