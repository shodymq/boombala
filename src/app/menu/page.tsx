import type { Metadata } from "next";
import Link from "next/link";
import { getMenu } from "@/services/menu";
import { buildMenuView } from "@/lib/menu";
import { siteConfig } from "@/services/config";
import { getSiteUrl } from "@/lib/site-url";
import { Container } from "@/components/ui/Container";
import { TrackView } from "@/components/analytics/TrackView";
import { MenuNav } from "@/components/menu/MenuNav";
import { MenuRow } from "@/components/menu/MenuRow";

const title = "Меню кафе";
const description =
  "Меню кафе Boom Bala в Алматы: детское меню, основные блюда, пицца и фастфуд, салаты и супы, напитки и банкетные блюда с ценами.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/menu" },
  openGraph: {
    title: "Меню кафе — Boom Bala",
    description,
    url: "/menu",
    locale: "ru_RU",
    type: "website",
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Меню кафе — Boom Bala",
    description,
    images: ["/opengraph-image"],
  },
};

export default async function MenuPage() {
  const catalog = await getMenu();
  const view = buildMenuView(catalog);
  const site = getSiteUrl();

  // Structured data mirrors exactly what is visible on the page.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Menu",
    name: "Меню кафе Boom Bala",
    url: `${site}/menu`,
    inLanguage: "ru",
    provider: { "@id": `${site}/#business` },
    hasMenuSection: view.map(({ group, blocks }) => ({
      "@type": "MenuSection",
      name: group.name,
      hasMenuItem: blocks.flatMap((b) => b.items).map((i) => ({
        "@type": "MenuItem",
        name: i.name,
        offers: { "@type": "Offer", price: i.price, priceCurrency: "KZT" },
      })),
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />

      <header className="relative pb-5 pt-8 md:pb-8 md:pt-14">
        <TrackView event="ViewMenu" />
        <Container>
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Меню
          </p>
          <h1 className="font-display text-[2.5rem] font-black leading-[1.02] tracking-tight text-grape-800 sm:text-6xl lg:text-7xl">
            Кафе Boom Bala
          </h1>
          <p className="mt-3 max-w-[40ch] text-lg leading-relaxed text-muted md:mt-4 md:text-xl">
            Еда и напитки для маленьких и больших гостей.
          </p>
          <p className="mt-2 text-sm text-muted">Цены указаны в тенге.</p>
        </Container>
      </header>

      <MenuNav groups={view.map(({ group }) => ({ id: group.id, name: group.name }))} />

      {view.map(({ group, blocks, count }) => {
        const multi = blocks.length > 1;
        return (
          <section
            key={group.id}
            id={group.id}
            aria-labelledby={`${group.id}-title`}
            className={`scroll-mt-14 py-9 md:scroll-mt-16 md:py-14 ${group.id === "kids" ? "bg-sun-100" : ""}`}
          >
            <Container>
              <div className="flex items-baseline justify-between gap-4 border-b-[3px] border-grape-800 pb-3">
                <h2
                  id={`${group.id}-title`}
                  className="font-display text-[1.75rem] font-black leading-none tracking-tight text-grape-800 md:text-4xl"
                >
                  {group.name}
                </h2>
                <span className="shrink-0 text-sm font-semibold text-muted">{count}</span>
              </div>

              <div className={multi ? "mt-2 grid items-start gap-x-14 gap-y-2 md:mt-4 md:grid-cols-2" : "mt-2 md:mt-4"}>
                {blocks.map((block) => (
                  <div key={block.id} className={multi ? "pt-5" : ""}>
                    {block.title ? (
                      <h3 className="mb-1 font-display text-sm font-extrabold uppercase tracking-[0.12em] text-grape-600">
                        {block.title}
                      </h3>
                    ) : null}
                    <ul className={!multi && block.items.length > 6 ? "md:columns-2 md:gap-x-14" : ""}>
                      {block.items.map((item) => (
                        <MenuRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Container>
          </section>
        );
      })}

      <section aria-label="Другие разделы" className="border-t border-line py-8 md:py-10">
        <Container className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-base text-muted">
            Кафе находится в {siteConfig.location.mall}, {siteConfig.location.floor}.
          </p>
          <Link
            href="/birthdays"
            className="inline-flex h-11 items-center font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
          >
            Дни рождения в Boom Bala
          </Link>
        </Container>
      </section>
    </>
  );
}
