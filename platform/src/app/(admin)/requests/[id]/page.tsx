import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { DatePicker } from "@/components/date-picker";
import { requirePermission } from "@/server/dal";
import { FastApiCrmClient, unifiedFastapiCrmEnabled, type FastApiLeadDetail, type FastApiLeadStatus } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import { confirmLeadAction, leadStatusAction, recordManualPaymentAction, recordManualRefundAction, saveLeadNoteAction } from "../actions";

export const metadata: Metadata = { title: "Карточка заявки" };

const STATUS_LABELS: Record<string, string> = {
  new: "Новая", contacted: "Связались", qualified: "Квалифицирована", booked: "Бронь подтверждена",
  paid: "Оплачена", completed: "Завершена", lost: "Потеряна", in_progress: "В работе",
  confirmed: "Подтверждена", cancelled: "Отменена", closed: "Закрыта",
};
const LOST_REASONS = [
  ["too_expensive", "Слишком дорого"], ["date_unavailable", "Нет подходящей даты"],
  ["no_answer", "Не удалось связаться"], ["competitor", "Выбрали другое место"],
  ["changed_mind", "Передумали"], ["other_branch", "Выбрали другой филиал"],
  ["later", "Вернутся позже"], ["other", "Другая причина"],
] as const;
const PAYMENT_METHODS = [
  ["cash", "Наличные"], ["card_terminal", "Терминал"],
  ["bank_transfer", "Перевод"], ["other_manual", "Другой ручной способ"],
] as const;
const PAYMENT_METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS) as Record<string, string>;
const ERRORS: Record<string, string> = {
  fastapi_unavailable: "FastAPI CRM недоступна. Проверь соединение и повтори действие с тем же ключом.",
  forbidden: "FastAPI не разрешила это действие для твоей учётной записи.",
  not_found: "Заявка не найдена или недоступна этой роли.",
  slot_taken: "Это время уже занято. Выбери другое время и повтори подтверждение.",
  prepayment_required: "Для бронирования требуется фактически внесённая предоплата не менее 10 000 ₸.",
  buffer_required: "Не настроен обязательный буфер уборки. Обратись к владельцу до подтверждения брони.",
  buffer_reconciliation_required: "Занятости комнаты не сверены с буфером уборки. Подтверждение брони временно заблокировано.",
  refund_exceeds_paid: "Сумма фактических возвратов не может превышать сумму зафиксированных ручных платежей.",
  transition: "Такой переход статуса недоступен.",
  conflict: "Заявка или бронь уже изменена. Обнови карточку и проверь текущее состояние.",
  invalid: "Проверь поля формы.",
};
const money = new Intl.NumberFormat("ru-RU");

function allowedStatusActions(lead: FastApiLeadDetail): FastApiLeadStatus[] {
  if (lead.type === "contact") {
    return lead.status === "new" ? ["in_progress", "closed"] : lead.status === "in_progress" ? ["closed"] : [];
  }
  if (lead.status === "new") return ["contacted", "lost"];
  if (lead.status === "contacted") return ["qualified", "lost"];
  if (lead.status === "qualified") return ["lost"];
  if (lead.status === "lost") return ["contacted", "qualified"];
  if (lead.status === "booked" || lead.status === "paid" || lead.status === "confirmed") return ["completed"];
  if (lead.status === "in_progress") return ["contacted", "qualified", "lost"];
  return [];
}

function StatusForm({ id, status }: { id: string; status: FastApiLeadStatus }) {
  const label = STATUS_LABELS[status] ?? status;
  return (
    <form action={leadStatusAction} className="crm-detail-status-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      {status === "lost" ? (
        <label className="crm-detail-field">
          <span>Причина закрытия</span>
          <select name="lostReason" required defaultValue="">
            <option value="" disabled>Выбрать причину</option>
            {LOST_REASONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
      ) : null}
      <button type="submit" className="crm-detail-button crm-detail-button-secondary">{label}</button>
    </form>
  );
}

