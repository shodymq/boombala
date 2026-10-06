"use client";

import { useEffect, useState } from "react";
import { useLeadForm } from "./LeadFormProvider";
import { useSelectedPackage } from "./SelectedPackage";

/** Mobile-only bottom bar. Appears after the first screen so it never competes with the hero CTAs. */
export function StickyBookingCta() {
  const { open, isOpen } = useLeadForm();
  const { selected } = useSelectedPackage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 520);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const show = visible && !isOpen;
  return (
    <div
      aria-hidden={!show}
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 transition-transform duration-300 ease-out lg:hidden ${show ? "translate-y-0" : "translate-y-full"}`}
    >
      <button
        type="button"
        tabIndex={show ? 0 : -1}
        onClick={() => open({ package: selected ?? undefined, source: "sticky-bar" })}
        className="flex h-14 w-full items-center justify-center rounded-full bg-sun-400 font-display text-base font-extrabold text-grape-900 shadow-[0_5px_0_0_#b98600] transition-[transform,box-shadow] duration-150 active:translate-y-[3px] active:shadow-[0_2px_0_0_#b98600]"
      >
        Забронировать праздник
      </button>
    </div>
  );
}
