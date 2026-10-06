"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { BirthdayPackage, ProgramItem, PackageId } from "@/types";
import { formatTenge } from "@/lib/format";
import { track } from "@/lib/analytics";
import { useSelectedPackage } from "@/components/lead/SelectedPackage";

/** Mobile-only (< lg) package picker: one package at a time, details behind an accordion. */

const PRIORITY: ProgramItem["key"][] = ["quest", "shows", "workshop", "animation", "characters", "challenge", "pinata", "greeting"];

/** 3–5 short selling points derived from the data (nothing is hard-coded per package). */
function keyPoints(pkg: BirthdayPackage): string[] {
  const points = [
    `Именинник + ${pkg.freeChildren} детей бесплатно`,
    `−${pkg.extraGuestDiscountPercent}% на вход дополнительным гостям`,
  ];
  const animators = pkg.program.find((i) => i.key === "animators");
  if (animators) points.push(animators.title);
  for (const key of PRIORITY) {
    if (points.length >= 5) break;
    const item = pkg.program.find((i) => i.key === key);
    if (item) points.push(item.title);
  }
  return points;
}

const THEMES = {
  dark: {
    tabs: "bg-white/10",
    tabOn: "bg-sun-400 text-grape-900",
    tabOff: "text-white",
    title: "text-white",
    sub: "text-grape-200",
    price: "text-white",
    weekday: "text-sun-400",
    text: "text-grape-50",
    check: "text-sun-400",
    line: "border-white/20",
    btn: "border-white/40 text-white hover:bg-white/10",
    muted: "text-grape-200",
    link: "text-white decoration-sun-400",
  },
  light: {
    tabs: "bg-grape-100",
    tabOn: "bg-grape-700 text-white",
    tabOff: "text-grape-800",
    title: "text-grape-800",
    sub: "text-muted",
    price: "text-grape-800",
    weekday: "text-grape-600",
    text: "text-grape-900",
    check: "text-grape-600",
    line: "border-grape-200",
    btn: "border-grape-700 text-grape-700 hover:bg-grape-50",
    muted: "text-muted",
    link: "text-grape-700 decoration-sun-400",
  },
} as const;

export function MobilePackageSelector({
  packages,
  tone,
  showCompareLink = false,
}: {
  packages: BirthdayPackage[];
  tone: keyof typeof THEMES;
  showCompareLink?: boolean;
}) {
  const t = THEMES[tone];
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const { setSelected } = useSelectedPackage();
  const defaultId: PackageId = packages.find((p) => p.highlight)?.id ?? packages[0].id;
  const [activeId, setActiveId] = useState<PackageId>(defaultId);
  const [open, setOpen] = useState(false);

  const active = packages.find((p) => p.id === activeId) ?? packages[0];

  // Deep link: /birthdays#wow-party selects that package and brings the selector into view.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1)) as PackageId;
    if (!packages.some((p) => p.id === id)) return;
    const t = window.setTimeout(() => {
      setActiveId(id);
      setSelected(id);
      window.setTimeout(() => rootRef.current?.scrollIntoView({ block: "start" }), 60);
    }, 0);
    return () => window.clearTimeout(t);
  }, [packages, setSelected]);

  // While the selector is on screen, the visible package is the "current" one for the booking bar.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSelected(activeId);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [activeId, setSelected]);

  const choose = (id: PackageId) => {
    setActiveId(id);
    setSelected(id);
    track("ViewPackage", { package: id, source: "tab" });
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = packages[(index + (e.key === "ArrowRight" ? 1 : packages.length - 1)) % packages.length];
    choose(next.id);
    document.getElementById(`${uid}-tab-${next.id}`)?.focus();
  };

  return (
    <div ref={rootRef} className="scroll-mt-20">
      <div role="tablist" aria-label="Праздничные пакеты" className={`grid grid-cols-3 gap-1 rounded-full p-1 ${t.tabs}`}>
        {packages.map((p, i) => {
          const on = p.id === activeId;
          return (
            <button
              key={p.id}
              id={`${uid}-tab-${p.id}`}
              role="tab"
              type="button"
              aria-selected={on}
              aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => choose(p.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`h-11 rounded-full font-display text-[0.9375rem] font-black tracking-tight transition-colors duration-200 ${on ? t.tabOn : t.tabOff}`}
            >
              {p.shortName}
            </button>
          );
        })}
      </div>

      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${active.id}`} className="mt-5">
        {active.highlight ? (
          <p className="mb-2 inline-block rounded-full bg-sun-400 px-3 py-1 font-display text-[0.6875rem] font-extrabold uppercase tracking-[0.1em] text-grape-900">
            {active.highlight}
          </p>
        ) : null}
        <h3 className={`font-display text-[1.625rem] font-black leading-none tracking-tight ${t.title}`}>{active.name}</h3>
        <p className={`mt-1 text-sm ${t.sub}`}>{active.tagline}</p>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`font-display text-[1.875rem] font-black tabular-nums leading-none ${t.price}`}>
            {formatTenge(active.price)}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="rounded-full bg-lava-500 px-2.5 py-0.5 font-display text-xs font-extrabold text-ink">
              в будни −{active.weekdayDiscountPercent}%
            </span>
            <span className={`font-display text-xl font-black tabular-nums ${t.weekday}`}>{formatTenge(active.weekdayPrice)}</span>
          </span>
        </div>

        <ul className={`mt-4 grid gap-2 text-[0.9375rem] leading-snug ${t.text}`} aria-label={`Главное в ${active.name}`}>
          {keyPoints(active).map((point) => (
            <li key={point} className="flex items-start gap-2.5">
              <Check size={16} weight="bold" aria-hidden="true" className={`mt-0.5 shrink-0 ${t.check}`} />
              {point}
            </li>
          ))}
        </ul>

        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-full`}
          onClick={() => setOpen((v) => !v)}
          className={`mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 font-display text-[0.9375rem] font-extrabold transition-colors ${t.btn}`}
        >
          {open ? "Скрыть состав" : "Показать полный состав"}
          <CaretDown size={16} weight="bold" aria-hidden="true" className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </button>

        <div id={`${uid}-full`} hidden={!open} className="mt-1">
          <ul className={`divide-y ${t.line} ${t.text}`}>
            {active.program.map((item) => {
              const detail = [item.note, item.options?.join(" / ")].filter(Boolean).join(" · ");
              return (
                <li key={item.key} className="py-3">
                  <p className="font-display text-base font-extrabold leading-snug">{item.title}</p>
                  {detail ? <p className={`mt-0.5 text-sm leading-relaxed ${t.muted}`}>{detail}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>

        {showCompareLink ? (
          <Link href="/birthdays#compare" className={`mt-4 inline-flex h-11 items-center font-display text-[0.9375rem] font-extrabold underline decoration-2 underline-offset-4 ${t.link}`}>
            Сравнить все пакеты
          </Link>
        ) : null}
      </div>
    </div>
  );
}
