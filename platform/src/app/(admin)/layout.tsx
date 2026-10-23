import { can, canExport, type Permission } from "@/core/rbac";
import { requireUser } from "@/server/dal";
import { logout } from "../login/actions";
import { NavLinks, type NavItem } from "./nav-links";

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
  const items = [
    ...NAV.filter((n) => can(user.role, n.permission)),
    ...(canExport(user) ? [{ href: "/export", label: "Выгрузка", permission: "contacts.view" as Permission }] : []),
  ].sort((a, b) => ORDER.indexOf(a.href) - ORDER.indexOf(b.href));
  return (
    <div className="mx-auto min-h-dvh w-full max-w-6xl px-4 pb-16 md:grid md:grid-cols-[13rem_1fr] md:gap-8 md:pt-6">
      <aside className="sticky top-0 z-10 -mx-4 border-b border-line bg-paper px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0">
        <div className="mb-3 flex items-center justify-between gap-3 md:mb-6 md:block">
          <div>
            <p className="text-lg font-black tracking-tight text-grape-800">Boom Bala</p>
            <p className="text-xs font-semibold text-muted">Управление</p>
          </div>
          <form action={logout} className="md:mt-4">
            <button type="submit" className="h-10 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50">
              Выйти
            </button>
          </form>
        </div>
        <NavLinks items={items.map(({ href, label }) => ({ href, label }))} />
        <p className="mt-3 hidden text-xs text-muted md:block">
          {user.name}
          <br />
          {ROLE_LABEL[user.role]}
        </p>
      </aside>
      <main id="main" className="min-w-0 pt-5 md:pt-0">
        {children}
      </main>
    </div>
  );
}
