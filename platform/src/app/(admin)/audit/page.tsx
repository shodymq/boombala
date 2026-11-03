import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { isValidDate } from "@/core/dates";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { DatePicker } from "@/components/date-picker";
import { FastApiCrmClient, unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";

export const metadata: Metadata = { title: "Журнал действий" };

interface Row {
  id: string;
  at: Date;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  before: unknown;
  after: unknown;
}

const ACTION: Record<string, string> = {
  "attendance.confirmed": "Подтвердил вход по QR",
  "attendance.corrected": "Исправил отметку о посещении",
  "attendance.manual": "Отметил ручной вход",
  "auth.login": "Вошёл в систему",
  "auth.login_failed": "Неудачная попытка входа",
  "auth.mfa_failed": "Неудачная проверка второго фактора",
  "auth.password_verified": "Подтвердил пароль",
  "block.created": "Заблокировал слот",
  "booking.confirmed": "Подтвердил бронь",
  "booking.created_manual": "Создал бронь вручную",
  "booking.blocked": "Заблокировал время брони",
  "booking.released": "Освободил бронь",
  "booking.rescheduled": "Перенёс бронь",
  "catalog.seeded": "Загрузил каталог",
  "consent.registered": "Зарегистрировал согласие",
  "consent.revoked": "Отозвал согласие",
  "contact.anonymized": "Обезличил данные клиента",
  "contacts.exported": "Выгрузил клиентскую базу",
  "lead.created": "Получил заявку",
  "lead.status_changed": "Изменил статус заявки",
  "lead.loss_reason_changed": "Изменил причину закрытия заявки",
  "lead.note_changed": "Изменил внутреннюю заметку заявки",
  "legal.approved": "Утвердил документ",
  "legal.draft_created": "Создал черновик документа",
  "legal.draft_updated": "Изменил черновик документа",
  "legal.published": "Опубликовал документ",
  "legal.retired": "Снял документ с публикации",
  "mfa.enrolled": "Включил второй фактор",
  "mfa.recovery_used": "Использовал код восстановления",
  "mfa.reset": "Сбросил второй фактор",
  "news.created": "Создал публикацию",
  "news.deleted": "Удалил публикацию",
  "news.image_added": "Загрузил изображение",
  "news.image_deleted": "Удалил изображение",
  "news.published": "Опубликовал новость или акцию",
  "news.unpublished": "Снял новость или акцию с публикации",
  "news.updated": "Изменил публикацию",
  "payment.recorded": "Записал факт оплаты",
  "price.set": "Изменил цену",
  "refund.recorded": "Записал факт возврата",
  "retention.run": "Выполнил обезличивание по сроку хранения",
  "retention.settings_changed": "Изменил настройки хранения данных",
  "user.created": "Создал учетную запись сотрудника",
  "user.export_permission_changed": "Изменил право на выгрузку",
  "user.password_changed": "Изменил пароль сотрудника",
  "user.role_changed": "Изменил роль сотрудника",
};
const CRM_ONLY_ACTIONS = ["booking.blocked", "booking.released", "booking.rescheduled", "payment.recorded", "refund.recorded"];

const ENTITY: Record<string, string> = {
  attendance_entry: "посещение",
  booking: "бронь",
  contact: "клиент",
  consent_registration: "согласие",
  legal_document: "документ",
  lead: "заявка",
  lead_request: "заявка",
  news_image: "изображение",
  news_post: "публикация",
  payment: "оплата",
  refund: "возврат",
  retention_settings: "настройки хранения",
  slot_reservation: "бронь",
  user: "сотрудник",
};

const FIELD: Record<string, string> = {
  canExport: "Выгрузка",
  adminNoteChanged: "Внутренняя заметка",
  amountKzt: "Сумма, ₸",
  bookingDate: "Дата брони",
  children: "Детей",
  kind: "Тип",
  left: "Осталось кодов восстановления",
  mfa: "Второй фактор",
  method: "Способ",
  reason: "Причина",
  receivedAt: "Получено",
  refundedAt: "Возвращено",
  roomId: "Комната",
  slotId: "Слот",
  processed: "Обработано записей",
  qrMonths: "Срок хранения, мес.",
  role: "Роль",
  sessionsEnded: "Завершено сессий",
  skipped: "Пропущено записей",
  slug: "Адрес страницы",
  status: "Статус",
  version: "Редакция",
};

const VALUE: Record<string, Record<string, string>> = {
  adminNoteChanged: { true: "изменена" },
  canExport: { true: "разрешена", false: "запрещена" },
  reason: {
    changed_mind: "передумал",
    chose_competitor: "выбрал другое место",
    date_unavailable: "нет подходящей даты",
    duplicate: "дубликат",
    no_answer: "не удалось связаться",
    no_response: "не удалось связаться",
    other: "другая причина",
    other_branch: "выбрал другой филиал",
    price: "не подошла цена",
    too_expensive: "дорого",
  },
  kind: {
    companion_duties: "обязанности сопровождающего",
    group_visits: "групповые посещения",
    news: "новость",
    personal_data_consent: "согласие на обработку данных",
    privacy_policy: "политика обработки данных",
    promo: "акция",
    third_party_escort: "сопровождение третьим лицом",
    visit_rules: "правила посещения",
  },
  mfa: { true: "включён", false: "выключен" },
  method: {
    bank_transfer: "банковский перевод",
    card_terminal: "терминал",
    cash: "наличные",
    manual: "вручную",
    other_manual: "другой ручной способ",
    qr: "по QR",
  },
  role: { editor: "редактор", manager: "менеджер", owner: "владелец" },
  status: {
    archived: "снята с публикации",
    cancelled: "отменена",
    completed: "завершена",
    confirmed: "подтверждена",
    draft: "черновик",
    in_progress: "в работе",
    new: "новая",
    published: "опубликована",
  },
};

function detailText(before: unknown, after: unknown): string | null {
  const oldValues = before && typeof before === "object" && !Array.isArray(before) ? before as Record<string, unknown> : {};
  const newValues = after && typeof after === "object" && !Array.isArray(after) ? after as Record<string, unknown> : {};
  const keys = [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])];
  const parts = keys.flatMap((key) => {
    const label = FIELD[key];
    if (!label) return [];
    const format = (value: unknown) => {
      const text = String(value);
      return VALUE[key]?.[text] ?? text;
    };
    if (key in oldValues && key in newValues && oldValues[key] !== newValues[key]) {
      return [`${label}: ${format(oldValues[key])} → ${format(newValues[key])}`];
    }
    if (key in newValues) return [`${label}: ${format(newValues[key])}`];
    return [`${label}: ${format(oldValues[key])}`];
  });
  return parts.length ? parts.join(" · ") : null;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; userId?: string; action?: string; from?: string; to?: string }> }) {
  const { user } = await requirePermission("audit.view");
  const sp = await searchParams;
  const pool = getPool();
  const usersResult = await pool.query<{ id: string; name: string }>("SELECT id, name FROM bb.users ORDER BY name");
  const users = usersResult.rows;
  const actions = Object.keys(ACTION).filter((event) => !CRM_ONLY_ACTIONS.includes(event)).sort();
  const userId = sp.userId === "system" || users.some((user) => user.id === sp.userId) ? sp.userId : undefined;
  const action = actions.includes(sp.action ?? "") ? sp.action : undefined;
  const from = sp.from && isValidDate(sp.from) ? sp.from : undefined;
  const to = sp.to && isValidDate(sp.to) ? sp.to : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  if (userId === "system") conditions.push("a.actor_user_id IS NULL");
  else if (userId) conditions.push(`a.actor_user_id = ${addParam(userId)}`);
  if (action) conditions.push(`a.action = ${addParam(action)}`);
  if (from) conditions.push(`a.at >= (${addParam(from)}::date::timestamp AT TIME ZONE 'Asia/Almaty')`);
  if (to) conditions.push(`a.at < ((${addParam(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')`);
  if (q) {
    const query = addParam(`%${q}%`);
    conditions.push(`(coalesce(u.name, '') ILIKE ${query} OR coalesce(a.entity_id::text, '') ILIKE ${query})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query<Row>(
    `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, u.name AS actor, a.before, a.after
       FROM bb.audit_log a LEFT JOIN bb.users u ON u.id = a.actor_user_id
       ${where} ORDER BY a.id DESC LIMIT 200`,
    params,
  );
  const crmEnabled = unifiedFastapiCrmEnabled();
  let crmAudit: Awaited<ReturnType<FastApiCrmClient["listBirthdayBookingAudit"]>> = [];
  let crmAuditError = false;
  if (crmEnabled) {
    try {
      const requestId = randomUUID();
      const actor = await fastApiActorForStaff({ id: user.id, email: user.email, role: user.role }, { requestId });
      crmAudit = await new FastApiCrmClient(actor).listBirthdayBookingAudit();
    } catch {
      crmAuditError = true;
    }
  }
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Almaty" });

  return (
    <div className="crm-page">
      <header>
        <p className="crm-eyebrow">История системы</p>
        <h1 className="crm-page-title">Журнал действий</h1>
        <p className="crm-page-subtitle">Кто, что и когда сделал. Журнал нельзя изменить или удалить.</p>
      </header>
      <form method="get" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
        <input name="q" defaultValue={q ?? ""} maxLength={80} placeholder="Имя сотрудника или ID объекта" className="h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none" aria-label="Поиск по сотруднику или ID объекта" />
        <select name="userId" defaultValue={userId ?? ""} className="h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink" aria-label="Сотрудник">
          <option value="">Все сотрудники</option>
          <option value="system">Система</option>
          {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select>
        <select name="action" defaultValue={action ?? ""} className="h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink" aria-label="Тип события">
          <option value="">Все действия</option>
          {actions.map((event) => <option key={event} value={event}>{ACTION[event] ?? event}</option>)}
        </select>
        <label className="grid gap-1 text-xs font-bold text-muted">С даты<DatePicker key={`${from ?? ""}:${to ?? ""}`} name="from" label="С даты" defaultValue={from ?? ""} /></label>
        <label className="grid gap-1 text-xs font-bold text-muted">По дату<DatePicker key={`${from ?? ""}:${to ?? ""}`} name="to" label="По дату" defaultValue={to ?? ""} /></label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600">Найти</button>
          <Link href="/audit" className="inline-flex h-11 items-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700">Сбросить</Link>
        </div>
      </form>
      <p className="text-xs text-muted">Показаны последние 200 записей по выбранным условиям.</p>
      <div className="overflow-x-auto rounded-3xl border border-line bg-white">
        {rows.length ? (
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-grape-50 text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Время (Алматы)</th>
                <th className="px-3 py-2 font-semibold">Кто</th>
                <th className="px-3 py-2 font-semibold">Действие</th>
                <th className="px-3 py-2 font-semibold">Объект</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const details = detailText(row.before, row.after);
                return (
                  <tr key={row.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmt.format(row.at)}</td>
                    <td className="px-3 py-2">{row.actor ?? "Система"}</td>
                    <td className="px-3 py-2 font-bold">{ACTION[row.action] ?? row.action.replace(/[._]/g, " ")}</td>
                    <td className="px-3 py-2 text-muted">
                      {row.entity_type ? ENTITY[row.entity_type] ?? row.entity_type : "—"}{row.entity_id ? ` · №${row.entity_id.slice(0, 8)}` : ""}
                      {details ? <span className="block text-xs">{details}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="crm-empty-state m-4 rounded-2xl border border-line p-4 text-sm text-muted">По этим условиям записей нет.</p>
        )}
      </div>
      <section className="grid gap-3" aria-labelledby="crm-audit-heading">
        <header>
          <h2 id="crm-audit-heading" className="text-xl font-extrabold text-ink">События CRM FastAPI</h2>
          <p className="text-xs text-muted">Последние 100 событий заявок, бронирования, оплат и возвратов. Фильтры выше применяются к журналу платформы.</p>
        </header>
        {!crmEnabled ? (
          <p className="crm-empty-state rounded-2xl border border-line p-4 text-sm text-muted">События CRM FastAPI появятся после включения интеграции.</p>
        ) : crmAuditError ? (
          <p className="crm-detail-message crm-detail-message-error" role="alert">Не удалось загрузить журнал событий CRM FastAPI. Журнал платформы показан отдельно.</p>
        ) : crmAudit.length ? (
          <div className="overflow-x-auto rounded-3xl border border-line bg-white">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="bg-grape-50 text-muted"><tr><th className="px-3 py-2 font-semibold">Время (Алматы)</th><th className="px-3 py-2 font-semibold">Кто</th><th className="px-3 py-2 font-semibold">Действие</th><th className="px-3 py-2 font-semibold">Объект</th></tr></thead>
              <tbody>{crmAudit.map((event) => {
                const details = detailText(event.before, event.after);
                return <tr key={`${event.entityType}:${event.id}`} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmt.format(new Date(event.createdAt))}</td>
                  <td className="px-3 py-2">{event.actorName}</td>
                  <td className="px-3 py-2 font-bold">{ACTION[event.action] ?? event.action.replace(/[._]/g, " ")}</td>
                  <td className="px-3 py-2 text-muted">{ENTITY[event.entityType] ?? event.entityType} · №{(event.requestId ?? event.entityId).slice(0, 8)}{details ? <span className="block text-xs">{details}</span> : null}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : (
          <p className="crm-empty-state rounded-2xl border border-line p-4 text-sm text-muted">Событий CRM пока нет.</p>
        )}
      </section>
    </div>
  );
}
