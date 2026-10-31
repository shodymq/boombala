import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { attendanceSeries, dayFigures } from "@/core/attendance";
import { attendanceSchemaReady } from "@/core/preflight";
import { BUSINESS_TIME_ZONE, catalogSummary } from "@/core/catalog";
import { almatyToday } from "@/core/dates";
import { outboxStats } from "@/core/outbox";
import { can, canExport, type Permission } from "@/core/rbac";
import { getPool } from "@/server/db";
import { requirePermission } from "@/server/dal";
import { FlaticonIcon, type FlaticonIconName } from "@/components/flaticon-icon";

export const metadata: Metadata = { title: "Обзор" };

const kzt = new Intl.NumberFormat("ru-RU");
const integer = new Intl.NumberFormat("ru-RU");
const dateLabel = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });

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

const REQUEST_STATUS_LABELS: Record<string, string> = {
  new: "Новая",
  in_progress: "В работе",
  confirmed: "Подтверждена",
  cancelled: "Отменена",
  completed: "Завершена",
  contacted: "Связались",
  qualified: "Квалифицирована",
  booked: "Забронирована",
  paid: "Оплачена",
  lost: "Потеряна",
  closed: "Закрыта",
};

type TrendRow = { date: string; total: number };
type RequestRow = {
  id: string;
  status: string;
  name: string;
  phone: string;
  createdAt: Date;
  packageName: string | null;
  children: number | null;
};

