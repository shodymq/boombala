import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { FlaticonIcon } from "@/components/flaticon-icon";
import { listLeads } from "@/core/bookings";
import { listPackages, listRooms, listSlots } from "@/core/catalog";
import { isValidDate } from "@/core/dates";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { DatePicker } from "@/components/date-picker";
import { FastApiCrmClient, unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import { confirmLeadAction, leadStatusAction } from "./actions";

export const metadata: Metadata = { title: "Заявки" };

const LEGACY_STATUS: Record<string, string> = {
  new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена",
};
const FASTAPI_STATUS: Record<string, string> = {
  new: "Новая", contacted: "Связались", qualified: "Квалифицирована", booked: "Забронирована",
  paid: "Оплачена", completed: "Завершена", lost: "Потеряна", in_progress: "В работе",
  confirmed: "Подтверждена", cancelled: "Отменена", closed: "Закрыта",
};
const NOTICES: Record<string, string> = { status: "Статус изменён." };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят. Выберите другую комнату или время.",
  invalid: "Проверьте дату, слот, комнату и пакет (у пакета должна быть цена; прошедший слот занять нельзя).",
  conflict: "Заявка уже обработана.", forbidden: "Недостаточно прав.",
  fastapi_unavailable: "FastAPI CRM недоступна. Данные из старой базы не показаны.",
};
const input = "crm-requests-control";
const btn = "crm-requests-action";
const btnGhost = "crm-requests-action crm-requests-action-secondary";