function Details({ lead, birthday }: { lead: FastApiLeadDetail; birthday: Awaited<ReturnType<FastApiCrmClient["getBirthdayLead"]>> | null }) {
  const rows = [
    ["Статус", STATUS_LABELS[lead.status] ?? lead.status],
    ["Создана", new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "Asia/Almaty" }).format(new Date(lead.createdAt))],
    ["Источник", lead.source],
    ["Способ связи", lead.contactMethod],
    ["Филиал", lead.branch?.name ?? "Не указан"],
    ["Пакет", lead.package?.name ?? birthday?.packageNameSnapshot ?? "Не выбран"],
    ["Запрошенная дата", lead.requestedDate ?? birthday?.requestedDate ?? "Не указана"],
    ["Гостей", lead.guestCount ?? birthday?.guestCount ?? "Не указано"],
  ] as const;
  return (
    <section className="crm-detail-panel" aria-label="Детали заявки">
      <div className="crm-detail-contact">
        <span className="crm-detail-avatar" aria-hidden="true">{lead.customerName.trim().slice(0, 1).toUpperCase() || "К"}</span>
        <div><h2>{lead.customerName}</h2><a href={`tel:${lead.phone}`}>{lead.phone}</a></div>
      </div>
      <dl className="crm-detail-facts">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {birthday?.childName ? <div><dt>Имя ребёнка</dt><dd>{birthday.childName}</dd></div> : null}
      </dl>
      {lead.notes || birthday?.comment ? (
        <div className="crm-detail-note"><strong>Комментарий к заявке</strong><p>{lead.notes ?? birthday?.comment}</p></div>
      ) : null}
      {birthday ? (
        <form action={saveLeadNoteAction} className="crm-detail-form crm-detail-note-form">
          <input type="hidden" name="id" value={lead.id} />
          <label className="crm-detail-field"><span>Внутренняя заметка</span><textarea name="adminNote" maxLength={2000} rows={3} defaultValue={birthday.adminNote ?? ""} /></label>
          <button type="submit" className="crm-detail-button crm-detail-button-secondary">Сохранить заметку</button>
        </form>
      ) : null}
    </section>
  );
}

