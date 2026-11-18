import type { Metadata } from "next";
import { StaticImage } from "@/components/static-image";
import Link from "next/link";
import { FlaticonIcon, type FlaticonIconName } from "@/components/flaticon-icon";
import { cookies } from "next/headers";
import { dayFigures } from "@/core/attendance";
import { attendanceSchemaReady } from "@/core/preflight";
import { BUSINESS_TIME_ZONE, catalogSummary } from "@/core/catalog";
import { almatyToday } from "@/core/dates";
import { outboxStats } from "@/core/outbox";
import { can, type Permission } from "@/core/rbac";
import { getPool } from "@/server/db";
import { requirePermission } from "@/server/dal";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { SESSION_COOKIE } from "@/server/env";

export const metadata: Metadata = { title: "Обзор" };

const kzt = new Intl.NumberFormat("ru-RU");

const ACCESS: Array<{ permission: Permission; label: string }> = [
  { permission: "requests.manage", label: "Заявки" },
  { permission: "bookings.manage", label: "Бронирования" },
  { permission: "attendance.manage", label: "Посещаемость" },
  { permission: "contacts.view", label: "Клиенты" },
  { permission: "legal.manage", label: "Документы" },
  { permission: "news.manage", label: "Новости" },
  { permission: "prices.manage", label: "Цены" },
  { permission: "users.manage", label: "Сотрудники" },
  { permission: "audit.view", label: "Журнал действий" },
];

type Summary = Awaited<ReturnType<typeof catalogSummary>>;
type Data = {
  user: { name: string; role: string };
  migration: string | null;
  summary: Summary | null;
  outbox: Awaited<ReturnType<typeof outboxStats>> | null;
  attendance: Awaited<ReturnType<typeof dayFigures>> | "outdated" | null;
  requests: { new: number; inProgress: number } | null;
  bookings: { booked: number; blocked: number; capacity: number } | null;
};

export default async function DashboardPage() {
  const { user } = await requirePermission("dashboard.view");
  if (legacyBridgeEnabled()) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new Error("session_missing");
    const remote = await bridgeRpc<{ migrations: string[]; summary: Summary | null; outbox: Awaited<ReturnType<typeof outboxStats>> | null; attendance: Awaited<ReturnType<typeof dayFigures>> | null }>("dashboard", {}, token);
    // The bridge dashboard call carries no request or booking counters: those cards stay hidden rather than invented.
    return <DashboardView data={{ user, migration: remote.migrations[0] ?? null, summary: remote.summary, outbox: remote.outbox, attendance: remote.attendance, requests: null, bookings: null }} />;
  }
  const pool = getPool();
  const today = almatyToday();
  const [migrations, summary, outbox, attendance, requests, bookings] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name DESC"),
    can(user.role, "catalog.view") ? catalogSummary(pool) : Promise.resolve(null),
    can(user.role, "contacts.view") ? outboxStats(pool) : Promise.resolve(null),
    // Preflight: without migration 013 the card is replaced by a clear notice instead of a failing page.
    can(user.role, "attendance.manage")
      ? (async (): Promise<Awaited<ReturnType<typeof dayFigures>> | "outdated"> =>
          (await attendanceSchemaReady(pool)) ? dayFigures(pool, { id: user.id, role: user.role }, today) : "outdated")()
      : Promise.resolve(null),
    can(user.role, "requests.manage")
      ? pool.query<{ status: string; total: number }>(
          "SELECT status, count(*)::int AS total FROM bb.lead_requests WHERE status IN ('new', 'in_progress') GROUP BY status")
      : Promise.resolve(null),
    can(user.role, "bookings.manage")
      ? pool.query<{ booked: number; blocked: number; capacity: number }>(
          `SELECT count(*) FILTER (WHERE kind = 'booking')::int AS booked,
                  count(*) FILTER (WHERE kind = 'block')::int AS blocked,
                  (SELECT count(*)::int FROM bb.rooms WHERE is_active) * (SELECT count(*)::int FROM bb.time_slots) AS capacity
             FROM bb.slot_reservations WHERE slot_date = $1 AND released_at IS NULL`, [today])
      : Promise.resolve(null),
  ]);
  return (
    <DashboardView data={{
      user, migration: migrations.rows[0]?.name ?? null, summary, outbox, attendance,
      requests: requests ? { new: requests.rows.find((r) => r.status === "new")?.total ?? 0, inProgress: requests.rows.find((r) => r.status === "in_progress")?.total ?? 0 } : null,
      bookings: bookings?.rows[0] ?? null,
    }} />
  );
}

