"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { BirthdayPackage, Locale, PackageId } from "@/types/birthdays-v4";
import { formatTenge } from "@/lib/format";
import { trackBirthday } from "@/lib/funnel";
import { useSelectedPackage } from "@/components/lead/SelectedPackage";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { badgeLabel, ProgramList, StatStrip } from "./shared";

/** Mobile-only (< lg) package picker: one package at a time, the full programme behind an accordion. */

const THEMES = {
  dark: {
    tabs: "bg-white/10",
    tabOn: "bg-sun-400 text-grape-900",
    tabOff: "text-white",
    title: "text-white",
    sub: "text-grape-200",
    text: "text-grape-50",
    check: "text-sun-400",
    btn: "border-white/40 text-white hover:bg-white/10",
    weekday: "text-sun-400",
    muted: "text-grape-200",
    link: "text-white decoration-sun-400",
    line: "border-white/20",
    chip: "border-white/25 bg-white/10 text-white",
  },
  light: {
    tabs: "bg-grape-100",
    tabOn: "bg-grape-700 text-white",
    tabOff: "text-grape-800",
    title: "text-grape-800",
    sub: "text-muted",
    text: "text-grape-900",
    check: "text-grape-600",
    btn: "border-grape-700 text-grape-700 hover:bg-grape-50",
    weekday: "text-grape-700",
    muted: "text-muted",
    link: "text-grape-700 decoration-sun-400",
    line: "border-grape-200",
    chip: "border-grape-200 bg-grape-50 text-grape-800",
  },
} as const;

/** The short points under the price: the approved conditions first, then the first programme lines. */
function keyPoints(pkg: BirthdayPackage, locale: Locale): string[] {
  const copy = pkg.copy[locale];
  const points = copy.conditions.slice(0, 2).map((c) => (c.note ? `${c.title} · ${c.note}` : c.title));
  for (const item of copy.program) {
    if (points.length >= 5) break;
    points.push(item.title);
  }
  return points;
}

export function MobilePackageSelector({
  packages,
  locale,
  tone,
  showCompareLink = false,
}: {
  packages: BirthdayPackage[];
  locale: Locale;
  tone: keyof typeof THEMES;
  showCompareLink?: boolean;
}) {
  const t = THEMES[tone];
  const ui = BIRTHDAYS_UI[locale];
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const { setSelected } = useSelectedPackage();
  const defaultId: PackageId = packages.find((p) => p.badge === "optimal")?.id ?? packages[0].id;
  const [activeId, setActiveId] = useState<PackageId>(defaultId);
  const [open, setOpen] = useState(false);

  const active = packages.find((p) => p.id === activeId) ?? packages[0];
  const copy = active.copy[locale];

  // Deep link: /birthdays#star-party selects that package and brings the selector into view.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1)) as PackageId;
    if (!packages.some((p) => p.id === id)) return;
    const timer = window.setTimeout(() => {
      setActiveId(id);
      setSelected(id);
      window.setTimeout(() => rootRef.current?.scrollIntoView({ block: "start" }), 60);
    }, 0);
    return () => window.clearTimeout(timer);
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
    if (id !== activeId) trackBirthday("birthday_package_select", { package_id: id, cta_source: "package_tab" });
    setActiveId(id);
    setSelected(id);
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = packages[(index + (e.key === "ArrowRight" ? 1 : packages.length - 1)) % packages.length];
    choose(next.id);
    document.getElementById(`${uid}-tab-${next.id}`)?.focus();
  };

  const badge = badgeLabel(active, locale);

  return (
    <div ref={rootRef} className="scroll-mt-20">
      <div role="tablist" aria-label={ui.tabsLabel} className={`grid grid-cols-3 gap-1 rounded-full p-1 ${t.tabs}`}>
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
              {p.copy[locale].name.split(" ")[0]}
            </button>
          );
        })}
      </div>

      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${active.id}`} className="mt-5">
        {badge ? (
          <p className="mb-2 inline-block rounded-full bg-sun-400 px-3 py-1 font-display text-[0.6875rem] font-extrabold uppercase tracking-[0.1em] text-grape-900">
            {badge}
          </p>
        ) : null}
        <h3 className={`font-display text-[1.625rem] font-black leading-none tracking-tight ${t.title}`}>{copy.name}</h3>
        <p className={`mt-1 text-sm ${t.sub}`}>{copy.tag}</p>
        <StatStrip pkg={active} ui={ui} tone={tone === "dark" ? "dark" : "light"} />

        <div className="mt-3">
          <p className="flex flex-wrap items-center gap-2">
            <s className={`font-display text-base font-extrabold tabular-nums decoration-2 ${t.sub}`}>
              <span className="sr-only">{ui.regularPrice} </span>
              {formatTenge(active.weekendPrice)}
            </s>
            <span className="rounded-full bg-lava-500 px-2 py-0.5 font-display text-xs font-extrabold text-ink">
              {ui.discountBadge}
            </span>
          </p>
          <p className={`mt-0.5 font-display text-[2.25rem] font-black leading-none tabular-nums tracking-tight ${t.weekday}`}>
            <span className="sr-only">{ui.weekdayCaption} </span>
            {formatTenge(active.weekdayPrice)}
          </p>
          <p className={`mt-1 text-sm ${t.sub}`}>{ui.weekdayShort}</p>
          <p className={`mt-0.5 text-sm font-semibold ${t.text}`}>
            {ui.savingsLabel}: {formatTenge(active.weekdaySavings)}
          </p>
        </div>

        <ul className={`mt-4 grid gap-2 text-[0.9375rem] leading-snug ${t.text}`} aria-label={ui.keyPointsLabel(copy.name)}>
          {keyPoints(active, locale).map((point) => (
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
          {open ? ui.hideFull : ui.showFull}
          <CaretDown size={16} weight="bold" aria-hidden="true" className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </button>

        <div id={`${uid}-full`} hidden={!open} className="mt-1">
          <ProgramList items={copy.program} ui={ui} chipClass={t.chip} lineClass={t.line} muted={t.muted} />
        </div>

        {showCompareLink ? (
          <Link href={locale === "kk" ? "/kk/birthdays#compare" : "/birthdays#compare"} className={`mt-4 inline-flex h-11 items-center font-display text-[0.9375rem] font-extrabold underline decoration-2 underline-offset-4 ${t.link}`}>
            {ui.compareLink}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
