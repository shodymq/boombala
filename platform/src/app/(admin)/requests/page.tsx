import type { Metadata } from "next";
import { BrandArt } from "@/components/brand-art";
import Link from "next/link";
import { cookies } from "next/headers";
import { listPackages } from "@/core/catalog";
import { isValidDate } from "@/core/dates";
import { DatePicker } from "@/components/date-picker";
import { Icon } from "@/components/icon";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { SESSION_COOKIE } from "@/server/env";
import { loadLeadPage } from "@/server/lead-data";
import { leadStatusAction } from "./actions";

export const metadata: Metadata = { title: "Заявки" };

const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };
const NOTICES: Record<string, string> = { status: "Статус изменён." };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят. Выберите другую комнату или время.",
  invalid: "Проверьте дату, слот, комнату и пакет (у пакета должна быть цена; прошедший слот занять нельзя).",
  conflict: "Заявка уже обработана.", forbidden: "Недостаточно прав.",
};
const input = "crm-requests-control";
const btn = "crm-requests-action";
const btnGhost = "crm-requests-action crm-requests-action-secondary";

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; createdFrom?: string; createdTo?: string; page?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("requests.manage");
  const sp = await searchParams;
  const status = sp.status && STATUS[sp.status] ? sp.status : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const createdFrom = sp.createdFrom && isValidDate(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && isValidDate(sp.createdTo) ? sp.createdTo : undefined;
  const hasFilters = Boolean(status || q || createdFrom || createdTo);
  const page = Math.max(Math.trunc(Number(sp.page)) || 1, 1);
  const actor = { id: user.id, role: user.role };
  let packages: Awaited<ReturnType<typeof listPackages>>;
  if (legacyBridgeEnabled()) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new Error("session_missing");
    packages = (await bridgeRpc<{ packages: Awaited<ReturnType<typeof listPackages>> }>("catalog", {}, token)).packages;
  } else {
    const pool = getPool();
    packages = await listPackages(pool);
  }
  // Search, dates, status and pagination are executed by PostgreSQL (typed bridge operation `requests.search`).
  const result = await loadLeadPage(actor, { status, q, createdFrom, createdTo, page });
  const leads = result.items;
  const pages = Math.max(Math.ceil(result.total / result.pageSize), 1);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const pkgName = (id: string | null) => packages.find((p) => p.id === id)?.name ?? "не выбран";
  function statusHref(next?: string, toPage?: number) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    if (next) params.set("status", next);
    if (toPage && toPage > 1) params.set("page", String(toPage));
    const query = params.toString();
    return query ? `/requests?${query}` : "/requests";
  }

  return (
    <div className="crm-page crm-requests-page">
      <header className="crm-requests-heading">
        <div>
          <p className="crm-eyebrow">Входящий поток</p>
          <h1 className="crm-page-title">Заявки</h1>
          <p className="crm-page-subtitle">Рабочая очередь обращений филиала.</p>
        </div>
        <p className="crm-requests-count" aria-live="polite">Всего: <strong>{result.total}</strong></p>
      </header>
      <p className="crm-requests-note">Заявка не занимает слот. Слот занимает только подтверждение. Цена фиксируется в момент подтверждения.</p>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="crm-requests-message crm-requests-message-error">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav className="crm-requests-tabs" aria-label="Фильтр заявок по статусу">
        <Link href={statusHref()} aria-current={!status ? "page" : undefined}>Все</Link>
        {Object.entries(STATUS).map(([k, v]) => <Link key={k} href={statusHref(k)} aria-current={status === k ? "page" : undefined}>{v}</Link>)}
      </nav>

      <form method="get" className="crm-requests-filters">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label className="crm-requests-search">
          <span>Поиск</span>
          <input name="q" defaultValue={q ?? ""} placeholder="Имя или телефон" maxLength={80} className={input} />
        </label>
        <label>
          <span>С даты заявки</span>
          <DatePicker key={`${createdFrom ?? ""}:${createdTo ?? ""}`} name="createdFrom" label="С даты заявки" defaultValue={createdFrom ?? ""} />
        </label>
        <label>
          <span>По дату заявки</span>
          <DatePicker key={`${createdFrom ?? ""}:${createdTo ?? ""}`} name="createdTo" label="По дату заявки" defaultValue={createdTo ?? ""} />
        </label>
        <div className="crm-requests-filter-actions">
          <button type="submit" className={`${btn} inline-flex items-center gap-2`}><Icon name="search" size={15} className="crm-action-icon" />Найти заявки</button>
          <Link href="/requests" className={btnGhost}>Сбросить</Link>
        </div>
      </form>

      <section className="crm-requests-queue" aria-label="Очередь заявок">
        <table className="crm-requests-table">
          <caption className="crm-requests-sr-only">Список заявок</caption>
          <thead>
            <tr>
              <th scope="col">Клиент</th>
              <th scope="col">Детали заявки</th>
              <th scope="col">Создана</th>
              <th scope="col">Статус</th>
              <th scope="col"><span className="crm-requests-sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const open = l.status === "new" || l.status === "in_progress";
              return (
                <tr key={l.id} data-lead={l.seq}>
                  <td>
                    <span className="crm-requests-mobile-label">Клиент</span>
                    <div className="crm-requests-contact"><strong>{l.name}</strong><span>{l.phone}</span><small>№{l.seq}</small></div>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Детали заявки</span>
                    <div className="crm-requests-details">
                      <span>Дата: {l.requestedDate ?? "не указана"}</span>
                      <span>Пакет: {pkgName(l.packageId)}</span>
                      {l.children != null ? <span>Детей: {l.children}</span> : null}
                      {l.reservationId ? <Link href={`/bookings?date=${l.requestedDate}`}>Показать в календаре</Link> : null}
                    </div>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Создана</span>
                    <time dateTime={l.createdAt.toISOString()}>{fmt.format(l.createdAt)}</time>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Статус</span>
                    <span className="crm-requests-status" data-status={l.status}>{STATUS[l.status] ?? l.status}</span>
                  </td>
                  <td className="crm-requests-actions-cell">
                    <span className="crm-requests-mobile-label">Действия</span>
                    <Link href={`/requests/${encodeURIComponent(l.id)}`} className={btnGhost}>Открыть карточку</Link>
                    {open ? (
                      <div className="crm-requests-status-actions">
                        {l.status === "new" ? <form action={leadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="in_progress" /><button type="submit" className={btnGhost}>В работу</button></form> : null}
                        <form action={leadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="cancelled" /><button type="submit" className={btnGhost}>Отклонить</button></form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {leads.length === 0 ? (
          <p className="crm-requests-empty" role="status">
            {!hasFilters ? <BrandArt className="mx-auto mb-3" size={88} /> : null}
            {hasFilters ? "По этим условиям заявок нет. Измените фильтры или сбросьте поиск." : "Заявок пока нет. Новые обращения появятся здесь."}
          </p>
        ) : null}
        {pages > 1 ? (
          <nav className="crm-requests-pager" aria-label="Страницы заявок">
            {result.page > 1 ? <Link href={statusHref(status, result.page - 1)} rel="prev" className={btnGhost}>← Назад</Link> : null}
            <span aria-live="polite">Страница {result.page} из {pages}</span>
            {result.page < pages ? <Link href={statusHref(status, result.page + 1)} rel="next" className={btnGhost}>Вперёд →</Link> : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
