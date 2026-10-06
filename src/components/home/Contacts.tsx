import Image from "next/image";
import { ArrowUpRight, InstagramLogo, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/services/config";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

export function Contacts() {
  const { instagram, instagramHandle, whatsapp } = siteConfig.contacts;
  return (
    <section
      id="contacts"
      aria-labelledby="contacts-title"
      className="relative overflow-hidden bg-grape-800 text-white"
    >

      <Container className="grid items-end lg:grid-cols-12">
        <Reveal className="pb-6 pt-20 lg:col-span-7 lg:pb-28 lg:pt-28">
          <p
            id="contacts-title"
            className="mb-4 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400"
          >
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Мы в Instagram
          </p>
          <a
            href={instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="group block break-words font-display text-[2.15rem] font-black leading-[0.98] tracking-tighter text-white sm:text-6xl xl:text-[4.5rem]"
          >
            <span className="bg-[linear-gradient(var(--color-sun-400),var(--color-sun-400))] bg-[length:0%_6px] bg-[position:0_100%] bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_6px]">
              {instagramHandle}
            </span>
            <ArrowUpRight
              size={36}
              weight="bold"
              aria-hidden="true"
              className="ml-1 inline-block align-top text-sun-400 transition-transform duration-200 group-hover:-translate-y-1 group-hover:translate-x-1 sm:size-12"
            />
          </a>
          <p className="mt-6 max-w-[40ch] text-lg leading-relaxed text-grape-100">
            {siteConfig.city}. Открытие — 7 октября. Новости и вопросы — в нашем Instagram.
          </p>
          <div className="mt-8 flex flex-col gap-4 sm:flex-row">
            <ButtonLink href={instagram} variant="accent" className="w-full sm:w-auto">
              <InstagramLogo size={22} weight="bold" aria-hidden="true" />
              Открыть Instagram
            </ButtonLink>
            {whatsapp ? (
              <ButtonLink href={`https://wa.me/${whatsapp}`} variant="outline" className="w-full sm:w-auto">
                <WhatsappLogo size={22} weight="bold" aria-hidden="true" />
                WhatsApp
              </ButtonLink>
            ) : null}
          </div>
        </Reveal>

        <div className="relative flex justify-center lg:col-span-5 lg:justify-end">
          <Image
            src="/boom/present.webp"
            alt=""
            width={1086}
            height={1448}
            sizes="(min-width: 1024px) 480px, 70vw"
            className="-mb-1 h-[22rem] w-auto drop-shadow-[0_18px_22px_rgba(20,6,50,0.35)] sm:h-[28rem] lg:-mr-4 lg:h-[36rem]"
          />
        </div>
      </Container>
    </section>
  );
}
