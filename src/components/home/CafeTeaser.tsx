import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import type { MenuCatalog } from "@/types";
import { buildMenuView } from "@/lib/menu";
import { formatTenge } from "@/lib/format";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

/** Which menu groups to tease on the home page (everything else is one tap away on /menu). */
const FEATURED = ["kids", "main", "pizza-fastfood", "drinks"];

export function CafeTeaser({ catalog }: { catalog: MenuCatalog }) {
  const rows = buildMenuView(catalog).filter((v) => FEATURED.includes(v.group.id));
  return (
    <section id="cafe" aria-labelledby="cafe-title" className="py-14 md:py-24">
      <Container className="grid gap-8 lg:grid-cols-12 lg:gap-16">
        <Reveal className="lg:col-span-5">
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Кафе
          </p>
          <h2
            id="cafe-title"
            className="font-display text-[2rem] font-black leading-[1.05] tracking-tight text-grape-800 sm:text-5xl"
          >
            Кафе Boom Bala
          </h2>
          <p className="mt-4 max-w-[34ch] text-base leading-relaxed text-muted md:text-lg">
            Еда и напитки для маленьких и больших гостей.
          </p>
          <ButtonLink href="/menu" variant="primary" className="mt-6 w-full sm:w-auto">
            Посмотреть меню
          </ButtonLink>
        </Reveal>

        <Reveal className="lg:col-span-7" delay={0.06}>
          <ul className="border-t-[3px] border-grape-800">
            {rows.map(({ group, minPrice }) => (
              <li key={group.id} className="border-b border-grape-200">
                <Link
                  href={`/menu#${group.id}`}
                  className="group flex min-h-16 items-center justify-between gap-4 py-3"
                >
                  <span className="font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl">
                    {group.name}
                  </span>
                  <span className="flex items-center gap-3 text-base text-muted">
                    <span className="tabular-nums">от {formatTenge(minPrice)}</span>
                    <ArrowRight
                      size={18}
                      weight="bold"
                      aria-hidden="true"
                      className="text-grape-700 transition-transform duration-200 group-hover:translate-x-1"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>
      </Container>
    </section>
  );
}
