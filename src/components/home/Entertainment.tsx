import Image from "next/image";
import Link from "next/link";
import type { Attraction } from "@/types";
import { siteConfig } from "@/services/config";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { Star } from "@/components/ui/Decor";

function Marquee() {
  const items = ["Boom Bala", siteConfig.city, siteConfig.location.mall, "Boom Bala", "Детский развлекательный центр"];
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

function Tile({
  item,
  className = "",
  sizes,
  priority = false,
  large = false,
}: {
  item: Attraction;
  className?: string;
  sizes: string;
  priority?: boolean;
  large?: boolean;
}) {
  const photo = item.images[0];
  return (
    <Link
      href={`/attractions#${item.slug}`}
      className={`group relative block overflow-hidden bg-grape-900 ${className}`}
    >
      <Image
        src={photo.src}
        alt={photo.alt}
        fill
        priority={priority}
        sizes={sizes}
        className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
      />
      <span
        className={`absolute bottom-0 left-0 bg-grape-800 font-display font-black tracking-tight text-sun-400 ${
          large ? "px-4 py-2.5 text-xl sm:px-6 sm:py-3 sm:text-3xl" : "px-3 py-1.5 text-base sm:px-4 sm:py-2 sm:text-xl"
        }`}
      >
        {item.name}
      </span>
    </Link>
  );
}

function Showcase({ items }: { items: Attraction[] }) {
  const lead = items[0];
  // The tall slot takes the first attraction whose main photo is portrait; the rest fill the bottom row.
  const tall = items.slice(1).find((a) => a.images[0].height > a.images[0].width);
  const rest = items.slice(1).filter((a) => a !== tall);
  return (
    <section
      id="entertainment"
      aria-labelledby="entertainment-title"
      className="relative overflow-x-clip bg-sun-400 pb-52 pt-6 sm:pb-80 lg:pb-44 lg:pt-10"
    >
      <Container className="relative">
        <Reveal>
          <p className="mb-4 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-800">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-grape-800" />
            Развлечения
          </p>
          <h2
            id="entertainment-title"
            className="max-w-[10ch] font-display text-[3.25rem] font-black leading-[0.94] tracking-tighter text-grape-800 sm:text-7xl lg:max-w-none lg:text-[6.5rem] xl:text-[7.5rem]"
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
        </Reveal>

        <div className="mt-6 grid gap-8 lg:mt-10 lg:grid-cols-12 lg:items-start lg:gap-10">
          <Reveal className="lg:col-span-5">
            <p className="max-w-[34ch] text-lg leading-relaxed text-grape-900 md:text-xl">
              Горки, бассейн с шариками и футбольная площадка. Настоящие фото и ограничения по возрасту.
            </p>
            <ButtonLink href="/attractions" variant="primary" className="mt-7 w-full sm:w-auto">
              Все развлечения
            </ButtonLink>
          </Reveal>

          {/* One mosaic: SKYLINE wide, AMAZONIA tall, ALATAU + RADUGA below. Flush tiles, no overlaps. */}
          <Reveal className="lg:col-span-7" delay={0.06}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-10 lg:gap-4">
              {lead ? (
                <Tile
                  item={lead}
                  large
                  sizes="(min-width: 1280px) 410px, (min-width: 1024px) 36vw, 100vw"
                  className="col-span-2 rounded-tl-[2rem] rounded-br-[2rem] [aspect-ratio:16/9] lg:col-span-6 lg:rounded-tl-[3rem] lg:rounded-br-[3rem] lg:[aspect-ratio:16/10]"
                />
              ) : null}
              {tall ? (
                <Tile
                  item={tall}
                  sizes="(min-width: 1280px) 270px, (min-width: 1024px) 24vw, 50vw"
                  className="row-span-2 min-h-[16rem] rounded-tr-[1.5rem] rounded-bl-[1.5rem] lg:col-span-4 lg:min-h-0 lg:rounded-tr-[2.5rem] lg:rounded-bl-[2.5rem]"
                />
              ) : null}
              {rest.map((item) => (
                <Tile
                  key={item.id}
                  item={item}
                  sizes="(min-width: 1280px) 200px, (min-width: 1024px) 18vw, 50vw"
                  className="rounded-tr-[1.5rem] rounded-bl-[1.5rem] [aspect-ratio:4/3] lg:col-span-3"
                />
              ))}
            </div>
          </Reveal>
        </div>
      </Container>

      <Image
        src="/boom/jump.webp"
        alt=""
        width={1086}
        height={1448}
        sizes="(min-width: 1024px) 480px, (min-width: 640px) 320px, 200px"
        className="pointer-events-none absolute bottom-0 right-0 z-30 h-[15.5rem] w-auto translate-y-[4.5rem] drop-shadow-[0_18px_22px_rgba(41,13,92,0.28)] sm:right-[8%] sm:h-[24rem] lg:right-auto lg:left-[7%] lg:h-[30rem] lg:translate-y-[10rem]"
      />

      <Marquee />
    </section>
  );
}

export function Entertainment({ attractions }: { attractions: Attraction[] }) {
  const featured = attractions.filter((a) => a.featured && a.images.length > 0);
  return featured.length > 0 ? <Showcase items={featured.slice(0, 4)} /> : null;
}
