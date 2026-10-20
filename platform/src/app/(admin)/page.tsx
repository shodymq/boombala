import type { Metadata } from "next";
import { BUSINESS_TIME_ZONE, catalogSummary } from "@/core/catalog";
import { can, type Permission } from "@/core/rbac";
import { getPool } from "@/server/db";
import { requirePermission } from "@/server/dal";

export const metadata: Metadata = { title: "Обзор" };

const kzt = new Intl.NumberFormat("ru-RU");

const ACCESS: Array<{ permission: Permission; label: string }> = [
  { permission: "requests.manage", label: "Заявки" },
  { permission: "bookings.manage", label: "Бронирования" },
  { permission: "contacts.view", label: "Клиенты" },
  { permission: "news.manage", label: "Новости" },
  { permission: "prices.manage", label: "Цены" },
  { permission: "users.manage", label: "Сотрудники" },
  { permission: "audit.view", label: "Журнал действий" },
];

export default async function DashboardPage() {
  const { user } = await requirePermission("dashboard.view");
  const pool = getPool();
  const [migrations, summary] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name DESC"),
    can(user.role, "catalog.view") ? catalogSummary(pool) : Promise.resolve(null),
  ]);
  const now = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE }).format(new Date());

  return (
    <div className="grid min-w-0 gap-6">
      <header>
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Здравствуйте, {user.name}</h1>
        <p className="mt-1 text-sm text-muted">Сейчас {now} (Алматы)</p>
      </header>

      <section aria-labelledby="sys" className="rounded-3xl border border-line bg-white p-5">
        <h2 id="sys" className="text-lg font-black text-grape-800">Система</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">База данных</dt>
            <dd className="font-bold text-ok">подключена</dd>
          </div>
          <div>
            <dt className="text-muted">Версия схемы</dt>
            <dd className="font-bold">{migrations.rows[0]?.name ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {summary ? (
        <section aria-labelledby="cat" className="rounded-3xl border border-line bg-white p-5">
          <h2 id="cat" className="text-lg font-black text-grape-800">Пакеты, комнаты и слоты из базы</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[18rem] text-left text-sm">
              <caption className="sr-only">Пакеты и текущие цены</caption>
              <thead className="text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-semibold">Пакет</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Обычная</th>
                  <th className="py-1.5 text-right font-semibold">Будни</th>
                </tr>
              </thead>
              <tbody>
                {summary.packages.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-2 pr-3 font-bold">{p.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.basePrice == null ? "—" : `${kzt.format(p.basePrice)} ₸`}</td>
                    <td className="py-2 text-right tabular-nums">{p.weekdayPrice == null ? "—" : `${kzt.format(p.weekdayPrice)} ₸`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm">
            <span className="font-bold">Комнаты:</span> {summary.rooms.map((r) => r.name).join(", ") || "—"}
          </p>
          <p className="mt-1 text-sm">
            <span className="font-bold">Слоты:</span> {summary.slots.map((s) => `${s.startsAt}–${s.endsAt}`).join(", ")}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="acc" className="rounded-3xl border border-line bg-white p-5">
        <h2 id="acc" className="text-lg font-black text-grape-800">Ваш доступ</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {ACCESS.map((a) => (
            <li
              key={a.permission}
              className={`rounded-full px-3 py-1 text-sm font-bold ${can(user.role, a.permission) ? "bg-grape-100 text-grape-800" : "bg-paper text-muted line-through"}`}
            >
              {a.label}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">
          Заявки, бронирования, клиенты и новости подключаются следующими этапами. До этого здесь нет данных, и система
          не показывает выдуманных цифр.
        </p>
      </section>
    </div>
  );
}
