import Link from "next/link";
import { Check } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage, Locale } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { badgeLabel, StatStrip } from "@/components/birthdays/shared";

/** Secondary packages (Happy, Star): typographic rows on the dark section, no card chrome. */
export function PackageRow({ pkg, locale }: { pkg: BirthdayPackage; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const copy = pkg.copy[locale];
  const badge = badgeLabel(pkg, locale);
  return (
    <article aria-labelledby={`${pkg.id}-title`} className="relative py-7 md:py-11">
      <TrackView event="ViewPackage" params={{ package: pkg.id }} />
      {badge ? <p className="mb-2 inline-block rounded-full bg-sun-400 px-3 py-1 font-display text-xs font-extrabold uppercase tracking-[0.1em] text-grape-900">{badge}</p> : null}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 id={`${pkg.id}-title`} className="font-display text-4xl font-black tracking-tight text-white md:text-5xl">
          {copy.name}
        </h3>
        <p className="text-base text-grape-200">{copy.tag}</p>
      </div>

      <StatStrip pkg={pkg} ui={ui} tone="dark" />

      <div className="mt-6 grid gap-6 sm:grid-cols-[auto_1fr] sm:gap-10">
        <div>
          <p className="font-display text-4xl font-black tabular-nums text-white md:text-5xl">
            <span className="sr-only">{ui.regularPrice}: </span>
            {formatTenge(pkg.weekendPrice)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="rounded-full bg-lava-500 px-3 py-1 font-display text-sm font-extrabold text-ink">{ui.discountBadge}</span>
            <span className="font-display text-2xl font-black tabular-nums text-sun-400 md:text-3xl">
              <span className="sr-only">{ui.weekdayCaption}: </span>
              {formatTenge(pkg.weekdayPrice)}
            </span>
          </div>
        </div>

        <div>
          <ul className="grid gap-2 text-base text-white" aria-label={`${ui.includedTitle}: ${copy.name}`}>
            {copy.conditions.map((c) => (
              <li key={c.title} className="flex flex-col">
                <span className="font-semibold">{c.title}</span>
                {c.note ? <span className="text-grape-200">{c.note}</span> : null}
              </li>
            ))}
          </ul>
          <ul className="mt-4 grid gap-2" aria-label={`${ui.includedTitle}: ${copy.name}`}>
            {copy.program.map((item) => (
              <li key={item.title} className="flex items-start gap-3 text-base leading-snug text-grape-100">
                <Check size={18} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-sun-400" />
                <span>
                  {item.title}
                  {item.pick > 0 ? <span className="text-grape-200"> ({ui.chooseN(item.pick)})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
        <LeadButton variant="accent" package={pkg.id} source={`package-${pkg.id}`} locale={locale} className="w-full sm:w-auto">
          {ui.heroCta}
        </LeadButton>
        <Link
          href={locale === "kk" ? `/kk/birthdays#${pkg.id}` : `/birthdays#${pkg.id}`}
          className="inline-flex h-12 items-center justify-center px-4 font-display text-base font-extrabold text-white underline decoration-sun-400 decoration-2 underline-offset-4"
        >
          {ui.includedTitle}
        </Link>
      </div>
    </article>
  );
}
