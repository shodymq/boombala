import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { Container } from "@/components/ui/Container";

/** Contextual pointer from the birthdays page to the cafe menu. Informational, not an order flow. */
export function MenuLink() {
  return (
    <section aria-labelledby="birthday-menu-title" className="py-10 md:py-14">
      <Container>
        <div className="flex flex-col gap-3 border-y-[3px] border-grape-800 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="birthday-menu-title" className="font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl">
              Меню кафе Boom Bala
            </h2>
            <p className="mt-1 text-base text-muted">Детское меню, пицца, напитки и банкетные блюда.</p>
          </div>
          <Link
            href="/menu"
            className="group inline-flex h-12 shrink-0 items-center gap-2 font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
          >
            Смотреть меню
            <ArrowRight size={18} weight="bold" aria-hidden="true" className="transition-transform duration-200 group-hover:translate-x-1" />
          </Link>
        </div>
      </Container>
    </section>
  );
}
