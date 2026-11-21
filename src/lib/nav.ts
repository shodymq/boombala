import type { Locale } from "@/types";
/**
 * Site navigation, single source of truth for the header, the mobile menu and the footer.
 * Rule: a label always leads to the same place. Pages and home-page sections are kept apart.
 */
export interface NavLink {
  label: string;
  href: string;
  /** One line under the label in the mobile menu: says what is behind the link. */
  hint?: string;
}

export const homeLink: NavLink = { label: "Главная", href: "/", hint: "Что у нас есть и сколько это стоит" };

/** Full pages of the site. */
export const pageLinks: readonly NavLink[] = [
  { label: "Развлечения", href: "/attractions", hint: "Все аттракционы, возраст и рост" },
  { label: "Дни рождения", href: "/birthdays", hint: "Пакеты HAPPY, STAR, BOOM BALA и тематические комнаты" },
  { label: "Меню кафе", href: "/menu", hint: "Блюда и цены" },
  // Shown only when the news section is switched on (NEXT_PUBLIC_NEWS=1); otherwise the navigation is exactly as before.
  ...(process.env.NEXT_PUBLIC_NEWS === "1" ? [{ label: "Новости", href: "/news", hint: "Новости и акции" }] : []),
];

/** Sections of the home page. `primary` ones also sit in the tablet header; the rest only from 1280 px. */
export const infoLinks: readonly (NavLink & { primary: boolean })[] = [
  { label: "Цены на вход", href: "/#prices", primary: true },
  { label: "Контакты и адрес", href: "/#contacts", primary: true },
  { label: "Абонемент", href: "/#membership", primary: false },
  { label: "Вопросы", href: "/#faq", primary: false },
];

export const legalLinks: readonly NavLink[] = [
  { label: "Правила посещения", href: "/rules" },
  { label: "Согласие на обработку ПДн", href: "/personal-data-consent" },
  { label: "Политика конфиденциальности", href: "/privacy" },
];

/** Is `href` (a page link) the page the visitor is on? */
export const isCurrentPage = (href: string, pathname: string): boolean =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

/* ── Kazakh shell (the header, the navigation and the footer on /kk pages) ───────────────────────────────────────────── */


const KK_LINKS: Record<string, { label: string; hint?: string; href?: string }> = {
  "/": { label: "Басты бет", hint: "Бізде не бар және неге тұрады" },
  "/attractions": { label: "Аттракциондар", hint: "Барлық аттракциондар, жас және бой шегі" },
  "/birthdays": { label: "Туған күн", hint: "HAPPY, STAR, BOOM BALA пакеттері және тақырыптық бөлмелер", href: "/kk/birthdays" },
  "/menu": { label: "Кафе мәзірі", hint: "Тағамдар мен бағалар" },
  "/#prices": { label: "Кіру бағасы" },
  "/#contacts": { label: "Байланыс және мекен-жай" },
  "/#membership": { label: "Абонемент" },
  "/#faq": { label: "Сұрақтар" },
  "/rules": { label: "Баруға ережелер" },
  "/personal-data-consent": { label: "Дербес деректерді өңдеуге келісім" },
  "/privacy": { label: "Құпиялылық саясаты" },
};

/** The navigation of a locale. Kazakh labels and, where a Kazakh page exists, its address. Other pages keep their Russian content. */
export function navFor(locale: Locale): { homeLink: NavLink; pageLinks: readonly NavLink[]; infoLinks: readonly (NavLink & { primary: boolean })[]; legalLinks: readonly NavLink[] } {
  if (locale === "ru") return { homeLink, pageLinks, infoLinks, legalLinks };
  const tr = <T extends NavLink>(link: T): T => {
    const k = KK_LINKS[link.href];
    return k ? { ...link, label: k.label, hint: k.hint ?? link.hint, href: k.href ?? link.href } : link;
  };
  return {
    homeLink: tr(homeLink),
    pageLinks: pageLinks.map(tr),
    infoLinks: infoLinks.map(tr),
    legalLinks: legalLinks.map(tr),
  };
}

/** Texts of the header and the footer that are not navigation links. */
export const shellUi: Record<Locale, {
  homeAria: string;
  mainNav: string;
  mobileNav: string;
  openMenu: string;
  closeMenu: string;
  bookCta: string;
  sections: string;
  quick: string;
  skip: string;
  footerAbout: string;
  footerPages: string;
  footerInfo: string;
  footerDocs: string;
  footerSocial: string;
  footerHours: string;
  footerLastEntry: string;
  footerMap: string;
  footerSocialLabel: (name: string) => string;
  footerAddress: (city: string, street: string, mall: string) => string;
}> = {
  ru: {
    homeAria: "Boom Bala — на главную",
    mainNav: "Основная навигация",
    mobileNav: "Мобильная навигация",
    openMenu: "Открыть меню",
    closeMenu: "Закрыть меню",
    bookCta: "Забронировать праздник",
    sections: "Разделы",
    quick: "Быстрые ссылки",
    skip: "К содержимому",
    footerAbout: "",
    footerPages: "Страницы",
    footerInfo: "Информация",
    footerDocs: "Документы",
    footerSocial: "Мы в соцсетях",
    footerHours: "Ежедневно: 10:00–22:00",
    footerLastEntry: "Последний вход: 21:00",
    footerMap: "Открыть в 2GIS",
    footerSocialLabel: (name) => `Boom Bala в ${name}`,
    footerAddress: (city, street, mall) => `г. ${city}, ${street}, ${mall}, 3-й этаж.`,
  },
  kk: {
    homeAria: "Boom Bala — басты бетке",
    mainNav: "Негізгі навигация",
    mobileNav: "Мобильді навигация",
    openMenu: "Мәзірді ашу",
    closeMenu: "Мәзірді жабу",
    bookCta: "Мерекені брондау",
    sections: "Бөлімдер",
    quick: "Жылдам сілтемелер",
    skip: "Мазмұнға өту",
    footerAbout: "",
    footerPages: "Беттер",
    footerInfo: "Ақпарат",
    footerDocs: "Құжаттар",
    footerSocial: "Әлеуметтік желілерде біз",
    footerHours: "Күн сайын: 10:00–22:00",
    footerLastEntry: "Соңғы кіру: 21:00",
    footerMap: "2GIS-те ашу",
    footerSocialLabel: (name) => `Boom Bala ${name} желісінде`,
    footerAddress: (city, street, mall) => `${city} қ., ${street}, ${mall}, 3-қабат.`,
  },
};
