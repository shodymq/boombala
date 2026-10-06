import Image from "next/image";
import type { BirthdayPackage } from "@/types";
import { formatTenge } from "@/lib/format";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

/** BOOM PARTY: the strongest package. Full-bleed yellow, Boom breaks out of the dark section above. */
export function FlagshipDetail({ pkg, contactHref }: { pkg: BirthdayPackage; contactHref: string }) {
  return (
    <section
      id={pkg.id}
      aria-labelledby={`${pkg.id}-detail-title`}
      className="relative bg-sun-400 pb-20 pt-36 text-grape-900 md:pb-28 lg:pt-28"
    >
      <Image
        src="/boom/jump.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 460px, 220px"
        className="pointer-events-none absolute -top-28 right-2 z-10 h-60 w-auto drop-shadow-[0_16px_18px_rgba(20,6,50,0.35)] sm:right-[10%] md:-top-40 md:h-80 lg:-top-72 lg:right-[8%] lg:h-[40rem]"
      />

      <Container>
        <Reveal className="lg:max-w-[58%]">
          <p className="inline-block rounded-full bg-grape-800 px-4 py-1.5 font-display text-xs font-extrabold uppercase tracking-[0.12em] text-sun-400">
            {pkg.highlight}
          </p>
          <h2
            id={`${pkg.id}-detail-title`}
            className="mt-4 font-display text-6xl font-black leading-[0.9] tracking-tighter text-grape-800 sm:text-8xl lg:text-[8rem]"
          >
            BOOM
            <br />
            PARTY
          </h2>
          <p className="mt-4 text-xl font-semibold">{pkg.tagline}</p>

          <div className="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3 border-t-2 border-grape-800/25 pt-6">
            <p className="font-display text-5xl font-black tabular-nums tracking-tight text-grape-800 md:text-6xl">
              {formatTenge(pkg.price)}
            </p>
            <p className="flex items-center gap-3 pb-1.5">
              <span className="rounded-full bg-grape-800 px-3 py-1 font-display text-sm font-extrabold text-white">
                в будни −{pkg.weekdayDiscountPercent}%
              </span>
              <span className="font-display text-2xl font-black tabular-nums text-grape-700 md:text-3xl">
                {formatTenge(pkg.weekdayPrice)}
              </span>
            </p>
          </div>

          <dl className="mt-6 grid grid-cols-3 divide-x-2 divide-grape-800/25 border-y-2 border-grape-800/25 text-center">
            <div className="py-4">
              <dt className="sr-only">Бесплатный вход</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">{pkg.freeChildren}</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">детей и именинник бесплатно</dd>
            </div>
            <div className="py-4">
              <dt className="sr-only">Аниматоры</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">2</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">аниматора</dd>
            </div>
            <div className="py-4">
              <dt className="sr-only">Скидка гостям</dt>
              <dd className="font-display text-3xl font-black text-grape-800 md:text-4xl">−{pkg.extraGuestDiscountPercent}%</dd>
              <dd className="mt-1 px-1 text-xs font-semibold leading-tight md:text-sm">на вход доп. гостям</dd>
            </div>
          </dl>
        </Reveal>

        <h3 className="mt-14 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-800">Что входит</h3>
        <ul className="mt-3 grid gap-x-14 md:grid-cols-2">
          {pkg.program
            .filter((i) => i.key !== "animators")
            .map((item) => (
              <li key={item.key} className="border-t-2 border-grape-800/25 py-5">
                <p className="font-display text-xl font-extrabold text-grape-800">{item.title}</p>
                {item.options ? (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {item.options.map((o) => (
                      <li key={o} className="rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-grape-800 md:text-base">
                        {o}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
        </ul>

        <ButtonLink href={contactHref} variant="primary" className="mt-8 w-full sm:w-auto">
          Узнать о свободной дате
        </ButtonLink>
      </Container>
    </section>
  );
}
