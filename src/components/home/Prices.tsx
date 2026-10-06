import Image from "next/image";
import type { Membership, PricingTable } from "@/types";
import { formatTenge } from "@/lib/format";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { TrackView } from "@/components/analytics/TrackView";

function Value({ price, dark, compact }: { price: number; dark?: boolean; compact?: boolean }) {
  if (price === 0) {
    return (
      <span className={`rounded-full bg-sun-400 font-display font-extrabold text-grape-900 ${compact ? "px-2.5 py-1 text-xs" : "px-4 py-1.5 text-base md:text-lg"}`}>
        бесплатно
      </span>
    );
  }
  return (
    <span
      className={`font-display font-black tabular-nums ${compact ? "whitespace-nowrap text-lg" : "text-2xl md:text-3xl"} ${dark ? "text-white" : "text-grape-800"}`}
    >
      {formatTenge(price)}
    </span>
  );
}

export function Prices({ pricing, membership }: { pricing: PricingTable; membership: Membership }) {
  const [weekday, weekend] = pricing.categories;

  const perkRows = [
    ...pricing.perks.map((p) => ({ id: p.id, label: p.label, value: p.value })),
    { id: "companion", label: "Сопровождающие", value: formatTenge(pricing.companionPrice) },
    { id: "membership", label: membership.name, value: formatTenge(membership.price) },
  ];

  return (
    <section id="prices" aria-labelledby="prices-title" className="relative bg-grape-50 pb-14 pt-28 md:pb-28 md:pt-44 lg:pb-40 lg:pt-56">
      <TrackView event="ViewPrices" />
      <Container>
        <Reveal>
          <SectionHeading eyebrow="Цены" title={<span id="prices-title">Входные билеты</span>}>
            Понятные цены для будних и выходных дней.
          </SectionHeading>
        </Reveal>

        <div className="mt-6 grid gap-4 md:mt-14 md:gap-5 lg:grid-cols-12">
          {/* Mobile: one compact table, weekdays and weekends side by side */}
          <Reveal className="md:hidden">
            <div className="overflow-hidden rounded-3xl border border-line bg-white shadow-soft">
              <div className="grid grid-cols-[1fr_6.75rem_6.75rem] text-center font-display text-sm font-extrabold">
                <div className="px-4 py-3 text-left text-xs uppercase tracking-[0.1em] text-grape-600">Возраст</div>
                <div className="flex items-center justify-center bg-grape-100 px-1 py-3 text-grape-800">Будни</div>
                <div className="flex items-center justify-center bg-grape-700 px-1 py-3 leading-tight text-white">Выходные, праздники</div>
              </div>
              {weekday.rows.map((r, i) => (
                <div key={r.id} className="grid grid-cols-[1fr_6.75rem_6.75rem] items-stretch border-t border-line">
                  <div className="flex items-center px-4 py-4 text-base font-semibold text-grape-900">{r.label}</div>
                  <div className="flex items-center justify-center bg-grape-50 px-1">
                    <Value price={r.price} compact />
                  </div>
                  <div className="flex items-center justify-center bg-grape-700 px-1">
                    <Value price={weekend.rows[i].price} dark compact />
                  </div>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal className="max-md:hidden lg:col-span-5">
            <div className="h-full rounded-[2rem] border border-line bg-white p-6 shadow-soft md:p-9">
              <h3 className="lg:max-xl:min-h-[4.25rem] font-display text-2xl font-black text-grape-800 md:text-3xl">{weekday.title}</h3>
              <ul className="mt-4 divide-y divide-line">
                {weekday.rows.map((r) => (
                  <li key={r.id} className="flex min-h-[4.25rem] items-center justify-between gap-4 py-3">
                    <span className="text-base font-medium text-muted md:text-lg">{r.label}</span>
                    <Value price={r.price} />
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={0.06} className="max-md:hidden lg:col-span-7">
            <div className="relative h-full overflow-hidden rounded-[2rem] bg-grape-700 p-6 text-white md:p-9">
              <h3 className="lg:max-xl:min-h-[4.25rem] font-display text-2xl font-black md:text-3xl">{weekend.title}</h3>
              <ul className="mt-4 divide-y divide-white/15">
                {weekend.rows.map((r) => (
                  <li key={r.id} className="flex min-h-[4.25rem] items-center justify-between gap-4 py-3">
                    <span className="text-base font-medium text-grape-100 md:text-lg">{r.label}</span>
                    <Value price={r.price} dark />
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={0.1} className="lg:col-span-12">
            <div className="relative rounded-[2rem] bg-sun-100 p-5 md:p-9 lg:pr-[34%]">
              <h3 className="font-display text-2xl font-black text-grape-800 md:text-3xl">
                Льготы и дополнительные условия
              </h3>
              <ul className="mt-4 divide-y divide-sun-400/40">
                {perkRows.map((p) => (
                  <li key={p.id} className="flex min-h-[3.75rem] items-center justify-between gap-4 py-3">
                    <span className="text-base font-semibold text-grape-900 md:text-lg">{p.label}</span>
                    <span className="shrink-0 rounded-full bg-white px-4 py-1.5 font-display text-base font-extrabold text-grape-800 md:text-lg">
                      {p.value}
                    </span>
                  </li>
                ))}
              </ul>
              <Image
                src="/boom/present.webp"
                alt=""
                width={1086}
                height={1448}
                sizes="380px"
                className="pointer-events-none absolute -top-14 right-8 hidden h-[calc(100%+4.5rem)] w-auto lg:block"
              />
            </div>
          </Reveal>
        </div>

        <p className="mt-4 text-sm text-muted md:mt-6">Стоимость указана в тенге.</p>
      </Container>
    </section>
  );
}
