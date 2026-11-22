"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { adminNavIcon } from "@/core/admin-nav-icons";

export interface NavItem {
  href: string;
  label: string;
}

const PRIMARY_HREFS = new Set(["/", "/bookings", "/requests", "/attendance", "/contacts"]);

function isCurrent(item: NavItem, pathname: string) {
  return item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Instant feedback on a click: the link shows it is being opened while the server renders the next page. */
function NavPending() {
  const { pending } = useLinkStatus();
  return <span className="snow-nav-pending" data-pending={pending ? "true" : "false"} aria-hidden="true" />;
}

function NavList({ items, pathname, onNavigate }: { items: NavItem[]; pathname: string; onNavigate: () => void }) {
  return (
    <ul className="snow-nav-list">
      {items.map((item) => {
        const active = isCurrent(item, pathname);
        return (
          <li key={item.href}>
            <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className="snow-nav-link">
              <Icon name={adminNavIcon(item.href)} size={17} className="snow-nav-icon" />
              <span>{item.label}</span>
              <NavPending />
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
  // /bookings is present only for roles allowed to manage bookings. The destination also enforces that permission server-side.
  const visibleItems = items.some((item) => item.href === "/bookings")
    ? [...items, { href: "/operations", label: "Ближайшие праздники" }]
    : items;
  const primary = visibleItems.filter((item) => PRIMARY_HREFS.has(item.href));
  const management = visibleItems.filter((item) => !PRIMARY_HREFS.has(item.href));

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
        <Icon name={menuOpen ? "plus" : "menu"} size={15} className={menuOpen ? "mobile-menu-icon mobile-menu-icon-close" : "mobile-menu-icon"} />
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
