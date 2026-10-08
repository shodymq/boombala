"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Sticky group switcher. Plain anchor links (work without JS); JS only highlights the group in view
 * and keeps the active chip centred in the scroller.
 */
export function MenuNav({ groups }: { groups: { id: string; name: string }[] }) {
  const [active, setActive] = useState(groups[0]?.id ?? "");
  const scroller = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const sections = groups.map((g) => document.getElementById(g.id)).filter((e): e is HTMLElement => !!e);
    if (!sections.length || typeof IntersectionObserver === "undefined") return;
    // A thin band just below the sticky bars: the one section crossing it is the "current" group.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-150px 0px -80% 0px" },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [groups]);

  useEffect(() => {
    const box = scroller.current;
    const chip = box?.querySelector<HTMLElement>(`[data-chip="${active}"]`);
    if (!box || !chip) return;
    box.scrollTo({ left: chip.offsetLeft - (box.clientWidth - chip.clientWidth) / 2, behavior: "smooth" });
  }, [active]);

  return (
    <nav
      aria-label="Разделы меню"
      className="sticky top-[65px] z-30 border-b border-line bg-paper md:top-[73px]"
    >
      <div className="mx-auto max-w-[1280px]">
        <ul
          ref={scroller}
          className="flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none] sm:px-6 lg:px-10 [&::-webkit-scrollbar]:hidden"
        >
          {groups.map((g) => {
            const on = g.id === active;
            return (
              <li key={g.id} data-chip={g.id} className="shrink-0">
                <a
                  href={`#${g.id}`}
                  aria-current={on ? "true" : undefined}
                  className={`flex h-11 items-center rounded-full px-4 font-display text-[0.9375rem] font-extrabold transition-colors duration-200 ${
                    on ? "bg-grape-700 text-white" : "bg-grape-100 text-grape-800 hover:bg-grape-200"
                  }`}
                >
                  {g.name}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
