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
 * 1. On a fresh load of /page#section some browsers/hydration orders leave the page at the top:
 *    jump to the target once after mount.
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
    const t = window.setTimeout(() => el.scrollIntoView({ behavior: "instant", block: "start" }), 60);
    return () => window.clearTimeout(t);
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
