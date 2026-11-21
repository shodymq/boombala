import type { BirthdayPackage, Locale } from "@/types";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { TrackView } from "@/components/analytics/TrackView";
import { FlagshipPackage } from "./FlagshipPackage";
import { PackageRow } from "./PackageRow";
import { MobilePackageSelector } from "@/components/birthdays/MobilePackageSelector";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";

export function BirthdayShowcase({ packages, locale }: { packages: BirthdayPackage[]; locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const byId = Object.fromEntries(packages.map((p) => [p.id, p])) as Record<BirthdayPackage["id"], BirthdayPackage>;
  const flagship = byId["boom-bala-party"];
  const others = packages.filter((p) => p.id !== "boom-bala-party");
  const compareHref = locale === "kk" ? "/kk/birthdays" : "/birthdays";

  return (
    <section id="birthdays" aria-label={ui.eyebrow} className="relative isolate bg-grape-800 pb-12 pt-12 text-white lg:pb-32 lg:pt-32">
      <TrackView event="ViewBirthdays" />

      {/* < lg: one package at a time. */}
      <Container className="lg:hidden">
        <Reveal>
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            {ui.eyebrow}
          </p>
          <h2 className="font-display text-[2rem] font-black leading-[1] tracking-tighter sm:text-5xl">
            {ui.homeTitle[0]}
            <br />
            <span className="text-sun-400">{ui.homeTitle[1]}</span>
          </h2>
          <p className="mt-3 text-base leading-relaxed text-grape-100">{ui.homeLead}</p>
        </Reveal>
        <div className="mt-6">
          <MobilePackageSelector packages={packages} locale={locale} tone="dark" showCompareLink />
        </div>
      </Container>

      {/* Desktop: heading + rows left, flagship right. Mobile markup is in the block above. */}
      <Container className="grid gap-x-16 gap-y-16 max-lg:hidden lg:grid-cols-12 lg:gap-y-0">
        <div className="contents lg:col-span-6 lg:block">
          <Reveal className="order-1">
            <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">
              <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
              {ui.eyebrow}
            </p>
            <h2 id="birthdays-title" className="font-display text-[2.4rem] font-black leading-[0.98] tracking-tighter sm:text-6xl lg:text-[4.5rem]">
              {ui.homeTitle[0]}
              <br />
              <span className="text-sun-400">{ui.homeTitle[1]}</span>
            </h2>
            <p className="mt-4 max-w-[38ch] text-lg leading-relaxed text-grape-100 md:mt-5">{ui.homeLead}</p>
          </Reveal>

          <div className="order-3 divide-y divide-white/15 border-y border-white/15 lg:mt-10">
            {others.map((pkg) => (
              <Reveal key={pkg.id}>
                <PackageRow pkg={pkg} locale={locale} />
              </Reveal>
            ))}
          </div>
        </div>

        {flagship ? (
          <Reveal className="order-2 max-lg:mt-4 lg:col-span-6 lg:col-start-7 lg:-mt-28" delay={0.05}>
            <FlagshipPackage pkg={flagship} locale={locale} />
            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center md:mt-10 lg:pl-6">
              <ButtonLink href={compareHref} variant="outline" className="w-full sm:w-auto">
                {ui.heroCompare}
              </ButtonLink>
              <p className="max-w-[26ch] text-base text-grape-100">{ui.homeCompareLead}</p>
            </div>
          </Reveal>
        ) : null}
      </Container>
    </section>
  );
}
