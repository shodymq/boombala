import Image from "next/image";
import type { Attraction } from "@/types";
import { openingDateLabel } from "@/lib/opening";
import { siteConfig } from "@/services/config";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { Star } from "@/components/ui/Decor";

function Marquee() {
  const items = ["Boom Bala", siteConfig.city, `Открытие — ${openingDateLabel()}`, "Boom Bala", "Детский развлекательный центр"];
  return (
    <div
      aria-hidden="true"
      className="absolute -inset-x-[6%] bottom-0 z-20 translate-y-1/2 -rotate-2 overflow-hidden bg-grape-800 py-3.5 md:py-4"
    >
      <div className="flex w-max animate-marquee">
        {[0, 1].map((copy) => (
          <ul key={copy} className="flex shrink-0 items-center">
            {[...items, ...items].map((label, i) => (
              <li
                key={`${copy}-${i}`}
                className="flex items-center gap-6 pr-6 font-display text-xl font-black uppercase tracking-tight text-sun-400 md:gap-8 md:pr-8 md:text-3xl"
              >
                {label}
                <Star className="h-5 w-5 shrink-0 text-white md:h-6 md:w-6" />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

/** Used once real, named attractions with photography exist. */
function Gallery({ items }: { items: Attraction[] }) {
  return (
    <section id="entertainment" aria-labelledby="entertainment-title" className="py-20 md:py-28">
      <Container>
        <h2
          id="entertainment-title"
          className="font-display text-4xl font-black leading-[1.02] tracking-tight text-grape-800 sm:text-6xl"
        >
          Здесь сложно заскучать.
        </h2>
        <div className="mt-10 grid gap-3 md:grid-cols-6 md:gap-5">
          {items.map((a, i) => (
            <figure
              key={a.id}
              className={`relative min-h-[16rem] overflow-hidden bg-grape-900 md:min-h-[22rem] ${i % 3 === 0 ? "md:col-span-4" : "md:col-span-2"} ${i % 2 === 0 ? "rounded-tl-[3rem] rounded-br-[3rem]" : "rounded-tr-[3rem] rounded-bl-[3rem]"}`}
            >
              <Image
                src={a.image!}
                alt={a.imageAlt ?? a.name ?? "Игровая зона Boom Bala"}
                fill
                sizes="(min-width: 768px) 60vw, 100vw"
                className="object-cover"
              />
              {a.name ? (
                <figcaption className="absolute inset-x-0 bottom-0 bg-grape-900 p-5 text-white">
                  <span className="font-display text-2xl font-black">{a.name}</span>
                  {a.description ? <span className="mt-1 block text-sm text-grape-100">{a.description}</span> : null}
                </figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      </Container>
    </section>
  );
}

function Teaser() {
  return (
    <section
      id="entertainment"
      aria-labelledby="entertainment-title"
      className="relative overflow-x-clip bg-sun-400 pb-60 pt-6 sm:pb-52 lg:pb-56 lg:pt-10"
    >
      <Container className="relative">
        <Reveal>
          <p className="mb-4 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-800">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-grape-800" />
            Развлечения
          </p>
          <h2
            id="entertainment-title"
            className="max-w-[10ch] font-display text-[3.25rem] font-black leading-[0.94] tracking-tighter text-grape-800 sm:text-7xl lg:max-w-[9ch] lg:text-[7.5rem]"
          >
            Здесь сложно{" "}
            <span className="relative inline-block">
              заскучать.
              <svg
                aria-hidden="true"
                viewBox="0 0 300 16"
                preserveAspectRatio="none"
                className="absolute -bottom-1 left-0 h-3 w-full text-white lg:h-4"
              >
                <path d="M4 10 C 40 2, 70 14, 110 8 S 190 2, 230 9 S 280 12, 296 6" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
              </svg>
            </span>
          </h2>
          <p className="mt-8 max-w-[34ch] text-lg leading-relaxed text-grape-900 md:text-xl">
            Игровые зоны Boom Bala скоро появятся на сайте. Фотографии и названия добавим ближе к открытию.
          </p>
          <ButtonLink href={siteConfig.contacts.instagram} variant="primary" className="mt-8 w-full sm:w-auto">
            Следить за новостями
          </ButtonLink>
        </Reveal>
      </Container>

      <Image
        src="/boom/jump.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 480px, (min-width: 640px) 320px, 200px"
        className="pointer-events-none absolute bottom-0 right-0 z-30 h-[15.5rem] w-auto translate-y-[4.5rem] drop-shadow-[0_18px_22px_rgba(41,13,92,0.28)] sm:right-[8%] sm:h-[24rem] lg:right-[9%] lg:h-[40rem] lg:translate-y-[10rem]"
      />

      <Marquee />
    </section>
  );
}

export function Entertainment({ attractions }: { attractions: Attraction[] }) {
  const real = attractions.filter((a) => a.image && a.name);
  return real.length > 0 ? <Gallery items={real} /> : <Teaser />;
}
