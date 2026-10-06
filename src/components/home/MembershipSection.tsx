import Image from "next/image";
import type { Membership } from "@/types";
import { formatNumber } from "@/lib/format";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

export function MembershipSection({ membership, contactHref }: { membership: Membership; contactHref: string }) {
  return (
    <section
      id="membership"
      aria-labelledby="membership-title"
      className="relative isolate flex flex-col overflow-hidden pt-20 md:pt-28 lg:min-h-[44rem] lg:pt-0"
    >
      <Container className="relative z-10 lg:grid lg:flex-1 lg:grid-cols-12">
        <Reveal className="pb-6 lg:col-span-8 lg:self-center lg:py-24">
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Абонемент
          </p>
          <h2
            id="membership-title"
            className="font-display text-[2rem] font-black leading-none tracking-tight text-grape-800 sm:text-5xl lg:text-6xl"
          >
            {membership.name}
          </h2>
          <p
            className="mt-2 whitespace-nowrap font-display text-[5.25rem] font-black leading-[0.9] tracking-tighter text-grape-700 sm:text-[8.5rem] lg:text-[10.5rem] xl:text-[12.5rem]"
          >
            <span className="sr-only">{formatNumber(membership.price)} тенге</span>
            <span aria-hidden="true">{formatNumber(membership.price)}</span>
            <span aria-hidden="true" className="ml-1 text-[0.55em] text-sun-500 sm:ml-3">
              ₸
            </span>
          </p>
          <p className="mt-6 max-w-[36ch] text-lg leading-relaxed text-muted">
            Подробности об абонементе — в нашем Instagram.
          </p>
          <ButtonLink href={contactHref} variant="primary" className="mt-8 w-full sm:w-auto">
            Узнать об абонементе
          </ButtonLink>
        </Reveal>
      </Container>

      {/* Yellow slab with Boom, cropped by the section edge */}
      <div className="relative z-0 mt-2 h-[24rem] sm:h-[28rem] lg:absolute lg:inset-y-0 lg:right-0 lg:mt-0 lg:h-auto lg:w-[44%]">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-sun-400 [clip-path:polygon(0_16%,100%_0,100%_100%,0_100%)] lg:[clip-path:polygon(24%_0,100%_0,100%_100%,0_100%)]"
        />
        <Image
          src="/boom/thumbs.webp"
          alt=""
          width={1086}
          height={1448}
          sizes="(min-width: 1024px) 520px, 80vw"
          className="absolute -bottom-12 left-1/2 h-[30rem] w-auto -translate-x-1/2 drop-shadow-[0_18px_22px_rgba(41,13,92,0.3)] sm:h-[34rem] lg:-bottom-20 lg:left-auto lg:right-[6%] lg:h-[46rem] lg:translate-x-0"
        />
      </div>
    </section>
  );
}
