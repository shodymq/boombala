import { can, canExport, type Permission } from "@/core/rbac";
import { requireUser } from "@/server/dal";
import Link from "next/link";
import { logout } from "../login/actions";
import { CurrentPageLabel, NavLinks, type NavItem } from "./nav-links";

const NAV: Array<NavItem & { permission: Permission }> = [
  { href: "/", label: "Обзор", permission: "dashboard.view" },
  { href: "/bookings", label: "Календарь", permission: "bookings.manage" },
  { href: "/requests", label: "Заявки", permission: "requests.manage" },
  { href: "/attendance", label: "Посещаемость", permission: "attendance.manage" },
  { href: "/news", label: "Новости", permission: "news.manage" },
  { href: "/contacts", label: "Клиенты", permission: "contacts.view" },
  { href: "/legal", label: "Документы", permission: "legal.manage" },
  { href: "/retention", label: "Хранение данных", permission: "privacy.manage" },
  { href: "/users", label: "Сотрудники", permission: "users.manage" },
  { href: "/audit", label: "Журнал", permission: "audit.view" },
  { href: "/account", label: "Мой пароль", permission: "dashboard.view" },
];

const ORDER = ["/", "/bookings", "/requests", "/attendance", "/news", "/contacts", "/export", "/legal", "/retention", "/users", "/audit", "/account"];

const ROLE_LABEL = { owner: "Владелец", manager: "Менеджер", editor: "Редактор" } as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const items = [
    ...NAV.filter((n) => can(user.role, n.permission)),
    ...(canExport(user) ? [{ href: "/export", label: "Выгрузка", permission: "contacts.view" as Permission }] : []),
  ].sort((a, b) => ORDER.indexOf(a.href) - ORDER.indexOf(b.href));
  return (
    <div className="snow-shell">
      <aside className="snow-sidebar">
        <Link href="/" className="snow-brand" aria-label="Boom Bala CRM — обзор">
          <span className="snow-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>
            <span className="snow-brand-name">BOOM BALA</span>
            <span className="snow-brand-caption">Banquet CRM</span>
          </span>
        </Link>
        <NavLinks items={items.map(({ href, label }) => ({ href, label }))} />
        <div className="snow-sidebar-footer">
          <span className="snow-avatar" aria-hidden="true">{initials || "BB"}</span>
          <div className="snow-sidebar-user">
            <strong>{user.name}</strong>
            <span>{ROLE_LABEL[user.role]}</span>
          </div>
        </div>
      </aside>
      <div className="snow-content">
        <header className="snow-topbar">
          <nav className="snow-breadcrumbs" aria-label="Навигационная цепочка">
            <span>Рабочее пространство</span>
            <span className="snow-breadcrumb-divider" aria-hidden="true">/</span>
            <strong aria-current="page"><CurrentPageLabel items={items.map(({ href, label }) => ({ href, label }))} /></strong>
          </nav>
          <div className="snow-topbar-actions">
            <div className="snow-topbar-user">
              <span className="snow-avatar" aria-hidden="true">{initials || "BB"}</span>
              <span className="snow-topbar-user-copy">
                <strong>{user.name}</strong>
                <span>{ROLE_LABEL[user.role]}</span>
              </span>
            </div>
            <form action={logout}>
              <button type="submit" className="snow-logout">Выйти</button>
            </form>
          </div>
        </header>
        <main id="main" className="snow-main">{children}</main>
      </div>
    </div>
  );
}
