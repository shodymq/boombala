"use client";

import { useEffect } from "react";

const target = (hash: string) => {
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
};

/**
 * 1. Direct load of /page#section. Browsers scroll to the fragment themselves and honour
 *    `scroll-padding-top`, so normally there is nothing to do. An extra jump of our own used to fight the
 *    browser's smooth fragment scroll that was already in flight and left the section ~50 px too far down,
 *    so we only step in when the browser left the page at the very top (checked once the page has loaded).
 * 2. Next's router ignores a link to the URL we are already on, so a click on "/#prices" while the
 *    address already ends with #prices (reload, shared link, previous click) did nothing. Handle that
 *    case here. Links to a different hash are still handled by Next itself.
 *
 * `scroll-padding-top` in globals.css keeps the target clear of the fixed header, and the smooth
 * behaviour is dropped for prefers-reduced-motion.
 */
export function HashScroll() {
  useEffect(() => {
    const el = target(window.location.hash);
    if (!el) return;
    const settle = () => {
      if (window.scrollY === 0) el.scrollIntoView({ behavior: "instant", block: "start" });
    };
    if (document.readyState === "complete") {
      settle();
      return;
    }
    window.addEventListener("load", settle, { once: true });
    return () => window.removeEventListener("load", settle);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a || a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.getAttribute("href") ?? "", window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash) return;
      if (url.hash !== window.location.hash) return; // different hash: the router scrolls
      const el = target(url.hash);
      if (!el) return;
      e.preventDefault();
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "instant" : "smooth", block: "start" });
    };
    // Capture phase: runs before Next's Link handler, which then sees defaultPrevented and stands down.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
