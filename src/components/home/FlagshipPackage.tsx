import Image from "next/image";
import Link from "next/link";
import { Check } from "@phosphor-icons/react/dist/ssr";
import type { BirthdayPackage } from "@/types";
import { formatTenge, pluralize } from "@/lib/format";
import { ButtonLink } from "@/components/ui/ButtonLink";

function optionsNote(item: BirthdayPackage["program"][number]): string | null {
  if (!item.options?.length) return null;
  const n = item.options.length;
  return item.key === "characters"
    ? `${n} ${pluralize(n, ["кукла", "куклы", "кукол"])}`
    : `${n} ${pluralize(n, ["вариант", "варианта", "вариантов"])}`;
}

/** The complete package: yellow, tall, with Boom bursting out of the top edge. */
export function FlagshipPackage({ pkg, contactHref }: { pkg: BirthdayPackage; contactHref: string }) {
  return (
    <article
      aria-labelledby={`${pkg.id}-title`}
      className="relative rounded-bl-[1.25rem] rounded-br-[4.5rem] rounded-tl-[4.5rem] rounded-tr-[1.25rem] bg-sun-400 px-6 pb-10 pt-12 text-grape-900 md:px-10 md:pb-12 lg:-mr-6 xl:-mr-14 xl:pl-14 xl:pr-16"
    >
      <Image
        src="/boom/wave.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 300px, 190px"
        className="pointer-events-none absolute -top-24 right-3 h-52 w-auto drop-shadow-[0_14px_16px_rgba(20,6,50,0.35)] md:-top-32 md:right-8 md:h-72"
      />

      <p className="inline-block rounded-full bg-grape-800 px-4 py-1.5 font-display text-xs font-extrabold uppercase tracking-[0.12em] text-sun-400">
        {pkg.highlight}
      </p>
      <h3
        id={`${pkg.id}-title`}
        className="mt-4 font-display text-6xl font-black leading-[0.9] tracking-tighter text-grape-800 md:text-7xl xl:text-[5.5rem]"
      >
        BOOM
        <br />
        PARTY
      </h3>
      <p className="mt-3 text-lg font-semibold text-grape-900">{pkg.tagline}</p>

      <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-3 border-t-2 border-grape-800/20 pt-6">
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

      <dl className="mt-6 grid grid-cols-3 divide-x-2 divide-grape-800/20 border-y-2 border-grape-800/20 text-center">
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

      <ul className="mt-6 grid gap-x-8 gap-y-3 sm:grid-cols-2" aria-label={`Что входит в ${pkg.name}`}>
        {pkg.program
          .filter((i) => i.key !== "animators")
          .map((item) => {
            const note = optionsNote(item);
            return (
              <li key={item.key} className="flex items-start gap-3 text-base leading-snug">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-grape-800 text-sun-400"
                >
                  <Check size={12} weight="bold" />
                </span>
                <span>
                  <span className="font-bold">{item.title}</span>
                  {note ? <span className="block text-sm text-grape-800">{note}</span> : null}
                </span>
              </li>
            );
          })}
      </ul>

      <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
        <ButtonLink href={contactHref} variant="primary" className="w-full sm:w-auto">
          Узнать о свободной дате
        </ButtonLink>
        <Link
          href={`/birthdays#${pkg.id}`}
          className="inline-flex h-12 items-center justify-center px-4 font-display text-base font-extrabold text-grape-800 underline decoration-grape-800 decoration-2 underline-offset-4"
        >
          Весь состав
        </Link>
      </div>
    </article>
  );
}
