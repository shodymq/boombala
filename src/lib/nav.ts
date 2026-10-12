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
  { label: "Дни рождения", href: "/birthdays", hint: "Пакеты WOW, MAGIC, BOOM и тематические комнаты" },
  { label: "Меню кафе", href: "/menu", hint: "Блюда и цены" },
];

/** Sections of the home page. `primary` ones also sit in the tablet header; the rest only from 1280 px. */
export const infoLinks: readonly (NavLink & { primary: boolean })[] = [
  { label: "Цены на вход", href: "/#prices", primary: true },
  { label: "Контакты и адрес", href: "/#contacts", primary: true },
  { label: "Абонемент", href: "/#membership", primary: false },
  { label: "Вопросы", href: "/#faq", primary: false },
];

/** Is `href` (a page link) the page the visitor is on? */
export const isCurrentPage = (href: string, pathname: string): boolean =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
