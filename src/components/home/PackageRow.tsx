import Link from "next/link";
import { Check } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { TrackView } from "@/components/analytics/TrackView";

/** Secondary packages: typographic rows on the dark section, no card chrome. */
export function PackageRow({ pkg }: { pkg: BirthdayPackage }) {
  return (
    <article aria-labelledby={`${pkg.id}-title`} className="relative py-7 md:py-11">
      <TrackView event="ViewPackage" params={{ package: pkg.id }} />
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 id={`${pkg.id}-title`} className="font-display text-4xl font-black tracking-tight text-white md:text-5xl">
          {pkg.name}
        </h3>
        <p className="text-base text-grape-200">{pkg.tagline}</p>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-[auto_1fr] sm:gap-10">
        <div>
          <p className="font-display text-4xl font-black tabular-nums text-white md:text-5xl">{formatTenge(pkg.price)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="rounded-full bg-lava-500 px-3 py-1 font-display text-sm font-extrabold text-ink">
              в будни −{pkg.weekdayDiscountPercent}%
            </span>
            <span className="font-display text-2xl font-black tabular-nums text-sun-400 md:text-3xl">
              {formatTenge(pkg.weekdayPrice)}
            </span>
          </div>
        </div>

        <div>
          <p className="text-base font-semibold text-white">Бесплатный вход: именинник + {pkg.freeChildren} детей</p>
          <p className="mt-1 text-base text-grape-200">−{pkg.extraGuestDiscountPercent}% на вход дополнительным гостям</p>
          <ul className="mt-4 grid gap-2" aria-label={`Что входит в ${pkg.name}`}>
            {pkg.program.map((item) => (
              <li key={item.key} className="flex items-start gap-3 text-base leading-snug text-grape-100">
                <Check size={18} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-sun-400" />
                {item.title}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
        <LeadButton variant="accent" package={pkg.id} source={`package-${pkg.id}`} className="w-full sm:w-auto">
          Узнать о свободной дате
        </LeadButton>
        <Link
          href={`/birthdays#${pkg.id}`}
          className="inline-flex h-12 items-center justify-center px-4 font-display text-base font-extrabold text-white underline decoration-sun-400 decoration-2 underline-offset-4"
        >
          Что входит
        </Link>
      </div>
    </article>
  );
}