export default async function RequestDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string; paymentKey?: string; refundKey?: string; bookingKey?: string }>;
}) {
  const { user } = await requirePermission("requests.manage");
  if (!unifiedFastapiCrmEnabled()) notFound();
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) notFound();
  const sp = await searchParams;
  const requestId = randomUUID();
  let lead: FastApiLeadDetail | null = null;
  let birthday: Awaited<ReturnType<FastApiCrmClient["getBirthdayLead"]>> | null = null;
  let catalog: Awaited<ReturnType<FastApiCrmClient["getBookingCatalog"]>> | null = null;
  let loadError = false;
  try {
    const actor = await fastApiActorForStaff({ id: user.id, email: user.email }, { requestId });
    const client = new FastApiCrmClient(actor);
    lead = await client.getLead(id);
    if (lead.type === "birthday_request") {
      birthday = await client.getBirthdayLead(id);
      if (lead.branch?.id) catalog = await client.getBookingCatalog(lead.branch.id);
    }
  } catch {
    loadError = true;
  }

  if (!lead) {
    return (
      <div className="crm-page crm-detail-page">
        <div className="crm-detail-heading"><div><p className="crm-eyebrow">Рабочая очередь</p><h1 className="crm-page-title">Карточка заявки</h1></div><Link href="/requests" className="crm-detail-button crm-detail-button-secondary">К очереди</Link></div>
        <p className="crm-detail-message crm-detail-message-error" role="alert">FastAPI CRM недоступна или заявка не найдена. Данные из старой базы не показаны.</p>
      </div>
    );
  }

  if (!loadError && birthday) {
    const paymentKey = /^[0-9a-f-]{36}$/i.test(sp.paymentKey ?? "") ? sp.paymentKey! : randomUUID();
    const refundKey = /^[0-9a-f-]{36}$/i.test(sp.refundKey ?? "") ? sp.refundKey! : randomUUID();
    const bookingKey = /^[0-9a-f-]{36}$/i.test(sp.bookingKey ?? "") ? sp.bookingKey! : randomUUID();
    if (paymentKey !== sp.paymentKey || refundKey !== sp.refundKey || bookingKey !== sp.bookingKey) {
      const query = new URLSearchParams();
      if (sp.notice) query.set("notice", sp.notice);
      if (sp.error) query.set("error", sp.error);
      query.set("paymentKey", paymentKey);
      query.set("refundKey", refundKey);
      query.set("bookingKey", bookingKey);
      redirect(`/requests/${encodeURIComponent(id)}?${query.toString()}`);
    }
  }

  const statuses = loadError ? [] : allowedStatusActions(lead);
  const activeRooms = catalog?.rooms.filter((room) => room.branchId === lead.branch?.id) ?? [];
  const activePackages = catalog?.packages.filter((item) => item.branchId === lead.branch?.id) ?? [];
  const canConfirm = birthday !== null && !["booked", "paid", "completed", "confirmed", "cancelled", "lost", "closed"].includes(lead.status);
  const hasMinimumPrepayment = (birthday?.netManualPaymentAmountKzt ?? 0) >= 10_000;

  return (
    <div className="crm-page crm-detail-page">
      <div className="crm-detail-heading">
        <div>
          <p className="crm-eyebrow">Рабочая очередь / {lead.type === "birthday_request" ? "День рождения" : "Обращение"}</p>
          <h1 className="crm-page-title">Карточка заявки</h1>
          <p className="crm-page-subtitle">ID {lead.id}</p>
        </div>
        <Link href="/requests" className="crm-detail-button crm-detail-button-secondary">К очереди</Link>
      </div>
      {sp.notice === "created" ? <p className="crm-detail-message" role="status">Заявка создана FastAPI. Комната пока не занята.</p> : null}
      {sp.notice === "status" ? <p className="crm-detail-message" role="status">Статус подтверждён FastAPI.</p> : null}
      {sp.notice === "note" ? <p className="crm-detail-message" role="status">Внутренняя заметка сохранена.</p> : null}
      {sp.notice === "payment" ? <p className="crm-detail-message" role="status">Факт ручной предоплаты записан и подтверждён FastAPI.</p> : null}
      {sp.notice === "refund" ? <p className="crm-detail-message" role="status">Факт фактически проведённого возврата записан в FastAPI.</p> : null}
      {sp.error ? <p className="crm-detail-message crm-detail-message-error" role="alert">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}
      {loadError ? <p className="crm-detail-message crm-detail-message-error" role="alert">FastAPI CRM недоступна. Данные из старой базы не показаны.</p> : null}

      <div className="crm-detail-layout">
        <Details lead={lead} birthday={birthday} />
        <section className="crm-detail-panel crm-detail-workflow" aria-label="Работа с заявкой">
          <div className="crm-detail-panel-heading"><div><p className="crm-eyebrow">Состояние</p><h2>{STATUS_LABELS[lead.status] ?? lead.status}</h2></div><span className="crm-requests-status" data-status={lead.status}>{STATUS_LABELS[lead.status] ?? lead.status}</span></div>
          {statuses.length ? (
            <div className="crm-detail-status-actions">
              {statuses.map((status) => <StatusForm key={status} id={lead.id} status={status} />)}
            </div>
          ) : <p className="crm-detail-help">Для этого статуса нет доступного перехода.</p>}
          {birthday ? (
            <div className="crm-detail-payment">
              <h3>Денежные события</h3>
              <dl className="crm-detail-money-summary">
                <div><dt>Получено вручную</dt><dd>{money.format(birthday.manualPaymentFactAmountKzt)} ₸</dd></div>
                <div><dt>Возвращено</dt><dd>−{money.format(birthday.manualRefundFactAmountKzt)} ₸</dd></div>
                <div><dt>Остаток предоплаты</dt><dd>{money.format(birthday.netManualPaymentAmountKzt)} ₸</dd></div>
              </dl>
              <p className="crm-detail-help">Платёж и возврат записываются только после фактического движения денег. Запись не переводит деньги и не отменяет бронь.</p>
              {birthday.manualPaymentFacts.length ? (
                <ol className="crm-detail-refund-list" aria-label="История фактических оплат">
                  {birthday.manualPaymentFacts.map((payment) => (
                    <li key={payment.id}>
                      <strong>+{money.format(payment.amountKzt)} ₸ · {PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</strong>
                      <span>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(payment.receivedAt))} · {payment.recordedByAdminName}</span>
                      {payment.note ? <span>{payment.note}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {birthday.manualRefundFacts.length ? (
                <ol className="crm-detail-refund-list" aria-label="История фактических возвратов">
                  {birthday.manualRefundFacts.map((refund) => (
                    <li key={refund.id}>
                      <strong>−{money.format(refund.amountKzt)} ₸ · {PAYMENT_METHOD_LABELS[refund.method] ?? refund.method}</strong>
                      <span>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(refund.refundedAt))} · сотрудник {refund.recordedByAdminId}</span>
                      <span>{refund.reason}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {!loadError && !["cancelled", "lost"].includes(lead.status) ? (
                <form action={recordManualPaymentAction} className="crm-detail-form">
                  <input type="hidden" name="id" value={lead.id} />
                  <input type="hidden" name="idempotencyKey" value={sp.paymentKey ?? ""} />
                  <label className="crm-detail-field"><span>Получено, ₸</span><input name="amountKzt" type="number" min="1" max="10000000" step="1" required placeholder="Например, 10 000" /></label>
                  <label className="crm-detail-field"><span>Способ</span><select name="method" required defaultValue=""><option value="" disabled>Выбрать способ</option>{PAYMENT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="crm-detail-field"><span>Примечание</span><input name="note" maxLength={300} placeholder="Необязательно" /></label>
                  <button type="submit" className="crm-detail-button">Записать факт получения</button>
                </form>
              ) : null}
              {!loadError && birthday.netManualPaymentAmountKzt > 0 ? (
                <form action={recordManualRefundAction} className="crm-detail-form crm-detail-refund-form">
                  <input type="hidden" name="id" value={lead.id} />
                  <input type="hidden" name="idempotencyKey" value={sp.refundKey ?? ""} />
                  <p className="crm-detail-refund-warning">Укажи возврат, который уже был фактически проведён. Эта форма не возвращает деньги.</p>
                  <label className="crm-detail-field"><span>Возвращено, ₸</span><input name="amountKzt" type="number" min="1" max={Math.min(10_000_000, birthday.netManualPaymentAmountKzt)} step="1" required placeholder="Например, 10 000" /></label>
                  <label className="crm-detail-field"><span>Способ возврата</span><select name="method" required defaultValue=""><option value="" disabled>Выбрать способ</option>{PAYMENT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="crm-detail-field"><span>Дата возврата</span><DatePicker name="refundDate" label="Дата возврата" required allowClear={false} /></label>
                  <label className="crm-detail-field"><span>Время возврата, Алматы</span><input name="refundTime" type="time" required /></label>
                  <label className="crm-detail-field crm-detail-refund-reason"><span>Причина возврата</span><input name="reason" required minLength={1} maxLength={300} placeholder="Например: мероприятие отменено клиентом" /></label>
                  <button type="submit" className="crm-detail-button crm-detail-button-secondary">Записать факт возврата</button>
                </form>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      {canConfirm ? (
        <section className="crm-detail-panel" aria-label="Подтверждение брони">
          <div className="crm-detail-panel-heading"><div><p className="crm-eyebrow">Следующий шаг</p><h2>Подтвердить бронь</h2></div><span className="crm-detail-deposit-state" data-ready={hasMinimumPrepayment}>{hasMinimumPrepayment ? "Предоплата достаточна" : "Ожидается предоплата"}</span></div>
          {!hasMinimumPrepayment ? <p className="crm-detail-help">Для подтверждения необходимо, чтобы фактически полученная сумма за вычетом зафиксированных возвратов составляла не менее 10 000 ₸. Заявка до подтверждения не занимает комнату.</p> : null}
          {catalog && activeRooms.length && activePackages.length && birthday?.branch?.id ? (
            <form action={confirmLeadAction} className="crm-detail-form crm-detail-booking-form">
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="idempotencyKey" value={sp.bookingKey ?? ""} />
              <label className="crm-detail-field"><span>Дата праздника</span><DatePicker name="bookingDate" label="Дата праздника" defaultValue={birthday.requestedDate ?? ""} required allowClear={false} /></label>
              <label className="crm-detail-field"><span>Время начала · праздник 4 часа</span><input type="time" name="startTime" step={900} required /></label>
              <label className="crm-detail-field"><span>Комната</span><select name="roomId" required defaultValue=""><option value="" disabled>Выбрать комнату</option>{activeRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
              <label className="crm-detail-field"><span>Пакет · каталог FastAPI</span><select name="packageId" required defaultValue=""><option value="" disabled>Выбрать пакет</option>{activePackages.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.priceLabel}</option>)}</select></label>
              <label className="crm-detail-field"><span>Согласованная цена, ₸</span><input name="agreedPriceKzt" type="number" min="1" max="10000000" step="1" required placeholder="Введите итоговую цену" /></label>
              <p className="crm-detail-help crm-detail-booking-note">Цена «от» в каталоге справочная. Здесь укажи сумму, согласованную с клиентом. FastAPI проверит доступность комнаты и буфер.</p>
              <button type="submit" className="crm-detail-button" disabled={!hasMinimumPrepayment}>Подтвердить бронь</button>
            </form>
          ) : <p className="crm-detail-message crm-detail-message-error">Для брони нужны подтверждённая филиальная привязка и каталог комнат/пакетов FastAPI.</p>}
        </section>
      ) : null}
    </div>
  );
}
