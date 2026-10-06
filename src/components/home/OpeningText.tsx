"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getOpeningPhase, type OpeningPhase } from "@/lib/opening";

/**
 * Text that depends on the opening phase. Server-renders the "before" copy and switches on
 * the client. A missing phase falls back to its neighbour: working -> open -> before.
 */
export function OpeningText({
  before,
  working,
  open,
}: {
  before: ReactNode;
  working?: ReactNode;
  open?: ReactNode;
}) {
  const [phase, setPhase] = useState<OpeningPhase>("before");
  useEffect(() => {
    const check = () => setPhase(getOpeningPhase());
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, []);
  if (phase === "open") return <>{open ?? working ?? before}</>;
  if (phase === "working") return <>{working ?? open ?? before}</>;
  return <>{before}</>;
}
