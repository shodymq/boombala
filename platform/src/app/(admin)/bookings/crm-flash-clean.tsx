"use client";

import { useEffect } from "react";

/**
 * Removes the one-time `notice` from the address bar once it has been shown, so a refresh does not repeat "booked" or
 * "rescheduled". Error parameters stay in the URL on purpose: a refresh must still show an unconfirmed paid request.
 */
export function FlashClean() {
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("notice")) return;
      url.searchParams.delete("notice");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The notice simply stays visible until the next navigation.
    }
  }, []);
  return null;
}
