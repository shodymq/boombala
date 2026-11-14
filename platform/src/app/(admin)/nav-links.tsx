"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
}

const PRIMARY_HREFS = new Set(["/", "/bookings", "/requests", "/attendance", "/contacts"]);
const ICON_PATHS: Record<string, string> = {
  "/": "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  "/bookings": "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v13H3V6a2 2 0 0 1 2-2z",
  "/requests": "M4 4h16v13H7l-3 3z M8 8h8m-8 4h5",
  "/attendance": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM18 8v6m3-3h-6",
  "/contacts": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 3.2a4 4 0 0 1 0 7.6M18 15h1a4 4 0 0 1 4 4v2",
  "/news": "M6 2h9l5 5v15H6zM14 2v6h6M9 12h8m-8 4h8",
  "/export": "M12 3v12m0 0 5-5m-5 5-5-5M4 19v2h16v-2",
  "/legal": "M7 3h10v18H5V5zM8 9h6m-6 4h6m-6 4h4",
  "/retention": "M12 8v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z",
  "/users": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 11a4 4 0 1 0 0-8",
  "/audit": "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  "/account": "M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM4 21a8 8 0 0 1 16 0",
};

function isCurrent(item: NavItem, pathname: string) {
  return item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavList({ items, pathname, onNavigate }: { items: NavItem[]; pathname: string; onNavigate: () => void }) {
  return (
    <ul className="snow-nav-list">
      {items.map((item) => {
        const active = isCurrent(item, pathname);
        return (
          <li key={item.href}>
            <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className="snow-nav-link">
              <svg className="snow-nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d={ICON_PATHS[item.href]} />
              </svg>
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [menu, setMenu] = useState({ pathname, open: false });
  const menuOpen = menu.pathname === pathname && menu.open;
  const primary = items.filter((item) => PRIMARY_HREFS.has(item.href));
  const management = items.filter((item) => !PRIMARY_HREFS.has(item.href));

  const closeMenu = () => setMenu({ pathname, open: false });

  return (
    <nav aria-label="Разделы" className="snow-nav" data-open={menuOpen} onKeyDown={(event) => {
      if (event.key === "Escape") closeMenu();
    }}>
      <button
        type="button"
        className="snow-nav-toggle"
        aria-expanded={menuOpen}
        aria-controls="snow-nav-sections"
        onClick={() => setMenu({ pathname, open: !menuOpen })}
      >
        <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
        {menuOpen ? "Закрыть меню" : "Меню"}
      </button>
      <div id="snow-nav-sections" className="snow-nav-sections">
        {primary.length > 0 ? (
          <section className="snow-nav-section">
            <h2 className="snow-sidebar-label">Основное</h2>
            <NavList items={primary} pathname={pathname} onNavigate={closeMenu} />
          </section>
        ) : null}
        {management.length > 0 ? (
          <section className="snow-nav-section">
            <h2 className="snow-sidebar-label">Управление</h2>
            <NavList items={management} pathname={pathname} onNavigate={closeMenu} />
          </section>
        ) : null}
      </div>
    </nav>
  );
}

export function CurrentPageLabel({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const current = items.filter((item) => isCurrent(item, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
  return current?.label ?? "Boom Bala CRM";
}