function DashboardView({ data }: { data: Data }) {
  const { user, summary, outbox, attendance, requests } = data;
  const todayBookings = data.bookings;
  const migrations = { rows: [{ name: data.migration }] };
  const timestamp = new Date();
  const activePackages = summary?.packages.filter((item) => item.isActive) ?? [];
  const activeRooms = summary?.rooms.filter((room) => room.isActive) ?? [];
  const pricePackages = activePackages.filter((item) => item.basePrice != null);
  const maxPrice = Math.max(1, ...pricePackages.map((item) => item.basePrice ?? 0));
  const now = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE }).format(timestamp);
  const metrics: Array<{ label: string; value: number; suffix?: string; note: string; href: string; icon: FlaticonIconName }> = [];
  if (requests) {
    metrics.push({ label: "Новые заявки", value: requests.new, note: "Ждут ответа", href: "/requests?status=new", icon: "inbox" });
    metrics.push({ label: "В работе", value: requests.inProgress, note: "Открытые обращения", href: "/requests?status=in_progress", icon: "ticket" });
  }
  if (todayBookings) {
    metrics.push({ label: "Брони сегодня", value: todayBookings.booked, suffix: ` / ${todayBookings.capacity}`, note: `Блокировки: ${todayBookings.blocked}`, href: "/bookings", icon: "calendar" });
  }
  if (attendance && attendance !== "outdated") {
    metrics.push({ label: "Дети вошли сегодня", value: attendance.childrenEntered, note: `Ожидается: ${attendance.childrenExpected}`, href: "/attendance", icon: "check" });
  }

  return (
    <div className="snow-overview">
      <header className="so-heading">
        <div className="so-intro">
          <p className="so-eyebrow">Обзор CRM <span aria-hidden="true">·</span> Алматы</p>
          <h1>
            Добрый день, {user.name}
            <span className="so-greeting-art">
              <StaticImage src="/illustrations/milano-hello.svg" alt="" width={58} height={58} />
            </span>
          </h1>
          <p>Заявки, бронирования и посещаемость филиала — на одном экране.</p>
          <time className="so-date" dateTime={timestamp.toISOString()}>{now}</time>
        </div>
        <div className="so-actions">
          {can(user.role as never, "bookings.manage") ? <Link className="so-button so-button-primary" href="/bookings">Открыть календарь <span aria-hidden="true">↗</span></Link> : null}
          {can(user.role as never, "requests.manage") ? <Link className="so-button so-button-secondary" href="/requests">Все заявки</Link> : null}
        </div>
      </header>

      {metrics.length > 0 ? (
        <section className="so-metrics-section" aria-label="Показатели на сегодня">
          <p className="so-section-eyebrow">Показатели сегодня</p>
          <div className="so-metrics">
            {metrics.map((metric) => (
              <Link className="so-metric" href={metric.href} key={metric.label}>
                <span className="so-metric-icon" aria-hidden="true"><FlaticonIcon name={metric.icon} size={16} /></span>
                <span className="so-metric-label">{metric.label}</span>
                <strong className="so-metric-value">{metric.value}{metric.suffix ? <span>{metric.suffix}</span> : null}</strong>
                <span className="so-metric-note">{metric.note}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      
      <div className="so-dashboard-grid">
        {summary ? (
          <section aria-labelledby="catalog-title" className="so-panel">
            <div className="so-panel-heading">
              <div>
                <p className="so-section-eyebrow">Каталог</p>
                <h2 id="catalog-title">Цены активных пакетов</h2>
              </div>
              <span className="so-panel-caption">{pricePackages.length} с базовой ценой</span>
            </div>
            {pricePackages.length > 0 ? (
              <ul className="so-price-list">
                {pricePackages.map((item) => (
                  <li key={item.id} className="so-price-row">
                    <span className="so-price-name">{item.name}</span>
                    <span
                      className="so-price-track"
                      role="meter"
                      aria-label={"Базовая цена пакета " + item.name}
                      aria-valuemin={0}
                      aria-valuemax={maxPrice}
                      aria-valuenow={item.basePrice ?? 0}
                    >
                      <span className={`so-price-fill so-w-${Math.min(100, Math.max(0, Math.round(((item.basePrice ?? 0) / maxPrice) * 100)))}`} />
                    </span>
                    <strong className="so-price-value">{kzt.format(item.basePrice ?? 0)} ₸</strong>
                    <span className="so-price-note">
                      Будни: {item.weekdayPrice == null ? "не задано" : kzt.format(item.weekdayPrice) + " ₸"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="so-empty">В активном каталоге пока нет базовых цен.</p>
            )}
            <dl className="so-catalog-meta">
              <div>
                <dt>Комнаты</dt>
                <dd>{activeRooms.map((room) => room.name).join(", ") || "—"}</dd>
              </div>
              <div>
                <dt>Слоты</dt>
                <dd>{summary.slots.map((slot) => slot.startsAt + "–" + slot.endsAt).join(", ") || "—"}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        <div className="so-side-panels">
          {attendance === "outdated" ? (
            <section aria-labelledby="attendance-title" className="so-panel" data-testid="dash-attendance-outdated">
              <div className="so-panel-heading">
                <div><p className="so-section-eyebrow">Сегодня</p><h2 id="attendance-title">Посещаемость</h2></div>
              </div>
              <p role="alert" className="so-alert">Схема базы данных устарела. Нужна миграция 013.</p>
            </section>
          ) : attendance ? (
            <section aria-labelledby="attendance-title" className="so-panel" data-testid="dash-attendance">
              <div className="so-panel-heading">
                <div><p className="so-section-eyebrow">Сегодня</p><h2 id="attendance-title">Посещаемость</h2></div>
                <span className="so-panel-caption">Алматы</span>
              </div>
              <dl className="so-attendance-grid">
                <div className="so-attendance-stat">
                  <dt><span>Детей вошло</span></dt>
                  <dd><strong>{attendance.childrenEntered}</strong></dd>
                </div>
                <div className="so-attendance-stat">
                  <dt><span>Взрослых отметили по QR</span></dt>
                  <dd><strong>{attendance.adultsRegistered}</strong></dd>
                </div>
                <div className="so-attendance-stat">
                  <dt><span>Детей ожидается</span></dt>
                  <dd><strong>{attendance.childrenExpected}</strong></dd>
                </div>
              </dl>
              <Link href="/attendance" className="so-panel-link">Открыть посещаемость <span aria-hidden="true">↗</span></Link>
            </section>
          ) : null}

          {outbox ? (
            <section aria-labelledby="outbox-title" className="so-panel">
              <div className="so-panel-heading">
                <div><p className="so-section-eyebrow">Доставка</p><h2 id="outbox-title">Уведомления</h2></div>
              </div>
              <div className="so-system-list">
                <div className="so-system-row"><span>Ожидают отправки</span><strong>{outbox.pending}</strong></div>
                <div className="so-system-row"><span>Не доставлены</span><strong className={outbox.dead ? "so-status-error" : "so-status-ok"}>{outbox.dead}</strong></div>
              </div>
              {outbox.dead ? <p role="alert" className="so-alert">Заявки сохранены, но уведомления не доставлены.</p> : null}
            </section>
          ) : null}

          <section aria-labelledby="system-title" className="so-panel">
            <div className="so-panel-heading">
              <div><p className="so-section-eyebrow">Состояние</p><h2 id="system-title">Система</h2></div>
            </div>
            <div className="so-system-list">
              <div className="so-system-row"><span>База данных</span><strong className="so-status-ok">Подключена</strong></div>
              <div className="so-system-row"><span>Версия схемы</span><strong>{migrations.rows[0]?.name ?? "—"}</strong></div>
            </div>
            <div className="so-access">
              <p className="so-section-eyebrow">Учетная запись</p>
              <h3 id="access-title">Ваш доступ</h3>
              <ul className="so-access-list">
                {ACCESS.map((item) => (
                  <li key={item.permission} aria-disabled={!can(user.role as never, item.permission) || undefined}>
                    {item.label}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
