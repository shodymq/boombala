"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keyboard behaviour of the side panel: focus moves into it when it opens (so a screen reader announces it and Tab stays
 * inside its content first), Escape closes it, and Tab cannot leave a modal dialog.
 */
export function DrawerKeys({ closeHref, children }: { closeHref: string; children: React.ReactNode }) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        router.push(closeHref, { scroll: false });
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select,textarea,summary')].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [closeHref, router]);
  return (
    <aside ref={ref} tabIndex={-1} className="flex w-full flex-col overflow-y-auto bg-white p-4 shadow-2xl outline-none md:max-w-md">
      {children}
    </aside>
  );
}