type RequestItem = {
  id: string;
  label: string;
  status: string;
  name: string;
  phone: string;
  createdAt: Date;
  requestedDate: string | null;
  packageName: string;
  children: number | null;
  packageId: string | null;
  roomId: string | null;
  slotId: number | null;
  reservationId: string | null;
  source?: string;
  branch?: string;
  summary?: string;
};

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; createdFrom?: string; createdTo?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("requests.manage");
  const sp = await searchParams;
  const unified = unifiedFastapiCrmEnabled();
  const statusLabels = unified ? FASTAPI_STATUS : LEGACY_STATUS;
  const status = sp.status && statusLabels[sp.status] ? sp.status : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const createdFrom = sp.createdFrom && isValidDate(sp.createdFrom) ? sp.createdFrom : undefined;
  const createdTo = sp.createdTo && isValidDate(sp.createdTo) ? sp.createdTo : undefined;
  const hasFilters = Boolean(status || q || createdFrom || createdTo);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  let leads: RequestItem[] = [];
  let loadError = false;
  let packages: Awaited<ReturnType<typeof listPackages>> = [];
  let rooms: Awaited<ReturnType<typeof listRooms>> = [];
  let slots: Awaited<ReturnType<typeof listSlots>> = [];

  if (unified) {
    try {
      const requestId = randomUUID();
      const actor = await fastApiActorForStaff({ id: user.id, email: user.email, role: user.role }, { requestId });
      const response = await new FastApiCrmClient(actor).listLeads({ status, q, createdFrom, createdTo });
      leads = response.items.map((lead) => ({
        id: lead.id,
        label: `ID ${lead.id.slice(0, 8)}`,
        status: lead.status,
        name: lead.customerName,
        phone: lead.phone,
        createdAt: new Date(lead.createdAt),
        requestedDate: lead.requestedDate,
        packageName: lead.package?.name ?? "не выбран",
        children: lead.guestCount,
        packageId: lead.package?.id ?? null,
        roomId: null,
        slotId: null,
        reservationId: null,
        source: lead.source,
        branch: lead.branch?.name,
        summary: lead.summary,
      }));
    } catch {
      loadError = true;
    }
  } else {
    const actor = { id: user.id, role: user.role };
    const pool = getPool();
    const [legacyLeads, loadedPackages, loadedRooms, loadedSlots] = await Promise.all([
      listLeads(pool, actor, { status, q, createdFrom, createdTo }), listPackages(pool), listRooms(pool), listSlots(pool),
    ]);
    packages = loadedPackages;
    rooms = loadedRooms;
    slots = loadedSlots;
    leads = legacyLeads.map((lead) => ({
      id: lead.id,
      label: `№${lead.seq}`,
      status: lead.status,
      name: lead.name,
      phone: lead.phone,
      createdAt: new Date(lead.createdAt),
      requestedDate: lead.requestedDate,
      packageName: packages.find((item) => item.id === lead.packageId)?.name ?? "не выбран",
      children: lead.children,
      packageId: lead.packageId,
      roomId: lead.roomId,
      slotId: lead.slotId,
      reservationId: lead.reservationId,
    }));
  }

  function statusHref(nextStatus?: string) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    if (nextStatus) params.set("status", nextStatus);
    const query = params.toString();
    return query ? `/requests?${query}` : "/requests";
  }

  return (
    <div className="crm-page crm-requests-page">
      <header className="crm-requests-heading">
        <div>
          <p className="crm-eyebrow">Входящий поток</p>
          <h1 className="crm-page-title">Заявки</h1>
          <p className="crm-page-subtitle">{unified ? "Актуальные обращения из FastAPI." : "Рабочая очередь обращений филиала."}</p>
        </div>
        <p className="crm-requests-count" aria-live="polite">Показано: <strong>{loadError ? "—" : leads.length}</strong></p>
      </header>

      <p className="crm-requests-note">
        {unified
          ? "Открой карточку, чтобы обработать заявку, записать фактически полученную предоплату и подтвердить бронь."
          : "Заявка не занимает слот. Слот занимает только подтверждение. Цена фиксируется в момент подтверждения."}
      </p>
      {loadError ? <p role="alert" className="crm-requests-message crm-requests-message-error">FastAPI CRM недоступна. Данные из старой базы не показаны.</p> : null}
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="crm-requests-message crm-requests-message-error">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav className="crm-requests-tabs" aria-label="Фильтр заявок по статусу">
        <Link href={statusHref()} aria-current={!status ? "page" : undefined}>Все</Link>
        {Object.entries(statusLabels).map(([key, label]) => (
          <Link key={key} href={statusHref(key)} aria-current={status === key ? "page" : undefined}>{label}</Link>
        ))}
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
          <button type="submit" className={btn}><FlaticonIcon name="search" size={15} className="crm-action-icon" />Найти заявки</button>
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
            {leads.map((lead) => {
              const open = lead.status === "new" || lead.status === "in_progress";
              return (
                <tr key={lead.id}>
                  <td>
                    <span className="crm-requests-mobile-label">Клиент</span>
                    <div className="crm-requests-contact">
                      <strong>{lead.name}</strong>
                      <span>{lead.phone}</span>
                      <small>{lead.label}</small>
                    </div>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Детали заявки</span>
                    <div className="crm-requests-details">
                      <span>Дата: {lead.requestedDate ?? "не указана"}</span>
                      <span>Пакет: {lead.packageName}</span>
                      {lead.children != null ? <span>Гостей: {lead.children}</span> : null}
                      {lead.source ? <span>Источник: {lead.source}</span> : null}
                      {lead.branch ? <span>Филиал: {lead.branch}</span> : null}
                      {lead.summary ? <span className="crm-requests-summary">{lead.summary}</span> : null}
                      {lead.reservationId && lead.requestedDate ? <Link href={`/bookings?date=${lead.requestedDate}`}>Показать в календаре</Link> : null}
                    </div>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Создана</span>
                    <time dateTime={lead.createdAt.toISOString()}>{fmt.format(lead.createdAt)}</time>
                  </td>
                  <td>
                    <span className="crm-requests-mobile-label">Статус</span>
                    <span className="crm-requests-status" data-status={lead.status}>{statusLabels[lead.status] ?? lead.status}</span>
                  </td>
                  <td className="crm-requests-actions-cell">
                    <span className="crm-requests-mobile-label">Действия</span>
                    {unified ? (
                      <Link href={`/requests/${encodeURIComponent(lead.id)}`} className="crm-requests-action">Открыть карточку</Link>
                    ) : open ? (
                      <div className="crm-requests-row-actions">
                        <form action={confirmLeadAction} className="crm-requests-confirm-form">
                          <input type="hidden" name="id" value={lead.id} />
                          <DatePicker name="date" label={`Дата брони для заявки ${lead.label}`} defaultValue={lead.requestedDate ?? ""} required allowClear={false} />
                          <label className="crm-requests-sr-only" htmlFor={`slot-${lead.id}`}>Время для заявки {lead.label}</label>
                          <select id={`slot-${lead.id}`} name="slotId" defaultValue={lead.slotId ?? ""} required className={input}>
                            <option value="" disabled>Слот</option>
                            {slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.startsAt}–{slot.endsAt}</option>)}
                          </select>
                          <label className="crm-requests-sr-only" htmlFor={`room-${lead.id}`}>Комната для заявки {lead.label}</label>
                          <select id={`room-${lead.id}`} name="roomId" defaultValue={lead.roomId ?? ""} required className={input}>
                            <option value="" disabled>Комната</option>
                            {rooms.filter((room) => room.isActive).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                          </select>
                          <label className="crm-requests-sr-only" htmlFor={`package-${lead.id}`}>Пакет для заявки {lead.label}</label>
                          <select id={`package-${lead.id}`} name="packageId" defaultValue={lead.packageId ?? ""} required className={input}>
                            <option value="" disabled>Пакет</option>
                            {packages.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select>
                          <button type="submit" className={btn}>Подтвердить бронь</button>
                        </form>
                        <div className="crm-requests-status-actions">
                          {lead.status === "new" ? <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="in_progress" /><button type="submit" className={btnGhost}>В работу</button></form> : null}
                          <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="cancelled" /><button type="submit" className={btnGhost}>Отклонить</button></form>
                        </div>
                      </div>
                    ) : <span className="crm-requests-no-action">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {leads.length === 0 && !loadError ? (
          <div className="crm-requests-empty" role="status">
            <Image src="/illustrations/milano-asking-question.svg" alt="" width={96} height={96} />
            <p>{hasFilters ? "По этим условиям заявок нет. Измените фильтры или сбросьте поиск." : "Заявок пока нет. Новые обращения появятся здесь."}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
