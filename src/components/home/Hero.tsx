import Image from "next/image";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Burst, Wave } from "@/components/ui/Decor";
import { Container } from "@/components/ui/Container";
import { OpeningStatus } from "./OpeningStatus";
import { OpeningText } from "./OpeningText";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate flex flex-col overflow-hidden lg:min-h-[max(40rem,calc(100dvh-72px))] lg:max-h-[58rem]"
    >
      <Container className="relative z-10 flex-1 lg:grid lg:grid-cols-12">
        <div className="pb-4 pt-5 md:pt-12 lg:col-span-7 lg:self-center lg:py-20">
          <OpeningStatus />

          <p className="mt-6 flex items-center gap-3 font-display text-sm lg:max-w-[24rem] xl:max-w-none font-extrabold uppercase tracking-[0.14em] text-grape-600 md:text-base">
            <Burst className="h-7 w-8 text-sun-400" />
            Детский развлекательный центр · Алматы
          </p>

          <h1
            id="hero-title"
            className="mt-3 font-display text-[2.6rem] font-black leading-[1.02] sm:mt-4 tracking-tight text-grape-800 sm:text-6xl lg:text-[4.25rem] xl:text-[5.25rem]"
          >
            Место, где начинается{" "}
            <span className="relative inline-block text-grape-600">
              BOOM.
              <svg
                aria-hidden="true"
                viewBox="0 0 200 14"
                preserveAspectRatio="none"
                className="absolute -bottom-1 left-0 h-3 w-full text-sun-400 sm:-bottom-2 sm:h-4"
              >
                <path d="M3 9 C 40 2, 70 12, 100 7 S 165 3, 197 8" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
              </svg>
            </span>
          </h1>

          <p className="mt-4 max-w-[40ch] text-base leading-relaxed text-muted sm:mt-6 sm:text-lg md:text-xl lg:max-w-[30ch] xl:max-w-[40ch]">
            <OpeningText
              before="Boom Bala открывается 7 октября. Узнайте цены и выберите праздник для именинника."
              after="Boom Bala уже открыт. Узнайте цены и выберите праздник для именинника."
            />
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:gap-4 sm:flex-row sm:flex-wrap lg:flex-col lg:items-start xl:flex-row">
            <ButtonLink href="/#prices" variant="primary" className="w-full sm:w-auto">
              Посмотреть цены
            </ButtonLink>
            <ButtonLink href="/birthdays" variant="outline" className="w-full sm:w-auto">
              Отпраздновать день рождения
            </ButtonLink>
          </div>
        </div>
      </Container>

      {/* Stage: purple slab with tone-on-tone BOOM; Boom crosses its diagonal edge */}
      <div className="relative z-0 mt-14 h-[19rem] sm:mt-20 sm:h-[31rem] lg:absolute lg:inset-y-0 lg:right-0 lg:mt-0 lg:h-auto lg:w-[46%] xl:w-[51%]">
        <div
          aria-hidden="true"
          className="absolute inset-0 overflow-hidden bg-grape-700 lg:[clip-path:polygon(20%_0,100%_0,100%_100%,0_100%)]"
        >
          <span
            className="absolute -left-2 top-2 -rotate-6 select-none font-display text-[7.5rem] font-black leading-none tracking-tighter text-grape-800 sm:left-6 sm:text-[12rem] lg:left-auto lg:right-[3%] lg:top-[7%] lg:text-[clamp(11rem,16.5vw,19rem)]"
          >
            BOOM
          </span>
        </div>

        <Image
          src="/boom/wave.webp"
          alt="Талисман Boom машет рукой"
          width={1086}
          height={1448}
          priority
          sizes="(min-width: 1024px) 560px, 78vw"
          className="absolute bottom-1 right-0 z-10 h-[23rem] w-auto animate-boom-in drop-shadow-[0_22px_26px_rgba(20,6,50,0.4)] sm:right-[8%] sm:h-[34rem] lg:bottom-3 lg:right-[5%] lg:h-[clamp(29rem,calc(100dvh-6rem),47rem)]"
        />
      </div>

      {/* Ground: yellow wave passes in front of Boom's feet and hands over to the next section */}
      <Wave className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-9 text-sun-400 sm:h-12 lg:h-16" />
    </section>
  );
}
