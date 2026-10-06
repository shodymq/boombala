import Image from "next/image";
import Link from "next/link";
import { InstagramLogo } from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/services/config";
import { navItems } from "@/lib/nav";
import { Container } from "@/components/ui/Container";

export function Footer() {
  return (
    <footer className="bg-grape-900 text-grape-100">
      <Container className="grid gap-10 py-12 md:grid-cols-[1.2fr_1fr_1fr] md:py-16">
        <div>
          <div className="inline-block rounded-2xl bg-paper px-4 py-3">
            <Image src="/brand/logo.webp" alt="Boom Bala" width={2000} height={667} sizes="150px" className="h-auto w-[150px]" />
          </div>
          <p className="mt-5 max-w-[34ch] text-base leading-relaxed text-grape-200">
            Детский развлекательный центр в {siteConfig.city}.
          </p>
        </div>

        <nav aria-label="Разделы сайта">
          <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">Разделы</p>
          <ul className="grid gap-1">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="inline-block py-1.5 text-base transition-colors hover:text-white">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-sun-400">Мы в соцсетях</p>
          <a
            href={siteConfig.contacts.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 py-1.5 text-base transition-colors hover:text-white"
          >
            <InstagramLogo size={22} weight="bold" aria-hidden="true" />
            {siteConfig.contacts.instagramHandle}
          </a>
        </div>
      </Container>
      <div className="border-t border-white/10">
        <Container className="py-5 text-sm text-grape-200">© 2026 Boom Bala, {siteConfig.city}</Container>
      </div>
    </footer>
  );
}
