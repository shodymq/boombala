import Image from "next/image";
import Link from "next/link";
import { Check } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage, Locale } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { badgeLabel, StatStrip } from "@/components/birthdays/shared";

/**
 * BOOM BALA PARTY: the flagship card. Yellow and tall, with Boom bursting out of the top edge. The card bleeds past the container on
 * the right (3.5rem). Near 1280 px the container has no outer margin left, so the bleed is capped: the card never leaves the viewport.
 */
export function FlagshipPackage({ pkg, locale }: { pkg: BirthdayPackage; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const copy = pkg.copy[locale];
  const badge = badgeLabel(pkg, locale);
  return (
    <article
      aria-labelledby={`${pkg.id}-title`}
      className="relative rounded-bl-[1.25rem] rounded-br-[4.5rem] rounded-tl-[4.5rem] rounded-tr-[1.25rem] bg-sun-400 px-6 pb-10 pt-12 text-grape-900 md:px-10 md:pb-12 lg:-mr-6 xl:-mr-[min(3.5rem,calc(1.75rem_+_max(0px,(100vw-1280px)/2)))] xl:pl-14 xl:pr-16"
    >
      <TrackView event="ViewPackage" params={{ package: pkg.id }} />
      <Image
        src="/boom/wave.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 300px, 190px"
        className="pointer-events-none absolute -top-24 right-3 h-52 w-auto drop-shadow-[0_14px_16px_rgba(20,6,50,0.35)] md:-top-32 md:right-8 md:h-72"
      />

      {badge ? (
        <p className="inline-block rounded-full bg-grape-800 px-4 py-1.5 font-display text-xs font-extrabold uppercase tracking-[0.12em] text-sun-400">{badge}</p>
      ) : null}
      <h3 id={`${pkg.id}-title`} className="mt-4 font-display text-6xl font-black leading-[0.9] tracking-tighter text-grape-800 md:text-7xl xl:text-[5.5rem]">
        BOOM
        <br />
        BALA PARTY
      </h3>
      <p className="mt-3 text-lg font-semibold text-grape-900">{copy.tag}</p>

      <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-3 border-t-2 border-grape-800/20 pt-6">
        <p className="font-display text-5xl font-black tabular-nums tracking-tight text-grape-800 md:text-6xl">
          <span className="sr-only">{ui.regularPrice}: </span>
          {formatTenge(pkg.weekendPrice)}
        </p>
        <p className="flex flex-wrap items-center gap-3 pb-1.5">
          <span className="rounded-full bg-grape-800 px-3 py-1 font-display text-sm font-extrabold text-white">{ui.discountBadge}</span>
          <span className="font-display text-2xl font-black tabular-nums text-grape-700 md:text-3xl">
            <span className="sr-only">{ui.weekdayCaption}: </span>
            {formatTenge(pkg.weekdayPrice)}
          </span>
        </p>
      </div>

      <StatStrip pkg={pkg} ui={ui} tone="flagship" />

      <ul className="mt-6 grid gap-x-8 gap-y-3 max-md:hidden sm:grid-cols-2" aria-label={`${ui.includedTitle}: ${copy.name}`}>
        {copy.program.map((item) => (
          <li key={item.title} className="flex items-start gap-3 text-base leading-snug">
            <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-grape-800 text-sun-400">
              <Check size={12} weight="bold" />
            </span>
            <span>
              <span className="font-bold">{item.title}</span>
              {item.pick > 0 ? <span className="block text-sm text-grape-800">{ui.chooseN(item.pick)}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <LeadButton variant="accent" package={pkg.id} source={`package-${pkg.id}`} locale={locale} className="w-full sm:w-auto">
          {ui.heroCta}
        </LeadButton>
        <Link
          href={locale === "kk" ? `/kk/birthdays#${pkg.id}` : `/birthdays#${pkg.id}`}
          className="inline-flex h-12 items-center justify-center px-4 font-display text-base font-extrabold text-grape-800 underline decoration-grape-800 decoration-2 underline-offset-4"
        >
          {ui.includedTitle}
        </Link>
      </div>
    </article>
  );
}
