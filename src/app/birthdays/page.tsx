import type { Metadata } from "next";
import Image from "next/image";
import { getBirthdayPackages } from "@/services/birthdays";
import { getPrimaryContact } from "@/services/config";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { Burst } from "@/components/ui/Decor";
import { ComparisonMatrix } from "@/components/birthdays/ComparisonMatrix";
import { FlagshipDetail } from "@/components/birthdays/FlagshipDetail";
import { PackageEditorial } from "@/components/birthdays/PackageEditorial";

export const metadata: Metadata = {
  title: "Дни рождения",
  description:
    "Праздничные пакеты Boom Bala в Алматы: WOW PARTY, MAGIC PARTY и BOOM PARTY. Состав, цены и скидка 30% в будние дни.",
  alternates: { canonical: "/birthdays" },
  openGraph: {
    title: "Дни рождения — Boom Bala",
    description: "WOW PARTY, MAGIC PARTY и BOOM PARTY: состав, цены и скидка 30% в будние дни.",
    url: "/birthdays",
    locale: "ru_RU",
    type: "website",
  },
};

export default async function BirthdaysPage() {
  const packages = await getBirthdayPackages();
  const contact = getPrimaryContact();
  const byId = Object.fromEntries(packages.map((p) => [p.id, p]));
  const boom = byId["boom-party"];
  const others = packages.filter((p) => p.id !== "boom-party");

  return (
    <>
      <section aria-labelledby="birthdays-hero" className="relative isolate flex flex-col overflow-hidden">
        <Container className="relative z-10 lg:grid lg:grid-cols-12">
          <div className="pb-4 pt-8 md:pt-12 lg:col-span-7 lg:py-24">
            <p className="flex items-center gap-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
              <Burst className="h-7 w-8 text-sun-400" />
              Дни рождения
            </p>
            <h1
              id="birthdays-hero"
              className="mt-4 font-display text-[2.75rem] font-black leading-[1.02] tracking-tight text-grape-800 sm:text-6xl lg:text-[4.25rem] xl:text-[5.25rem]"
            >
              Праздник
              <br />в Boom Bala
            </h1>
            <p className="mt-6 max-w-[34ch] text-lg leading-relaxed text-muted md:text-xl">
              Три пакета на выбор. В будние дни действует скидка 30%.
            </p>
            <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap lg:flex-col lg:items-start xl:flex-row">
              <ButtonLink href={contact.href} variant="primary" className="w-full sm:w-auto">
                Узнать о свободной дате
              </ButtonLink>
              <ButtonLink href="#compare" variant="outline" className="w-full sm:w-auto">
                Сравнить пакеты
              </ButtonLink>
            </div>
          </div>
        </Container>

        <div className="relative z-0 mt-16 h-[19rem] sm:h-[24rem] lg:absolute lg:inset-y-0 lg:right-0 lg:mt-0 lg:h-auto lg:w-[46%] xl:w-[48%]">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-grape-700 lg:[clip-path:polygon(20%_0,100%_0,100%_100%,0_100%)]"
          />
          <Image
            src="/boom/present.webp"
            alt=""
            width={1086}
            height={1448}
            priority
            sizes="(min-width: 1024px) 480px, 70vw"
            className="absolute bottom-0 right-2 z-10 h-[23rem] w-auto animate-boom-in drop-shadow-[0_20px_24px_rgba(20,6,50,0.4)] sm:right-[10%] sm:h-[28rem] lg:right-[6%] lg:h-[min(36rem,calc(100%-3rem))]"
          />
        </div>
      </section>

      <section id="compare" aria-labelledby="compare-title" className="bg-grape-800 pb-20 pt-16 text-white md:pt-24 lg:pb-72">
        <Container>
          <Reveal>
            <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">
              <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
              Сравнение
            </p>
            <h2
              id="compare-title"
              className="mb-8 font-display text-[2.25rem] font-black leading-[1.02] tracking-tighter sm:text-5xl lg:text-6xl"
            >
              Три пакета — в одной таблице
            </h2>
            <ComparisonMatrix packages={packages} />
            <p className="mt-4 text-sm text-grape-200">
              Прочерк — позиция не входит в пакет. Цены в тенге. Скидка −30% действует в будние дни.
            </p>
          </Reveal>
        </Container>
      </section>

      {boom ? <FlagshipDetail pkg={boom} contactHref={contact.href} /> : null}

      {others.map((pkg) => (
        <PackageEditorial key={pkg.id} pkg={pkg} contactHref={contact.href} />
      ))}
    </>
  );
}
