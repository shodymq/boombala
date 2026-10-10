import type { Metadata } from "next";
import Link from "next/link";
import { getAttractions } from "@/services/attractions";
import { Container } from "@/components/ui/Container";
import { AttractionSection } from "@/components/attractions/AttractionSection";

const description =
  "Развлечения Boom Bala в Алматы: горки SKYLINE и ALATAU, сетчатая конструкция AMAZONIA, игровая зона RADUGA и FOOTBALL ZONE. Настоящие фото и ограничения по возрасту, росту и весу.";

export const metadata: Metadata = {
  title: "Развлечения",
  description,
  alternates: { canonical: "/attractions" },
  openGraph: {
    title: "Развлечения — Boom Bala",
    description,
    url: "/attractions",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Развлечения — Boom Bala",
    description,
    images: ["/opengraph-image"],
  },
};

export default async function AttractionsPage() {
  const items = await getAttractions();

  return (
    <>
      <header className="pb-6 pt-8 md:pb-10 md:pt-14">
        <Container>
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Развлечения
          </p>
          <h1 className="font-display text-[2.5rem] font-black leading-[1.02] tracking-tight text-grape-800 sm:text-6xl lg:text-7xl">
            Развлечения Boom Bala
          </h1>
          <p className="mt-3 max-w-[48ch] text-lg leading-relaxed text-muted md:mt-4 md:text-xl">
            Посмотрите игровые зоны и горки. У каждого аттракциона свои ограничения по возрасту, росту и весу.
          </p>
          {items.length > 1 ? (
            <nav aria-label="Аттракционы" className="mt-5">
              <ul className="flex flex-wrap gap-2">
                {items.map((a) => (
                  <li key={a.id}>
                    <a
                      href={`#${a.slug}`}
                      className="flex h-11 items-center rounded-full bg-grape-100 px-4 font-display text-[0.9375rem] font-extrabold text-grape-800 transition-colors hover:bg-grape-200"
                    >
                      {a.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </Container>
      </header>

      <Container>
        {items.map((a, i) => (
          <AttractionSection key={a.id} attraction={a} index={i} />
        ))}
      </Container>

      <section aria-label="Примечание" className="pb-16 pt-6 md:pb-24">
        <Container>
          <div className="border-t border-line pt-6">
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted">
              Ограничения указаны по табличкам у аттракционов. Перед посещением уточняйте детали у оператора.
            </p>
            <Link
              href="/#prices"
              className="mt-3 inline-flex h-11 items-center font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
            >
              Цены на вход
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}