function shiftDate(value: string, offset: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function linePath(values: number[], maximum: number) {
  const height = 220;
  const width = 720;
  return values.map((value, index) => {
    const x = index * width / Math.max(values.length - 1, 1);
    const y = height - value / maximum * (height - 14) - 7;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function areaPath(values: number[], maximum: number) {
  const line = linePath(values, maximum);
  return `${line} L720 220 L0 220 Z`;
}

function formatCount(value: number) {
  return integer.format(value);
}

export default async function DashboardPage() {
  const { user } = await requirePermission("dashboard.view");
  const pool = getPool();
  const today = almatyToday();
  const weekStart = shiftDate(today, -6);
  const hasAttendance = can(user.role, "attendance.manage") && await attendanceSchemaReady(pool);
  const [migrations, summary, outbox, attendance, requests, bookings, requestTrend, bookingTrend, recentRequests, attendanceTrend] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM bb.schema_migrations ORDER BY name DESC"),
    can(user.role, "catalog.view") ? catalogSummary(pool) : Promise.resolve(null),
    can(user.role, "contacts.view") ? outboxStats(pool) : Promise.resolve(null),
    hasAttendance ? dayFigures(pool, { id: user.id, role: user.role }, today) : Promise.resolve(can(user.role, "attendance.manage") ? "outdated" as const : null),
    can(user.role, "requests.manage")
      ? pool.query<{ status: string; total: number }>("SELECT status, count(*)::int AS total FROM bb.lead_requests GROUP BY status")
      : Promise.resolve(null),
    can(user.role, "bookings.manage")
      ? pool.query<{ booked: number; blocked: number; capacity: number }>(
          `SELECT count(*) FILTER (WHERE kind = 'booking')::int AS booked,
                  count(*) FILTER (WHERE kind = 'block')::int AS blocked,
                  (SELECT count(*)::int FROM bb.rooms WHERE is_active) * (SELECT count(*)::int FROM bb.time_slots) AS capacity
             FROM bb.slot_reservations WHERE slot_date = $1 AND released_at IS NULL`,
          [today],
        )
      : Promise.resolve(null),
    can(user.role, "requests.manage")
      ? pool.query<TrendRow>(
          `SELECT to_char(g.day, 'YYYY-MM-DD') AS date, COALESCE(r.total, 0)::int AS total
             FROM generate_series($1::date, $2::date, interval '1 day') AS g(day)
             LEFT JOIN (
               SELECT (created_at AT TIME ZONE 'Asia/Almaty')::date AS day, count(*)::int AS total
                 FROM bb.lead_requests
                WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Almaty')
                  AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')
                GROUP BY 1
             ) r ON r.day = g.day::date ORDER BY g.day`,
          [weekStart, today],
        )
      : Promise.resolve(null),
    can(user.role, "bookings.manage")
      ? pool.query<TrendRow>(
          `SELECT to_char(g.day, 'YYYY-MM-DD') AS date, COALESCE(r.total, 0)::int AS total
             FROM generate_series($1::date, $2::date, interval '1 day') AS g(day)
             LEFT JOIN (
               SELECT slot_date AS day, count(*)::int AS total
                 FROM bb.slot_reservations
                WHERE kind = 'booking' AND released_at IS NULL AND slot_date BETWEEN $1::date AND $2::date
                GROUP BY slot_date
             ) r ON r.day = g.day::date ORDER BY g.day`,
          [weekStart, today],
        )
      : Promise.resolve(null),
    can(user.role, "requests.manage")
      ? pool.query<RequestRow>(
          `SELECT l.id, l.status, c.name, c.phone_e164 AS phone, l.created_at AS "createdAt",
                  p.name AS "packageName", l.children
             FROM bb.lead_requests l
             JOIN bb.contacts c ON c.id = l.contact_id
             LEFT JOIN bb.packages p ON p.id = l.package_id
            ORDER BY l.created_at DESC, l.seq DESC LIMIT 5`,
        )
      : Promise.resolve(null),
    hasAttendance ? attendanceSeries(pool, { id: user.id, role: user.role }, weekStart, today) : Promise.resolve(null),
  ]);

  const timestamp = new Date();
  const activePackages = summary?.packages.filter((item) => item.isActive) ?? [];
  const activeRooms = summary?.rooms.filter((room) => room.isActive) ?? [];
  const pricePackages = activePackages.filter((item) => item.basePrice != null);
  const maxPrice = Math.max(1, ...pricePackages.map((item) => item.basePrice ?? 0));
  const statusTotals = new Map(requests?.rows.map((row) => [row.status, row.total]) ?? []);
  const newRequests = statusTotals.get("new") ?? 0;
  const inProgressRequests = statusTotals.get("in_progress") ?? 0;
  const confirmedRequests = (statusTotals.get("confirmed") ?? 0) + (statusTotals.get("booked") ?? 0) + (statusTotals.get("paid") ?? 0);
  const requestCount = requests?.rows.reduce((sum, row) => sum + row.total, 0) ?? 0;
  const otherRequests = Math.max(0, requestCount - newRequests - inProgressRequests - confirmedRequests);
  const todayBookings = bookings?.rows[0];
  const now = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE }).format(timestamp);
  const trend = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(weekStart, index);
    return {
      date,
      requests: Number(requestTrend?.rows[index]?.total ?? 0),
      bookings: Number(bookingTrend?.rows[index]?.total ?? 0),
      visits: attendanceTrend ? attendanceTrend[index]?.childrenEntered ?? 0 : 0,
    };
  });
  const maxTrend = Math.max(4, ...trend.flatMap((row) => [row.requests, row.visits]));
  const maxBookings = Math.max(4, ...trend.map((row) => row.bookings));
  const requestLine = linePath(trend.map((row) => row.requests), maxTrend);
  const visitLine = linePath(trend.map((row) => row.visits), maxTrend);
  const requestArea = areaPath(trend.map((row) => row.requests), maxTrend);
  const statusTotal = Math.max(1, requestCount);
  const statusGradient = requests
    ? `conic-gradient(#7046c2 0 ${newRequests / statusTotal * 100}%, #9c7bd3 ${newRequests / statusTotal * 100}% ${(newRequests + inProgressRequests) / statusTotal * 100}%, #c7b7e2 ${(newRequests + inProgressRequests) / statusTotal * 100}% ${(newRequests + inProgressRequests + confirmedRequests) / statusTotal * 100}%, #e5dfed ${(newRequests + inProgressRequests + confirmedRequests + otherRequests) / statusTotal * 100}% 100%)`
    : "conic-gradient(#eee8f3 0 100%)";
  const metrics: Array<{ label: string; value: string; note: string; href: string; icon: FlaticonIconName }> = [];

  if (requests) metrics.push({ label: "Новые заявки", value: formatCount(newRequests), note: "Ожидают ответа", href: "/requests?status=new", icon: "inbox" });
  if (requests) metrics.push({ label: "В работе", value: formatCount(inProgressRequests), note: "Открытые обращения", href: "/requests?status=in_progress", icon: "ticket" });
  if (todayBookings) metrics.push({ label: "Брони сегодня", value: `${formatCount(todayBookings.booked)} / ${formatCount(todayBookings.capacity)}`, note: `Заблокировано слотов: ${todayBookings.blocked}`, href: "/bookings", icon: "calendar" });
  if (attendance && attendance !== "outdated") metrics.push({ label: "Детей вошло сегодня", value: formatCount(attendance.childrenEntered), note: `Ожидается: ${attendance.childrenExpected}`, href: "/attendance", icon: "users" });

  return (
    <div className="crm-dashboard">
      <header className="page-heading crm-dashboard-heading">
        <div>
          <p className="eyebrow">Рабочее пространство <span aria-hidden="true">/</span> Алматы</p>
          <h1>
            Добрый день, {user.name}
            <span className="greeting-illustration"><Image src="/illustrations/milano-hello.svg" alt="" width={52} height={52} priority /></span>
          </h1>
          <p>Заявки, бронирования и посещаемость одного филиала.</p>
          <time className="crm-dashboard-date" dateTime={timestamp.toISOString()}>{now}</time>
        </div>
        <div className="heading-actions">
          {canExport(user) ? <Link className="button button-secondary" href="/export"><FlaticonIcon name="download" size={15} />Выгрузка</Link> : null}
          {can(user.role, "requests.manage") ? <Link className="button button-primary" href="/requests">Все заявки</Link> : null}
        </div>
      </header>

      {metrics.length ? (
        <>
          <div className="section-toolbar">
            <div><span className="section-eyebrow">Сегодня / CRM</span><h2>Показатели филиала</h2></div>
            <span className="crm-branch-label"><i /> Алматы · один филиал</span>
          </div>
          <section className="metrics-grid" aria-label="Показатели филиала сегодня">
            {metrics.map((metric, index) => (
              <Link className={`metric-card metric-card-purple metric-card-${index + 1}`} href={metric.href} key={metric.label}>
                <span className="metric-top">
                  <span>{metric.label}</span>
                  <span className="metric-icon"><FlaticonIcon name={metric.icon} size={16} /></span>
                </span>
                <strong className="metric-value">{metric.value}</strong>
                <span className="metric-bottom">{metric.note}</span>
              </Link>
            ))}
          </section>
        </>
      ) : null}

      <div className="content-grid first-row">
        {(requestTrend || attendanceTrend) ? (
          <section className="panel revenue-panel" aria-labelledby="trend-title">
            <div className="panel-heading">
              <div><span className="section-eyebrow">Последние 7 дней</span><h2 id="trend-title">Заявки и посещаемость</h2></div>
            </div>
            <div className="chart-legend">
              {requestTrend ? <span><i className="legend-dot purple-dot" /> Заявки: {formatCount(trend.reduce((sum, row) => sum + row.requests, 0))}</span> : null}
              {attendanceTrend ? <span><i className="legend-dot light-dot" /> Посещения: {formatCount(trend.reduce((sum, row) => sum + row.visits, 0))}</span> : null}
            </div>
            <div className="line-chart-wrap">
              <div className="y-axis" aria-hidden="true">
                {[1, .75, .5, .25, 0].map((step) => <span key={step}>{Math.round(maxTrend * step)}</span>)}
              </div>
              <svg className="line-chart" viewBox="0 0 720 230" role="img" aria-label="Количество заявок и посещений по дням за неделю">
                <defs><linearGradient id="crm-chart-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7046c2" stopOpacity=".22" /><stop offset="1" stopColor="#7046c2" stopOpacity="0" /></linearGradient></defs>
                <g className="chart-grid">{[0, 55, 110, 165, 220].map((y) => <path d={`M0 ${y}H720`} key={y} />)}</g>
                {requestTrend ? <path className="chart-area" d={requestArea} /> : null}
                {attendanceTrend ? <path className="chart-compare" d={visitLine} /> : null}
                {requestTrend ? <path className="chart-primary" d={requestLine} /> : null}
              </svg>
              <div className="x-axis">{trend.map((row) => <span key={row.date}>{dateLabel.format(new Date(`${row.date}T00:00:00Z`))}</span>)}</div>
            </div>
          </section>
        ) : null}

        {requests ? (
          <section className="panel donut-panel" aria-labelledby="requests-status-title">
            <div className="panel-heading">
              <div><span className="section-eyebrow">Рабочая очередь</span><h2 id="requests-status-title">Статусы заявок</h2></div>
            </div>
            <div className="donut-content">
              <div className="donut-chart" role="img" aria-label={`Распределение ${requestCount} заявок по статусам`} style={{ background: statusGradient }}>
                <div className="donut-inner"><strong>{formatCount(requestCount)}</strong><span>всего</span></div>
              </div>
              <div className="donut-list">
                <div><i className="donut-key purple-key" /><span>Новые</span><strong>{formatCount(newRequests)}</strong></div>
                <div><i className="donut-key lilac-key" /><span>В работе</span><strong>{formatCount(inProgressRequests)}</strong></div>
                <div><i className="donut-key pale-key" /><span>Подтверждены</span><strong>{formatCount(confirmedRequests)}</strong></div>
                <div><i className="donut-key muted-key" /><span>Прочие статусы</span><strong>{formatCount(otherRequests)}</strong></div>
              </div>
            </div>
            <Link className="panel-footer-link" href="/requests">Открыть очередь <span aria-hidden="true">↗</span></Link>
          </section>
        ) : null}
      </div>

      <div className="content-grid second-row">
        {bookingTrend ? (
          <section className="panel branch-panel" aria-labelledby="booking-week-title">
            <div className="panel-heading"><div><span className="section-eyebrow">Один филиал · Алматы</span><h2 id="booking-week-title">Бронирования по дням</h2></div></div>
            <div className="bar-chart" role="img" aria-label="Активные бронирования по дням за неделю">
              <div className="bar-y" aria-hidden="true">{[1, .66, .33, 0].map((step) => <span key={step}>{Math.round(maxBookings * step)}</span>)}</div>
              <div className="bars">{trend.map((row) => {
                return <div className="bar-column" key={row.date}><div className="bar-value" style={{ height: `${row.bookings / maxBookings * 100}%` }}><i /></div><span>{dateLabel.format(new Date(`${row.date}T00:00:00Z`))}</span></div>;
              })}</div>
            </div>
          </section>
        ) : null}

        <section className="panel activity-panel" aria-labelledby="operations-title">
          <div className="panel-heading"><div><span className="section-eyebrow">Состояние сегодня</span><h2 id="operations-title">Рабочие показатели</h2></div></div>
          {attendance === "outdated" ? <p role="alert" className="so-alert">Для отчёта о посещаемости нужна миграция базы 013.</p> : null}
          {attendance && attendance !== "outdated" ? (
            <dl className="crm-dashboard-stats">
              <div><dt>Детей вошло</dt><dd>{formatCount(attendance.childrenEntered)}</dd></div>
              <div><dt>Взрослых по QR</dt><dd>{formatCount(attendance.adultsRegistered)}</dd></div>
              <div><dt>Детей ожидается</dt><dd>{formatCount(attendance.childrenExpected)}</dd></div>
            </dl>
          ) : null}
          {outbox ? <div className="crm-dashboard-outbox">
            <div><span>Ожидают уведомления</span><strong>{formatCount(outbox.pending)}</strong></div>
            <div><span>Не доставлены</span><strong data-alert={outbox.dead > 0}>{formatCount(outbox.dead)}</strong></div>
            {outbox.dead ? <p role="alert">Заявки сохранены, но уведомления не доставлены.</p> : null}
          </div> : null}
          {attendance && attendance !== "outdated" ? <Link href="/attendance" className="view-all">Открыть посещаемость <span aria-hidden="true">↗</span></Link> : null}
        </section>
      </div>

      {recentRequests ? (
        <>
          <div className="section-toolbar requests-toolbar">
            <div><span className="section-eyebrow">Рабочая очередь</span><h2>Последние заявки</h2></div>
            <Link className="text-button" href="/requests">Открыть все <span aria-hidden="true">↗</span></Link>
          </div>
          <section className="panel requests-panel" aria-label="Последние заявки">
            <div className="requests-head"><span>Клиент</span><span>Запрос</span><span>Создана</span><span>Статус</span></div>
            {recentRequests.rows.map((request) => (
              <Link className="request-row" href="/requests" key={request.id}>
                <span className="request-client">
                  <span className="request-avatar" aria-hidden="true">{request.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
                  <span><strong>{request.name}</strong><small>{request.phone}</small></span>
                </span>
                <span className="request-type">{request.packageName ?? "Заявка"}{request.children ? ` · ${request.children} гостей` : ""}</span>
                <time className="request-time" dateTime={request.createdAt.toISOString()}>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE }).format(request.createdAt)}</time>
                <span className={`status-pill status-${request.status}`}>{REQUEST_STATUS_LABELS[request.status] ?? request.status}</span>
              </Link>
            ))}
            {recentRequests.rows.length === 0 ? <p className="module-empty">Заявок пока нет. Новые обращения появятся здесь.</p> : null}
          </section>
        </>
      ) : null}

      <div className="content-grid dashboard-footer-grid">
        {summary ? (
          <section className="panel" aria-labelledby="catalog-title">
            <div className="panel-heading"><div><span className="section-eyebrow">Каталог</span><h2 id="catalog-title">Цены активных пакетов</h2></div><span className="panel-caption">{pricePackages.length} с базовой ценой</span></div>
            {pricePackages.length ? <ul className="crm-price-list">{pricePackages.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span className="crm-price-track" role="meter" aria-label={`Базовая цена пакета ${item.name}`} aria-valuemin={0} aria-valuemax={maxPrice} aria-valuenow={item.basePrice ?? 0}><i style={{ width: `${(item.basePrice ?? 0) / maxPrice * 100}%` }} /></span>
                <strong>{kzt.format(item.basePrice ?? 0)} ₸</strong>
              </li>
            ))}</ul> : <p className="crm-empty">В активном каталоге пока нет базовых цен.</p>}
            <dl className="so-catalog-meta"><div><dt>Комнаты</dt><dd>{activeRooms.map((room) => room.name).join(", ") || "—"}</dd></div><div><dt>Слоты</dt><dd>{summary.slots.map((slot) => `${slot.startsAt}–${slot.endsAt}`).join(", ") || "—"}</dd></div></dl>
          </section>
        ) : null}
        <section className="panel" aria-labelledby="system-title">
          <div className="panel-heading"><div><span className="section-eyebrow">Состояние</span><h2 id="system-title">Система и доступ</h2></div></div>
          <div className="so-system-list"><div className="so-system-row"><span>База данных</span><strong className="so-status-ok">Подключена</strong></div><div className="so-system-row"><span>Версия схемы</span><strong>{migrations.rows[0]?.name ?? "—"}</strong></div></div>
          <div className="so-access"><span className="section-eyebrow">Учётная запись</span><ul className="so-access-list">{ACCESS.map((item) => <li key={item.permission} aria-disabled={!can(user.role, item.permission) || undefined}>{item.label}</li>)}</ul></div>
        </section>
      </div>
    </div>
  );
}
