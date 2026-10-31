import { can, canExport, type Permission } from "@/core/rbac";
import { requireUser } from "@/server/dal";
import Link from "next/link";
import { logout } from "../login/actions";
import { CurrentPageLabel, NavLinks, type NavItem } from "./nav-links";
import { FlaticonIcon } from "@/components/flaticon-icon";
import { unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";

const FIGMA_SOURCE = "https://www.figma.com/design/nFN83oaOWjVyMMCgV4shBY/1-600-Free-Illustrations---Vector-illustrations-set--svg-png---Community?node-id=1-65";

const NAV: Array<NavItem & { permission: Permission }> = [
  { href: "/", label: "Обзор", permission: "dashboard.view" },
  { href: "/bookings", label: "Календарь", permission: "bookings.manage" },
  { href: "/requests", label: "Заявки", permission: "requests.manage" },
  { href: "/attendance", label: "Посещаемость", permission: "attendance.manage" },
  { href: "/news", label: "Новости", permission: "news.manage" },
  { href: "/contacts", label: "Клиенты", permission: "contacts.view" },
  { href: "/catalog", label: "Пакеты и цены", permission: "prices.manage" },
  { href: "/legal", label: "Документы", permission: "legal.manage" },
  { href: "/retention", label: "Хранение данных", permission: "privacy.manage" },
  { href: "/users", label: "Сотрудники", permission: "users.manage" },
  { href: "/audit", label: "Журнал", permission: "audit.view" },
  { href: "/account", label: "Мой пароль", permission: "dashboard.view" },
];

const ORDER = ["/", "/bookings", "/requests", "/attendance", "/contacts", "/news", "/export", "/catalog", "/legal", "/retention", "/users", "/audit", "/account"];

const ROLE_LABEL = { owner: "Владелец", manager: "Менеджер", editor: "Редактор" } as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const items = [
    ...NAV.filter((n) => can(user.role, n.permission) && (n.href !== "/catalog" || unifiedFastapiCrmEnabled())),
    ...(canExport(user) ? [{ href: "/export", label: "Выгрузка", permission: "contacts.view" as Permission }] : []),
  ].sort((a, b) => ORDER.indexOf(a.href) - ORDER.indexOf(b.href));
  return (
    <div className="app-shell snow-shell">
      <aside className="sidebar snow-sidebar">
        <Link href="/" className="brand-lockup snow-brand" aria-label="Boom Bala CRM — обзор">
          <span className="brand-mark snow-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>
            <span className="brand-name snow-brand-name">BoomBala</span>
            <span className="brand-caption snow-brand-caption">Banquet CRM</span>
          </span>
        </Link>
        <NavLinks items={items.map(({ href, label }) => ({ href, label }))} />
        <div className="sidebar-footer snow-sidebar-footer">
          <span className="sidebar-user-avatar" aria-hidden="true">{initials || "BB"}</span>
          <div className="sidebar-user-copy snow-sidebar-user">
            <strong>{user.name}</strong>
            <span>{ROLE_LABEL[user.role]}</span>
          </div>
        </div>
        <div className="snow-asset-credits">
          <a href="https://www.flaticon.com/" target="_blank" rel="noreferrer">Designed by Flaticon</a>
          <a href={FIGMA_SOURCE} target="_blank" rel="noreferrer">Illustrations by Streamline</a>
        </div>
      </aside>
      <div className="main-area snow-content">
        <header className="topbar snow-topbar">
          <nav className="breadcrumbs snow-breadcrumbs" aria-label="Навигационная цепочка">
            <span>Рабочее пространство</span>
            <span className="snow-breadcrumb-divider" aria-hidden="true">/</span>
            <strong aria-current="page"><CurrentPageLabel items={items.map(({ href, label }) => ({ href, label }))} /></strong>
            <small className="scope-breadcrumb">Один филиал · Алматы</small>
          </nav>
          <div className="topbar-actions snow-topbar-actions">
            <div className="top-user snow-topbar-user">
              <span className="top-user-avatar" aria-hidden="true">{initials || "BB"}</span>
              <span className="top-user-copy snow-topbar-user-copy">
                <strong>{user.name}</strong>
                <span>{ROLE_LABEL[user.role]}</span>
              </span>
            </div>
            <form action={logout}>
              <button type="submit" className="snow-logout"><FlaticonIcon name="logout" size={15} />Выйти</button>
            </form>
          </div>
        </header>
        <main id="main" className="snow-main dashboard-content">{children}</main>
      </div>
    </div>
  );
}
