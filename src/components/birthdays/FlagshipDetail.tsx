import Image from "next/image";
import type { BirthdayPackage, Locale } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { badgeLabel, formatDuration, ProgramList } from "./shared";

/**
 * BOOM BALA PARTY: the flagship. Full-bleed yellow, Boom breaks out of the dark section above. What makes it different is named here:
 * 10 children, 3 adults, 2.5 hours, two animators, the premium workshop, the welcome, the piñata, the photo and the invitation.
 */
export function FlagshipDetail({ pkg, locale }: { pkg: BirthdayPackage; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const copy = pkg.copy[locale];
  const badge = badgeLabel(pkg, locale);
  const finale = copy.program.find((i) => i.finale);
  const rest = copy.program.filter((i) => !i.finale);

  return (
    <section id={pkg.id} aria-labelledby={`${pkg.id}-detail-title`} className="relative bg-sun-400 pb-20 pt-36 text-grape-900 max-lg:hidden md:pb-28 lg:pt-28">
      <TrackView event="ViewPackage" params={{ package: pkg.id }} />
      <Image
        src="/boom/jump.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 460px, 220px"
        className="pointer-events-none absolute -top-20 right-2 z-10 h-52 w-auto drop-shadow-[0_16px_18px_rgba(20,6,50,0.35)] sm:right-[10%] md:-top-40 md:h-80 lg:-top-72 lg:right-[8%] lg:h-[40rem]"
      />

      <Container>
        <Reveal className="lg:max-w-[58%]">
          {badge ? (
            <p className="inline-block rounded-full bg-grape-800 px-4 py-1.5 font-display text-xs font-extrabold uppercase tracking-[0.12em] text-sun-400">{badge}</p>
          ) : null}
          <h2 id={`${pkg.id}-detail-title`} className="mt-4 font-display text-6xl font-black leading-[0.9] tracking-tighter text-grape-800 sm:text-8xl lg:text-[8rem]">
            BOOM
            <br />
            BALA PARTY
          </h2>
          <p className="mt-4 text-xl font-semibold">{copy.tag}</p>

          <div className="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3 border-t-2 border-grape-800/25 pt-6">
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
            <p className="w-full text-base font-semibold text-grape-800">
              {ui.savingsLabel}: {formatTenge(pkg.weekdaySavings)}
            </p>
          </div>

          <dl className="mt-6 grid grid-cols-3 divide-x-2 divide-grape-800/25 border-y-2 border-grape-800/25 text-center">
            <div className="py-4">
              <dt className="sr-only">{copy.conditions[0].title}</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">{pkg.kidsIncluded}</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">{copy.conditions[0].note}</dd>
            </div>
            <div className="py-4">
              <dt className="sr-only">{ui.rowDurationLabel}</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">{formatDuration(pkg.durationMinutes, ui)}</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">{ui.rowDurationLabel.toLowerCase()}</dd>
            </div>
            <div className="py-4">
              <dt className="sr-only">{ui.rowAnimators}</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">{pkg.animators}</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">{ui.rowAnimators.toLowerCase()}</dd>
            </div>
          </dl>
        </Reveal>

        <h3 className="mt-14 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-800">{ui.includedTitle}</h3>
        <div className="mt-3 md:grid md:grid-cols-2 md:gap-x-14">
          <ProgramList items={rest} ui={ui} chipClass="border-0 bg-white text-grape-800" lineClass="divide-grape-800/25" muted="text-grape-800/80" />
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 md:gap-x-14">
          {finale ? (
            <div className="rounded-3xl bg-grape-800 p-5 text-white">
              <p className="font-display text-xl font-extrabold text-sun-400">{finale.title}</p>
              {finale.detail ? <p className="mt-1 text-base">{finale.detail}</p> : null}
              <p className="mt-2 text-sm font-bold text-sun-400">{finale.minutes} {ui.minShort}</p>
            </div>
          ) : null}
          <div className="rounded-3xl bg-white/60 p-5">
            <p className="font-display text-xl font-extrabold text-grape-800">{ui.photoTitle}</p>
            <p className="mt-1 text-base">{ui.photoText}</p>
          </div>
          <div className="rounded-3xl bg-white/60 p-5 md:col-span-2">
            <p className="font-display text-xl font-extrabold text-grape-800">{ui.bonusTitle}</p>
            <p className="mt-1 text-base">{ui.bonusText}</p>
          </div>
        </div>
        <p className="mt-6 text-sm text-grape-800/80">{ui.flagshipNoteCake}</p>

        <LeadButton variant="primary" package={pkg.id} source="package-boom-bala-party" locale={locale} className="mt-8 w-full sm:w-auto">
          {ui.heroCta}
        </LeadButton>
      </Container>
    </section>
  );
}
