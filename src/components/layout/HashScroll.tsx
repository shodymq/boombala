"use client";

import { useEffect } from "react";

/**
 * On a fresh load of /page#section some browsers/hydration orders leave the page at the top.
 * Jump to the target once after mount. Client-side navigation is handled by Next itself.
 */
export function HashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const jump = () => document.getElementById(id)?.scrollIntoView({ behavior: "instant", block: "start" });
    const t = window.setTimeout(jump, 60);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
