import Image from "next/image";
import { ArrowUpRight, InstagramLogo, MapPin, Phone, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/services/config";
import { whatsappUrl } from "@/lib/whatsapp";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { LeadButton } from "@/components/lead/LeadButton";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

export function Contacts() {
  const { instagram, instagramHandle, phone } = siteConfig.contacts;
  const whatsapp = whatsappUrl();
  const { city, street, mall, floor, mapUrl } = siteConfig.location;
  return (
    <section
      id="contacts"
      aria-labelledby="contacts-title"
      className="relative overflow-hidden bg-grape-800 text-white"
    >
      <Container className="grid items-end lg:grid-cols-12">
        {/* Mobile order: address -> booking/route -> Instagram. Desktop: Instagram handle leads, address below. */}
        <Reveal className="flex flex-col pb-6 pt-14 lg:col-span-7 lg:pb-28 lg:pt-28">
          <p
            id="contacts-title"
            className="order-1 mb-4 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400"
          >
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            <span className="lg:hidden">Контакты</span>
            <span className="max-lg:hidden">Мы в Instagram</span>
          </p>

          <address className="order-2 not-italic lg:order-4 lg:mt-8">
            <p className="flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400 max-lg:hidden">
              <MapPin size={18} weight="bold" aria-hidden="true" />
              Как нас найти
            </p>
            <p className="font-display text-[2rem] font-black leading-[1.05] tracking-tight text-white sm:text-5xl lg:mt-3 lg:text-3xl">
              {city}
              <br />
              {street}
            </p>
            <p className="mt-2 text-lg leading-snug text-grape-100">
              {mall}
              <br />
              {floor}
            </p>
          </address>

          <div className="order-3 mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:order-5 lg:mt-8 lg:gap-4">
            <LeadButton variant="accent" source="contacts" className="w-full sm:w-auto">
              Забронировать праздник
            </LeadButton>
            {mapUrl ? (
              <ButtonLink href={mapUrl} variant="outline" track="ClickRoute" className="w-full sm:w-auto">
                <MapPin size={22} weight="bold" aria-hidden="true" />
                Построить маршрут
              </ButtonLink>
            ) : null}
            <ButtonLink href={instagram} variant="outline" className="w-full max-lg:hidden sm:w-auto">
              <InstagramLogo size={22} weight="bold" aria-hidden="true" />
              Открыть Instagram
            </ButtonLink>
            {whatsapp ? (
              <ButtonLink href={whatsapp} variant="outline" className="w-full sm:w-auto">
                <WhatsappLogo size={22} weight="bold" aria-hidden="true" />
                Написать в WhatsApp
              </ButtonLink>
            ) : null}
          </div>

          <p className="order-4 mt-5 lg:order-6 lg:mt-6">
            <span className="mb-1 block font-display text-xs font-extrabold uppercase tracking-[0.14em] text-sun-400">
              Звонки и WhatsApp
            </span>
            <a
              href={`tel:${phone.tel}`}
              className="inline-flex min-h-11 items-center gap-2 font-display text-2xl font-black tracking-tight text-white underline decoration-sun-400 decoration-2 underline-offset-4 sm:text-3xl"
            >
              <Phone size={26} weight="bold" aria-hidden="true" className="text-sun-400" />
              {phone.display}
            </a>
          </p>

          <a
            href={instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="group order-5 mt-10 block break-words font-display text-[1.6rem] font-black leading-[0.98] tracking-tighter text-white sm:text-4xl lg:order-2 lg:mt-0 lg:text-6xl xl:text-[4.5rem]"
          >
            <span className="mb-2 block font-display text-xs font-extrabold uppercase tracking-[0.14em] text-grape-200 lg:hidden">
              Мы в Instagram
            </span>
            <span className="bg-[linear-gradient(var(--color-sun-400),var(--color-sun-400))] bg-[length:0%_6px] bg-[position:0_100%] bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_6px]">
              {instagramHandle}
            </span>
            <ArrowUpRight
              size={28}
              weight="bold"
              aria-hidden="true"
              className="ml-1 inline-block align-top text-sun-400 transition-transform duration-200 group-hover:-translate-y-1 group-hover:translate-x-1 sm:size-9 lg:size-12"
            />
          </a>
          <p className="order-6 mt-4 max-w-[40ch] text-base leading-relaxed text-grape-100 lg:order-3 lg:mt-6 lg:text-lg">
            Новости и вопросы — в нашем Instagram.
          </p>
        </Reveal>

        <div className="relative flex justify-center lg:col-span-5 lg:justify-end">
          <Image
            src="/boom/present.webp"
            alt=""
            width={1086}
            height={1448}
            sizes="(min-width: 1024px) 480px, 70vw"
            className="-mb-1 h-[15rem] w-auto drop-shadow-[0_18px_22px_rgba(20,6,50,0.35)] sm:h-[22rem] lg:-mr-4 lg:h-[36rem]"
          />
        </div>
      </Container>
    </section>
  );
}
