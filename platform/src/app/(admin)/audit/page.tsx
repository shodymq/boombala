import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { isValidDate } from "@/core/dates";
import { DatePicker } from "@/components/date-picker";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { SESSION_COOKIE } from "@/server/env";

export const metadata: Metadata = { title: "Журнал действий" };

interface Row {
  id: string;
  at: Date;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  detail: string | null;
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
  "catalog.seeded": "Загрузил каталог",
  "consent.registered": "Зарегистрировал согласие",
  "consent.revoked": "Отозвал согласие",
  "contact.anonymized": "Обезличил данные клиента",
  "contacts.exported": "Выгрузил клиентскую базу",
  "lead.created": "Получил заявку",
  "lead.status_changed": "Изменил статус заявки",
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
  "price.set": "Изменил цену",
  "retention.run": "Выполнил обезличивание по сроку хранения",
  "retention.settings_changed": "Изменил настройки хранения данных",
  "user.created": "Создал учетную запись сотрудника",
  "user.export_permission_changed": "Изменил право на выгрузку",
  "user.password_changed": "Изменил пароль сотрудника",
  "user.role_changed": "Изменил роль сотрудника",
};

const ENTITY: Record<string, string> = {
  attendance_entry: "посещение",
  contact: "клиент",
  consent_registration: "согласие",
  legal_document: "документ",
  lead_request: "заявка",
  news_image: "изображение",
  news_post: "публикация",
  retention_settings: "настройки хранения",
  slot_reservation: "бронь",
  user: "сотрудник",
};

const FIELD: Record<string, string> = {
  canExport: "Выгрузка",
  children: "Детей",
  kind: "Тип",
  left: "Осталось кодов восстановления",
  mfa: "Второй фактор",
  method: "Способ отметки",
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
  canExport: { true: "разрешена", false: "запрещена" },
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
  method: { manual: "вручную", qr: "по QR" },
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


/** The audit RPC returns a truncated JSON snippet; show it as readable text when it parses, otherwise omit it. */
function detailFromSnippet(detail: string | null): string | null {
  if (!detail) return null;
  try { return detailText(null, JSON.parse(detail)); } catch { return null; }
}

const field = "h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; actor?: string; action?: string; from?: string; to?: string }> }) {
  await requirePermission("audit.view");
  const sp = await searchParams;
  let rows: Row[];
  if (legacyBridgeEnabled()) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new Error("session_missing");
    const remote = await bridgeRpc<{ rows: Array<Omit<Row, "at"> & { at: string }> }>("audit.list", {}, token);
    rows = remote.rows.map((row) => ({ ...row, at: new Date(row.at) }));
  } else {
    ({ rows } = await getPool().query<Row>(
      `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, u.name AS actor,
              left(coalesce(a.after, a.before)::text, 160) AS detail
         FROM bb.audit_log a LEFT JOIN bb.users u ON u.id = a.actor_user_id
        ORDER BY a.id DESC LIMIT 200`,
    ));
  }
  // Filters apply to the loaded latest 200 records, so the audit RPC contract stays unchanged.
  const actors = [...new Set(rows.map((r) => r.actor).filter((a): a is string => !!a))].sort();
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const actor = sp.actor === "system" || actors.includes(sp.actor ?? "") ? sp.actor : undefined;
  const action = actions.includes(sp.action ?? "") ? sp.action : undefined;
  const from = sp.from && isValidDate(sp.from) ? sp.from : undefined;
  const to = sp.to && isValidDate(sp.to) ? sp.to : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" });
  const needle = q?.toLowerCase();
  const shown = rows.filter((r) => {
    if (actor === "system" ? r.actor !== null : actor ? r.actor !== actor : false) return false;
    if (action && r.action !== action) return false;
    const d = day.format(r.at);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (needle && !((r.actor ?? "").toLowerCase().includes(needle) || (r.entity_id ?? "").toLowerCase().includes(needle))) return false;
    return true;
  });
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Almaty" });

  return (
    <div className="crm-page">
      <header>
        <p className="crm-eyebrow">История системы</p>
        <h1 className="crm-page-title">Журнал действий</h1>
        <p className="crm-page-subtitle">Кто, что и когда сделал. Журнал нельзя изменить или удалить.</p>
      </header>
      <form method="get" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
        <input name="q" defaultValue={q ?? ""} maxLength={80} placeholder="Имя сотрудника или ID объекта" className={field} aria-label="Поиск по сотруднику или ID объекта" />
        <select name="actor" defaultValue={actor ?? ""} className={field} aria-label="Сотрудник">
          <option value="">Все сотрудники</option>
          <option value="system">Система</option>
          {actors.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select name="action" defaultValue={action ?? ""} className={field} aria-label="Тип события">
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
      <p className="text-xs text-muted">Показаны записи из последних 200 по выбранным условиям.</p>
      <div className="overflow-x-auto rounded-3xl border border-line bg-white">
        {shown.length ? (
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
              {shown.map((row) => {
                const details = detailFromSnippet(row.detail);
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
    </div>
  );
}
