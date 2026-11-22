import Image from "next/image";
import Link from "next/link";
import type { BirthdayPackage, Locale } from "@/types/birthdays-v4";
import { getBirthdayPackages } from "@/services/birthdays";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";
import { MobilePackageSelector } from "@/components/birthdays/MobilePackageSelector";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { Burst } from "@/components/ui/Decor";
import { ComparisonMatrix } from "@/components/birthdays/ComparisonMatrix";
import { FlagshipDetail } from "@/components/birthdays/FlagshipDetail";
import { PackageDetail } from "@/components/birthdays/PackageDetail";
import { MenuLink } from "@/components/birthdays/MenuLink";
import { WhatsAppCta } from "@/components/birthdays/WhatsAppCta";
import { RoomsSection } from "@/components/birthdays/RoomsSection";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";

/**
 * The birthday page in one locale. /birthdays renders it in Russian, /kk/birthdays in Kazakh; every visible string comes from
 * BIRTHDAYS_UI and the package copy, so no Russian text leaks into the Kazakh page (the site header and footer stay as they are).
 */
export async function BirthdaysPage({ locale }: { locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const packages = await getBirthdayPackages();
  const byId = Object.fromEntries(packages.map((p) => [p.id, p])) as Record<BirthdayPackage["id"], BirthdayPackage>;
  const flagship = byId["boom-bala-party"];
  const detailed = packages.filter((p) => p.id !== "boom-bala-party");
  const otherLocale = locale === "kk" ? "/birthdays" : "/kk/birthdays";

  return (
    <div lang={locale} className="flex flex-col">
      <TrackView event="ViewBirthdays" />
      <section aria-labelledby="birthdays-hero" className="relative isolate flex flex-col overflow-hidden">
        <Container className="relative z-10 lg:grid lg:grid-cols-12">
          <div className="pb-4 pt-8 md:pt-12 lg:col-span-7 lg:py-24">
            <p className="flex items-center gap-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
              <Burst className="h-7 w-8 text-sun-400" />
              {ui.eyebrow}
            </p>
            <h1
              id="birthdays-hero"
              className="mt-4 font-display text-[2.75rem] font-black leading-[1.02] tracking-tight text-grape-800 sm:text-6xl lg:text-[4.25rem] xl:text-[5.25rem]"
            >
              {ui.heroTitle[0]}
              <br />
              {ui.heroTitle[1]}
            </h1>
            <p className="mt-6 max-w-[34ch] text-lg leading-relaxed text-muted md:text-xl">{ui.heroLead}</p>
            <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap lg:flex-col lg:items-start xl:flex-row">
              <LeadButton variant="primary" source="birthdays-hero" className="w-full sm:w-auto">
                {ui.heroCta}
              </LeadButton>
              <ButtonLink href="#compare" variant="outline" className="w-full sm:w-auto">
                {ui.heroCompare}
              </ButtonLink>
            </div>
            <p className="mt-6 text-sm">
              <Link href={otherLocale} hrefLang={locale === "kk" ? "ru" : "kk"} className="font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4">
                {ui.langSwitchText}
              </Link>
            </p>
          </div>
        </Container>

        <div className="relative z-0 mt-16 h-[19rem] sm:h-[24rem] lg:absolute lg:inset-y-0 lg:right-0 lg:mt-0 lg:h-auto lg:w-[46%] xl:w-[48%]">
          <div aria-hidden="true" className="absolute inset-0 bg-grape-700 lg:[clip-path:polygon(20%_0,100%_0,100%_100%,0_100%)]" />
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

      {/* < lg: a single package selector instead of the long per-package sections. */}
      <section aria-labelledby="packages-title" className="pb-12 pt-2 lg:hidden">
        <Container>
          <h2 id="packages-title" className="mb-2 font-display text-2xl font-black tracking-tight text-grape-800">
            {ui.packagesTitle}
          </h2>
          <p className="mb-5 text-base text-muted">{ui.packagesLead}</p>
          <MobilePackageSelector packages={packages} locale={locale} tone="light" />
        </Container>
      </section>

      <RoomsSection locale={locale} />

      <section id="compare" aria-labelledby="compare-title" className="scroll-mt-20 bg-grape-800 pb-16 pt-14 text-white md:pt-24">
        <Container>
          <Reveal>
            <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">
              <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
              {ui.compareEyebrow}
            </p>
            <h2 id="compare-title" className="mb-6 font-display text-[2.25rem] font-black leading-[1.02] tracking-tighter sm:text-5xl lg:text-6xl">
              {ui.compareTitle}
            </h2>
            <div className="mb-8 max-w-[60rem] rounded-3xl bg-white/10 p-5">
              <p className="font-display text-sm font-extrabold uppercase tracking-[0.12em] text-sun-400">{ui.compareSharedTitle}</p>
              <ul className="mt-3 grid gap-2 text-base md:grid-cols-3">
                {ui.sharedItems.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true" className="text-sun-400">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <ComparisonMatrix packages={packages} locale={locale} />
            <p className="mt-4 text-sm text-grape-200">{ui.compareLegend}</p>
          </Reveal>
        </Container>
      </section>

      {detailed.map((pkg) => (
        <PackageDetail key={pkg.id} pkg={pkg} locale={locale} />
      ))}
      {flagship ? <FlagshipDetail pkg={flagship} locale={locale} /> : null}

      <section aria-labelledby="how-title" className="py-12 md:py-20">
        <Container>
          <Reveal>
            <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">{ui.howEyebrow}</p>
            <h2 id="how-title" className="font-display text-[2rem] font-black leading-[1.03] tracking-tighter text-grape-800 sm:text-5xl">
              {ui.howTitle}
            </h2>
            <ol className="mt-8 grid gap-4 md:grid-cols-3">
              {ui.howSteps.map((step, i) => (
                <li key={step.title} className="rounded-3xl border border-line bg-white p-5">
                  <span className="font-display text-3xl font-black text-grape-600" aria-hidden="true">
                    {i + 1}
                  </span>
                  <p className="mt-2 font-display text-lg font-extrabold text-grape-800">{step.title}</p>
                  <p className="mt-1 text-base text-muted">{step.text}</p>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-muted">{ui.howNote}</p>
          </Reveal>
        </Container>
      </section>

      <section aria-labelledby="faq-title" className="pb-12 md:pb-20">
        <Container>
          <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">{ui.faqEyebrow}</p>
          <h2 id="faq-title" className="mb-6 font-display text-[2rem] font-black leading-[1.03] tracking-tighter text-grape-800 sm:text-4xl">
            {ui.faqTitle}
          </h2>
          <dl className="grid gap-4 md:grid-cols-2">
            {ui.faq.map((item) => (
              <div key={item.title} className="rounded-3xl bg-grape-50 p-5">
                <dt className="font-display text-lg font-extrabold text-grape-800">{item.title}</dt>
                <dd className="mt-2 text-base leading-relaxed text-grape-900">{item.text}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      <WhatsAppCta locale={locale} />

      <MenuLink locale={locale} />
    </div>
  );
}
