"use client";

import { useEffect, useRef } from "react";
import { track, type TrackEvent } from "@/lib/analytics";

/**
 * Zero-size sentinel: fires `event` once when its (relative) parent scrolls into view.
 * Put it inside a `relative` section; it overlays the section without affecting layout.
 */
export function TrackView({ event, params }: { event: TrackEvent; params?: Record<string, string> }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          track(event, params);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
  return <span ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10" />;
}
