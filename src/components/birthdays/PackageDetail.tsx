import Image from "next/image";
import type { BirthdayPackage, Locale } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { badgeLabel, ProgramList } from "./shared";

/** Boom is a separate, flagship block (FlagshipDetail). Happy and Star share this typographic layout. */
const art: Partial<Record<BirthdayPackage["id"], string>> = {
  "happy-party": "/boom/present.webp",
  "star-party": "/boom/wow.webp",
};

export function PackageDetail({ pkg, locale }: { pkg: BirthdayPackage; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const copy = pkg.copy[locale];
  const badge = badgeLabel(pkg, locale);
  const src = art[pkg.id];

  return (
    <section id={pkg.id} aria-labelledby={`${pkg.id}-detail-title`} className="py-12 max-lg:hidden md:py-24">
      <Container>
        <div className="relative border-t-[3px] border-grape-800 pt-10">
          <TrackView event="ViewPackage" params={{ package: pkg.id }} />
          {src ? (
            <div aria-hidden="true" className="pointer-events-none absolute -top-[8rem] right-0 h-[8rem] w-40 overflow-hidden md:-top-[10.5rem] md:h-[10.5rem] md:w-52">
              <Image src={src} alt="" width={1086} height={1448} sizes="220px" className="absolute left-1/2 top-0 h-[16rem] w-auto max-w-none -translate-x-1/2 md:h-[21rem]" />
            </div>
          ) : null}

          <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
            <Reveal className="lg:col-span-5">
              {badge ? (
                <p className="mb-3 inline-block rounded-full bg-sun-400 px-3 py-1 font-display text-xs font-extrabold uppercase tracking-[0.1em] text-grape-900">{badge}</p>
              ) : null}
              <h2 id={`${pkg.id}-detail-title`} className="font-display text-5xl font-black leading-[0.95] tracking-tighter text-grape-800 md:text-6xl">
                {copy.name}
              </h2>
              <p className="mt-2 text-lg text-muted">{copy.tag}</p>

              <p className="mt-7 font-display text-5xl font-black tabular-nums tracking-tight text-grape-800">
                <span className="sr-only">{ui.regularPrice}: </span>
                {formatTenge(pkg.weekendPrice)}
              </p>
              <p className="mt-3 flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-lava-500 px-3 py-1 font-display text-sm font-extrabold text-ink">{ui.discountBadge}</span>
                <span className="font-display text-3xl font-black tabular-nums text-grape-600">
                  <span className="sr-only">{ui.weekdayCaption}: </span>
                  {formatTenge(pkg.weekdayPrice)}
                </span>
              </p>
              <p className="mt-2 text-base text-muted">
                {ui.savingsLabel}: {formatTenge(pkg.weekdaySavings)}
              </p>

              <ul className="mt-6 grid gap-2 text-base text-grape-900" aria-label={copy.name}>
                {copy.conditions.map((c) => (
                  <li key={c.title} className="flex flex-col">
                    <span className="font-semibold">{c.title}</span>
                    {c.note ? <span className="text-sm text-muted">{c.note}</span> : null}
                  </li>
                ))}
              </ul>

              <LeadButton variant="primary" package={pkg.id} source={`package-${pkg.id}`} locale={locale} className="mt-8 w-full sm:w-auto">
                {ui.heroCta}
              </LeadButton>
            </Reveal>

            <Reveal className="lg:col-span-7" delay={0.06}>
              <h3 className="font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">{ui.includedTitle}</h3>
              <div className="mt-2 border-y border-line">
                <ProgramList items={copy.program} ui={ui} chipClass="border-grape-200 bg-grape-50 text-grape-800" lineClass="divide-line" muted="text-muted" />
              </div>
              <p className="mt-4 text-sm text-muted">{ui.flagshipNoteCake}</p>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}
