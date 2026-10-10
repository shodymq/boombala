"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { captureAttribution } from "@/lib/attribution";
import { CONSENT_EVENT, hasAnalyticsConsent, track } from "@/lib/analytics";

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

/**
 * Optional GA4 + Meta Pixel. Renders nothing when IDs are absent.
 * Also: first-touch UTM capture, SPA page views and delegated click tracking
 * (Instagram links, and any element with data-track="ClickRoute").
 */
export function Analytics() {
  const pathname = usePathname();
  const first = useRef(true);
  // External scripts (GA4, Meta Pixel) are not even requested until the visitor agrees to analytics.
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    const sync = () => setConsent(hasAnalyticsConsent());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, []);

  useEffect(() => {
    captureAttribution();
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      window.gtag?.("event", "page_view", { page_path: pathname });
      window.fbq?.("track", "PageView");
    } catch {
      /* ignore */
    }
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a");
      if (!a) return;
      if (a.dataset.track === "ClickRoute") track("ClickRoute", { page: window.location.pathname });
      else if (/(^|\.)instagram\.com$/.test(new URL(a.href, window.location.href).hostname)) {
        track("ClickInstagram", { page: window.location.pathname });
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <>
      {GA_ID && consent ? (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
          <Script id="ga4-init" strategy="afterInteractive">{`
            window.dataLayer = window.dataLayer || [];
            window.gtag = function(){ dataLayer.push(arguments); };
            // This script is only rendered after the visitor granted analytics consent. Ad signals stay off.
            gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
            gtag('js', new Date());
            gtag('config', '${GA_ID}', { allow_google_signals: false, allow_ad_personalization_signals: false });
          `}</Script>
        </>
      ) : null}
      {PIXEL_ID && consent ? (
        <Script id="meta-pixel" strategy="afterInteractive">{`
          !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', '${PIXEL_ID}');
          fbq('track', 'PageView');
        `}</Script>
      ) : null}
    </>
  );
}
