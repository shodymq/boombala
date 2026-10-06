import type { BirthdayPackage } from "@/types";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { TrackView } from "@/components/analytics/TrackView";
import { FlagshipPackage } from "./FlagshipPackage";
import { PackageRow } from "./PackageRow";

export function BirthdayShowcase({ packages }: { packages: BirthdayPackage[] }) {
  const byId = Object.fromEntries(packages.map((p) => [p.id, p])) as Record<BirthdayPackage["id"], BirthdayPackage>;

  return (
    <section
      id="birthdays"
      aria-labelledby="birthdays-title"
      className="relative isolate bg-grape-800 pb-16 pt-16 text-white md:pb-32 lg:pt-32"
    >
      <TrackView event="ViewBirthdays" />
      {/* Mobile: heading -> strongest package -> the other two. Desktop: heading + rows left, flagship right. */}
      <Container className="grid gap-x-16 gap-y-16 lg:grid-cols-12 lg:gap-y-0">
        {/* contents on mobile so heading / flagship / rows can be reordered; one left column on desktop */}
        <div className="contents lg:col-span-6 lg:block">
          <Reveal className="order-1">
            <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">
              <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
              Дни рождения
            </p>
            <h2
              id="birthdays-title"
              className="font-display text-[2.4rem] font-black leading-[0.98] tracking-tighter sm:text-6xl lg:text-[4.5rem]"
            >
              Три способа
              <br />
              устроить <span className="text-sun-400">BOOM</span>
            </h2>
            <p className="mt-4 max-w-[38ch] text-lg leading-relaxed text-grape-100 md:mt-5">
              Три праздничных пакета. В будние дни действует скидка 30%.
            </p>
          </Reveal>

          <div className="order-3 divide-y divide-white/15 border-y border-white/15 lg:mt-10">
            <Reveal>
              <PackageRow pkg={byId["wow-party"]} />
            </Reveal>
            <Reveal>
              <PackageRow pkg={byId["magic-party"]} />
            </Reveal>
          </div>
        </div>

        <Reveal className="order-2 max-lg:mt-4 lg:col-span-6 lg:col-start-7 lg:-mt-28" delay={0.05}>
          <FlagshipPackage pkg={byId["boom-party"]} />
          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center md:mt-10 lg:pl-6">
            <ButtonLink href="/birthdays" variant="outline" className="w-full sm:w-auto">
              Сравнить пакеты
            </ButtonLink>
            <p className="max-w-[26ch] text-base text-grape-100">Все три пакета в одной таблице.</p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
