"use client";

import { useEffect } from "react";

/**
 * Removes one-time outcome parameters from the address bar once they have been shown, so a refresh does not repeat a message.
 * `request` stays: a refresh must still show the real payment and booking state of that request.
 */
const ONE_TIME = ["ok", "reservation", "error"];

export function FlashClean() {
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!ONE_TIME.some((name) => url.searchParams.has(name))) return;
      for (const name of ONE_TIME) url.searchParams.delete(name);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The message simply stays visible until the next navigation.
    }
  }, []);
  return null;
}
