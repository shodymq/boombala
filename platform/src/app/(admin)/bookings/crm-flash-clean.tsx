"use client";

import { useEffect } from "react";

/**
 * Removes one-time outcome parameters from the address bar once they have been shown, so a refresh does not repeat a message
 * (and never replays a "booked" notice the manager already read). `request` stays: a refresh must still show the real payment
 * and booking state of that request.
 *
 * After a server action the framework commits its own address a moment after this component mounts, and that commit would
 * put the parameters back. The cleanup therefore runs a few times, shortly after mount, and each run is a no-op once the
 * address is clean.
 */
const ONE_TIME = ["ok", "reservation", "error"];

function clean(): void {
  try {
    const url = new URL(window.location.href);
    if (!ONE_TIME.some((name) => url.searchParams.has(name))) return;
    for (const name of ONE_TIME) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The message simply stays visible until the next navigation.
  }
}

export function FlashClean() {
  useEffect(() => {
    clean();
    const timers = [150, 500, 1200].map((ms) => window.setTimeout(clean, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return null;
}
