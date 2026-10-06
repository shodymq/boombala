import Image from "next/image";
import type { BirthdayPackage } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

const art: Record<string, { src: string; alt: string }> = {
  "wow-party": { src: "/boom/wow.webp", alt: "Boom удивлённо поднимает руки" },
  "magic-party": { src: "/boom/present.webp", alt: "Boom показывает рукой в сторону" },
};

/** WOW / MAGIC: typographic, divided by one heavy rule; Boom stands on the rule. */
export function PackageEditorial({ pkg }: { pkg: BirthdayPackage }) {
  const a = art[pkg.id];
  return (
    <section id={pkg.id} aria-labelledby={`${pkg.id}-detail-title`} className="py-12 max-lg:hidden md:py-24">
      <Container>
        <div className="relative border-t-[3px] border-grape-800 pt-10">
          <TrackView event="ViewPackage" params={{ package: pkg.id }} />
          {a ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-[8rem] right-0 h-[8rem] w-40 overflow-hidden md:-top-[10.5rem] md:h-[10.5rem] md:w-52"
            >
              <Image
                src={a.src}
                alt=""
                width={1086}
                height={1448}
                sizes="220px"
                className="absolute left-1/2 top-0 h-[16rem] w-auto max-w-none -translate-x-1/2 md:h-[21rem]"
              />
            </div>
          ) : null}

          <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
            <Reveal className="lg:col-span-5">
              <h2
                id={`${pkg.id}-detail-title`}
                className="font-display text-5xl font-black leading-[0.95] tracking-tighter text-grape-800 md:text-6xl"
              >
                {pkg.name}
              </h2>
              <p className="mt-2 text-lg text-muted">{pkg.tagline}</p>

              <p className="mt-7 font-display text-5xl font-black tabular-nums tracking-tight text-grape-800">
                {formatTenge(pkg.price)}
              </p>
              <p className="mt-3 flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-lava-500 px-3 py-1 font-display text-sm font-extrabold text-ink">
                  в будни −{pkg.weekdayDiscountPercent}%
                </span>
                <span className="font-display text-3xl font-black tabular-nums text-grape-600">
                  {formatTenge(pkg.weekdayPrice)}
                </span>
              </p>

              <p className="mt-6 text-lg font-semibold text-grape-900">Бесплатный вход: именинник + {pkg.freeChildren} детей</p>
              <p className="mt-1 text-base text-muted">−{pkg.extraGuestDiscountPercent}% на вход дополнительным гостям</p>

              <LeadButton variant="primary" package={pkg.id} source={`package-${pkg.id}`} className="mt-8 w-full sm:w-auto">
                Узнать о свободной дате
              </LeadButton>
            </Reveal>

            <Reveal className="lg:col-span-7" delay={0.06}>
              <h3 className="font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">Что входит</h3>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {pkg.program.map((item) => (
                  <li key={item.key} className="py-4">
                    <p className="font-display text-lg font-extrabold text-grape-800 md:text-xl">
                      {item.title}
                      {item.note ? <span className="ml-2 text-base font-bold text-muted">({item.note})</span> : null}
                    </p>
                    {item.options ? (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {item.options.map((o) => (
                          <li
                            key={o}
                            className="rounded-full border border-grape-200 bg-grape-50 px-3.5 py-1.5 text-sm font-medium text-grape-800 md:text-base"
                          >
                            {o}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}
