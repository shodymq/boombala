"use client";

import { useEffect, useState } from "react";
import { getOpeningState, staticOpeningState, type OpeningState } from "@/lib/opening";

const pad = (n: number) => String(n).padStart(2, "0");

function Countdown({ ms }: { ms: number }) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [
    { v: Math.floor(total / 86400), l: "дн" },
    { v: Math.floor((total % 86400) / 3600), l: "ч" },
    { v: Math.floor((total % 3600) / 60), l: "мин" },
    { v: total % 60, l: "сек" },
  ];
  return (
    <span className="ml-1 inline-flex gap-2 tabular-nums" aria-hidden="true">
      {parts.map((p) => (
        <span key={p.l}>
          {pad(p.v)}
          <span className="ml-0.5 text-xs font-bold text-grape-600">{p.l}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Opening badge. Server-renders the static "Открытие — 7 октября" and switches
 * to today / countdown / open once mounted. Countdown appears only when
 * `siteConfig.opening.time` is set.
 */
export function OpeningStatus({ className = "" }: { className?: string }) {
  const [state, setState] = useState<OpeningState>(staticOpeningState);

  useEffect(() => {
    const tick = () => setState(getOpeningState());
    tick();
    const interval = setInterval(tick, getOpeningState().kind === "countdown" ? 1000 : 30_000);
    return () => clearInterval(interval);
  }, []);

  const isOpen = state.kind === "open";

  return (
    <p
      className={`inline-flex items-center gap-2.5 rounded-full border-2 border-grape-700 bg-white py-2 pl-3 pr-4 font-display text-[0.9375rem] font-extrabold text-grape-800 shadow-[0_4px_0_0_var(--color-grape-200)] ${className}`}
    >
      <span className="relative flex h-3 w-3" aria-hidden="true">
        <span className={`absolute inset-0 rounded-full ${isOpen ? "bg-emerald-500" : "bg-lava-500"} animate-pulse-dot`} />
        <span className={`relative h-3 w-3 rounded-full ${isOpen ? "bg-emerald-500" : "bg-lava-500"}`} />
      </span>
      <span>{state.label}</span>
      {state.kind === "countdown" ? <Countdown ms={state.ms} /> : null}
    </p>
  );
}
