import Link from "next/link";
import type { BirthdayPackage } from "@/types";
import { formatTenge } from "@/lib/format";
import { LeadButton } from "@/components/lead/LeadButton";
import { Container } from "@/components/ui/Container";

/** Mobile-only: scan all three packages first; full inclusions and the comparison table follow below. */
export function PackageQuickList({ packages }: { packages: BirthdayPackage[] }) {
  const ordered = [...packages].sort((a, b) => (a.id === "boom-party" ? -1 : b.id === "boom-party" ? 1 : 0));
  return (
    <section aria-labelledby="quick-title" className="pb-24 pt-2 lg:hidden">
      <Container>
        <h2 id="quick-title" className="font-display text-2xl font-black tracking-tight text-grape-800">
          Выберите пакет
        </h2>
        <ul className="mt-4 grid gap-3">
          {ordered.map((pkg) => {
            const flagship = pkg.id === "boom-party";
            const items = pkg.program.filter((i) => i.key !== "animators").length;
            return (
              <li
                key={pkg.id}
                className={`rounded-3xl p-5 ${flagship ? "bg-sun-400 text-grape-900" : "border-2 border-grape-800 bg-white text-grape-900"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-display text-2xl font-black tracking-tight text-grape-800">{pkg.name}</h3>
                  {pkg.highlight ? (
                    <span className="shrink-0 rounded-full bg-grape-800 px-3 py-1 font-display text-[0.6875rem] font-extrabold uppercase tracking-[0.08em] text-sun-400">
                      {pkg.highlight}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-display text-3xl font-black tabular-nums text-grape-800">{formatTenge(pkg.price)}</span>
                  <span className="font-display text-base font-extrabold tabular-nums text-grape-700">
                    в будни {formatTenge(pkg.weekdayPrice)}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold">
                  Именинник + {pkg.freeChildren} детей бесплатно · {items} позиций программы
                </p>
                <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-3">
                  <LeadButton variant={flagship ? "primary" : "accent"} package={pkg.id} source={`quick-${pkg.id}`} className="w-full !px-4">
                    Узнать о дате
                  </LeadButton>
                  <Link
                    href={`#${pkg.id}`}
                    className="flex h-14 items-center px-2 font-display text-base font-extrabold text-grape-800 underline decoration-2 underline-offset-4"
                  >
                    Состав
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}
