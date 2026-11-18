import Image from "next/image";
import Link from "next/link";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowSquareOut,
  Clock,
  EnvelopeSimple,
  InstagramLogo,
  MapPin,
  Phone,
  ThreadsLogo,
  TiktokLogo,
  WhatsappLogo,
} from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/services/config";
import { navFor, shellUi } from "@/lib/nav";
import type { Locale } from "@/types";
import { Container } from "@/components/ui/Container";

const socialLinks: Array<{ label: string; href: string; icon: Icon }> = [
  { label: "Instagram", href: siteConfig.contacts.instagram, icon: InstagramLogo },
  { label: "TikTok", href: siteConfig.contacts.tiktok, icon: TiktokLogo },
  { label: "Threads", href: siteConfig.contacts.threads, icon: ThreadsLogo },
  { label: "WhatsApp", href: `https://wa.me/${siteConfig.contacts.whatsapp}`, icon: WhatsappLogo },
];

export function Footer({ locale = "ru" }: { locale?: Locale }) {
  const { homeLink, infoLinks, legalLinks, pageLinks } = navFor(locale);
  const ui = shellUi[locale];
  return (
    <footer className="bg-grape-900 text-grape-100">
      <Container className="grid gap-10 py-12 md:grid-cols-[1.2fr_2fr] md:py-16">
        <div className="min-w-0">
          <Image
            src="/brand/logo.webp"
            alt="Boom Bala"
            width={2000}
            height={667}
            sizes="180px"
            className="-ml-2 h-auto w-[168px] select-none"
          />
          <p className="mt-5 max-w-[34ch] text-base leading-relaxed text-grape-200">
            {locale === "kk" ? `Boom Bala — Алматыдағы балаларға арналған ойын-сауық орталығы.` : `Boom Bala — детский игровой и развлекательный центр в ${siteConfig.city}.`}
          </p>
          <address className="mt-4 text-base not-italic leading-relaxed text-grape-200">
            <span className="flex items-start gap-2">
              <MapPin size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-sun-400" />
              <span>
                {ui.footerAddress(siteConfig.location.city, siteConfig.location.street, siteConfig.location.mall)}
              </span>
            </span>
            <span className="mt-3 flex items-start gap-2">
              <Clock size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-sun-400" />
              <span>
                <span className="block">{ui.footerHours}</span>
                <span className="block">{ui.footerLastEntry}</span>
              </span>
            </span>
            <a
              href={`tel:${siteConfig.contacts.phone.tel}`}
              className="mt-3 inline-flex min-h-11 items-center gap-2 transition-colors hover:text-white focus-visible:text-white"
            >
              <Phone size={20} weight="bold" aria-hidden="true" className="shrink-0 text-sun-400" />
              {siteConfig.contacts.phone.display}
            </a>
            <a
              href={`mailto:${siteConfig.contacts.email}`}
              className="flex min-h-11 items-center gap-2 break-all transition-colors hover:text-white focus-visible:text-white"
            >
              <EnvelopeSimple size={20} weight="bold" aria-hidden="true" className="shrink-0 text-sun-400" />
              {siteConfig.contacts.email}
            </a>
          </address>
          <a
            href={siteConfig.location.mapUrl ?? "https://go.2gis.com/glADK"}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-sun-400/70 px-4 py-2 font-display text-sm font-extrabold text-sun-400 transition-colors hover:bg-sun-400 hover:text-grape-900 focus-visible:bg-sun-400 focus-visible:text-grape-900"
          >
            <MapPin size={19} weight="bold" aria-hidden="true" />
            {ui.footerMap}
            <ArrowSquareOut size={17} weight="bold" aria-hidden="true" />
          </a>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-9 min-[1200px]:grid-cols-4">
          <nav aria-label={ui.footerPages}>
            <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">{ui.footerPages}</p>
            <ul className="grid gap-1">
              {[homeLink, ...pageLinks].map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="inline-block py-1.5 text-base transition-colors hover:text-white">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={ui.footerInfo}>
            <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">{ui.footerInfo}</p>
            <ul className="grid gap-1">
              {infoLinks.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="inline-block py-1.5 text-base transition-colors hover:text-white">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={ui.footerDocs}>
            <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">{ui.footerDocs}</p>
            <ul className="grid gap-1">
              {legalLinks.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="inline-block py-1.5 text-base transition-colors hover:text-white">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={ui.footerSocial} className="col-span-2 min-[1200px]:col-span-1">
            <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">{ui.footerSocial}</p>
            <ul className="grid gap-1 sm:grid-cols-2 min-[1200px]:grid-cols-1">
              {socialLinks.map(({ label, href, icon: SocialIcon }) => (
                <li key={label}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={ui.footerSocialLabel(label)}
                    className="inline-flex min-h-11 items-center gap-2 py-1.5 text-base transition-colors hover:text-white focus-visible:text-white"
                  >
                    <SocialIcon size={22} weight="bold" aria-hidden="true" />
                    <span>{label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </Container>
      <div className="border-t border-white/10">
        <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pb-24 pt-5 text-sm text-grape-200 min-[1080px]:pb-5">
          <span>© 2026 Boom Bala, {siteConfig.city}</span>
        </Container>
      </div>
    </footer>
  );
}
