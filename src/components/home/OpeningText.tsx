"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getOpeningState } from "@/lib/opening";

/**
 * Text that must change once the venue has opened. Server-renders the "before" copy and
 * switches to "after" on the client when the opening moment has passed.
 */
export function OpeningText({ before, after }: { before: ReactNode; after: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(getOpeningState().kind === "open");
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);
  return <>{open ? after : before}</>;
}
