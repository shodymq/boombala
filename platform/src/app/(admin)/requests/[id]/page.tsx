import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/core/rbac";
import { birthdayStartTimes } from "@/core/birthday-booking-time";
import { isValidDate } from "@/core/dates";
import { DatePicker } from "@/components/date-picker";
import { requirePermission } from "@/server/dal";
import { FastApiCrmClient, FastApiCrmError, unifiedFastapiCrmEnabled, type FastApiBirthdayBookingCatalog, type FastApiBirthdayLeadDetail, type FastApiLeadDetail } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import { confirmBirthdayBookingAction, leadStatusAction, recordManualPaymentAction, recordManualRefundAction } from "../actions";

export const metadata: Metadata = { title: "Карточка заявки" };

const statuses: Record<string, string> = {
  new: "Новая", contacted: "Связались", qualified: "Квалифицирована", booked: "Забронирована",
  paid: "Оплачена", completed: "Завершена", lost: "Потеряна", in_progress: "В работе",
  confirmed: "Подтверждена", cancelled: "Отменена", closed: "Закрыта",
};
const lostReasons = [
  ["too_expensive", "Слишком дорого"], ["date_unavailable", "Нет подходящей даты"],
  ["no_answer", "Не удалось связаться"], ["competitor", "Выбрали другое место"],
  ["changed_mind", "Передумали"], ["other_branch", "Выбрали другой филиал"],
  ["later", "Вернутся позже"], ["other", "Другая причина"],
  ["price", "Цена"], ["no_response", "Нет ответа"], ["chose_competitor", "Выбрали конкурента"],
  ["changed_plans", "Изменились планы"], ["duplicate", "Повторная заявка"],
] as const;
const paymentMethods = [
  ["cash", "Наличные"], ["card_terminal", "Терминал"],
  ["bank_transfer", "Банковский перевод"], ["other_manual", "Другой ручной способ"],
] as const;
const methodLabels = Object.fromEntries(paymentMethods) as Record<string, string>;
const money = new Intl.NumberFormat("ru-RU");
const input = "crm-requests-control";
const button = "crm-requests-action";
const buttonSecondary = "crm-requests-action crm-requests-action-secondary";
const panel = "rounded-2xl border border-line bg-white p-5 shadow-sm";
const field = "grid gap-1.5 text-sm font-bold text-muted";
const errorMessages: Record<string, string> = {
  fastapi_unavailable: "FastAPI CRM временно недоступна. Проверьте соединение перед повторной отправкой.",
  forbidden: "У вашей учётной записи нет доступа к этому действию.",
  not_found: "Заявка не найдена или недоступна вашей роли.",
  invalid: "Проверьте заполнение полей и подтверждение факта.",
  transition: "Такой переход статуса недоступен.",
  booking_cancel_first: "Сначала отмените бронь и убедитесь, что комната освобождена в календаре.",
  prepayment_required: "Нужна фактически полученная предоплата 10 000 ₸ и сверенные платежи.",
  buffer_required: "Для новых броней должен быть настроен нулевой буфер.",
  booking_conflict: "Время занято или заявка уже забронирована. Обновите карточку и календарь перед повтором.",
  booking_past: "Нельзя подтвердить бронь на прошедшую дату или время.",
  booking_catalog_mismatch: "Каталог филиала изменился или содержит не четыре активные комнаты. Обновите карточку.",
  booking_time_outside_working_hours: "Выберите время, в которое четырёхчасовой праздник помещается в рабочий график.",
  birthday_request_not_bookable: "Заявку нельзя подтвердить в текущем статусе или филиале. Обновите карточку.",
  payment_reconciliation: "Сначала сверьте старые платежи и возвраты с банкет-менеджером.",
  refund_exceeds_paid: "Сумма возвратов не может быть больше фактически полученного платежа.",
  conflict: "Заявка или платёж уже изменились. Обновите карточку и проверьте факты.",
};
const notices: Record<string, string> = { status: "Статус заявки обновлён.", payment: "Факт полученного платежа записан.", refund: "Факт уже выполненного возврата записан." };

function allowedTransitions(lead: FastApiLeadDetail): string[] {
  if (lead.type === "contact") {
    if (lead.status === "new") return ["in_progress", "closed"];
    if (lead.status === "in_progress") return ["closed"];
    return [];
  }
  if (lead.status === "new") return ["contacted", "lost"];
  if (lead.status === "contacted") return ["qualified", "lost"];
  if (lead.status === "qualified") return ["lost"];
  if (lead.status === "lost") return ["contacted", "qualified"];
  if (lead.status === "in_progress") return ["contacted", "qualified", "lost"];
  if (["booked", "paid", "confirmed"].includes(lead.status)) return ["completed"];
  return [];
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(value));
}

function StatusForms({ lead }: { lead: FastApiLeadDetail }) {
  const nextStatuses = allowedTransitions(lead);
  if (!nextStatuses.length) return <p className="text-sm text-muted">Для текущего статуса доступных переходов нет.</p>;
  return (
    <div className="flex flex-wrap gap-3">
      {nextStatuses.map((status) => (
        <form action={leadStatusAction} key={status} className="grid gap-2">
          <input type="hidden" name="id" value={lead.id} />
          <input type="hidden" name="status" value={status} />
          {status === "lost" ? (
            <label className={field}>
              <span>Причина потери</span>
              <select className={input} name="lostReason" defaultValue="" required>
                <option value="" disabled>Выберите причину</option>
                {lostReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          ) : null}
          <button type="submit" className={status === "lost" ? buttonSecondary : button}>{statuses[status] ?? status}</button>
        </form>
      ))}
    </div>
  );
}

function remainingByPayment(birthday: FastApiBirthdayLeadDetail, paymentId: string): number {
  const payment = birthday.manualPaymentFacts.find((fact) => fact.id === paymentId);
  if (!payment) return 0;
  const refunded = birthday.manualRefundFacts
    .filter((fact) => fact.paymentFactId === paymentId)
    .reduce((total, fact) => total + fact.amountKzt, 0);
  return Math.max(0, payment.amountKzt - refunded);
}

export default async function RequestDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string; depositKey?: string; paymentKey?: string; refundKey?: string; bookingKey?: string; bookingDate?: string; bookingRoomId?: string; bookingPackageId?: string; bookingStartTime?: string; agreedPriceKzt?: string }>;
}) {
  const { user } = await requirePermission("requests.manage");
  if (!unifiedFastapiCrmEnabled()) notFound();
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) notFound();
  const query = await searchParams;
  const requestId = randomUUID();
  let lead: FastApiLeadDetail | null = null;
  let birthday: FastApiBirthdayLeadDetail | null = null;
  let catalog: FastApiBirthdayBookingCatalog | null = null;
  let catalogFailed = false;
  let loadFailed = false;
  try {
    const actor = await fastApiActorForStaff({ id: user.id, email: user.email, role: user.role }, { requestId });
    const client = new FastApiCrmClient(actor);
    lead = await client.getLead(id);
    if (lead.type === "birthday_request") {
      birthday = await client.getBirthdayLead(id);
      try {
        catalog = await client.getBookingCatalog(birthday.branch?.id ?? lead.branch?.id ?? undefined);
      } catch {
        catalogFailed = true;
      }
    }
  } catch (error) {
    if (error instanceof FastApiCrmError && error.status === 404) notFound();
    loadFailed = true;
  }

  if (loadFailed || !lead) {
    return (
      <div className="crm-page grid gap-5">
        <Link href="/requests" className="text-sm font-bold text-grape-700 underline">← К заявкам</Link>
        <h1 className="crm-page-title">Карточка заявки</h1>
        <p role="alert" className="crm-requests-message crm-requests-message-error">FastAPI CRM недоступна. Данные из старой базы не показаны.</p>
      </div>
    );
  }

  const canManageBookings = can(user.role, "bookings.manage");
  const initialDepositRecorded = Boolean(birthday?.manualPaymentFacts.some((fact) => fact.paymentKind === "initial_deposit"));
  const unallocatedRefund = Boolean(birthday?.manualRefundFacts.some((fact) => fact.paymentFactId === null));
  const bookingActive = birthday?.bookingReservationState === "active";
  const reconciliationNeeded = birthday?.manualPaymentFactStatus === "unreconciled" || unallocatedRefund;
  const terminalStatus = ["cancelled", "lost", "completed", "closed"].includes(lead.status);
  const canRecordPayments = canManageBookings && !terminalStatus;
  const refundChoices = birthday?.manualPaymentFacts.filter((payment) =>
    payment.source === "manager_manual" && payment.paymentKind !== null && remainingByPayment(birthday, payment.id) > 0,
  ) ?? [];
  const availableRefundChoices = refundChoices.filter((payment) =>
    !bookingActive || payment.paymentKind !== "initial_deposit",
  );
  const lockedDepositRefund = bookingActive && refundChoices.some((payment) => payment.paymentKind === "initial_deposit");
  const branchId = birthday?.branch?.id ?? lead.branch?.id;
  const branch = catalog?.branches.length === 1 ? catalog.branches[0] : null;
  const rooms = catalog?.rooms.filter((room) => room.branchId === branchId) ?? [];
  const packages = catalog?.packages.filter((item) => item.branchId === branchId) ?? [];
  const times = branch ? birthdayStartTimes(branch.workingHours) : [];
  const catalogReady = Boolean(branch && branch.id === branchId && rooms.length === 4 && packages.length > 0);
  const bufferReady = branch?.bufferMinutes === 0;
  const initialDeposit = birthday?.manualPaymentFacts.find((fact) => fact.paymentKind === "initial_deposit" && fact.source === "manager_manual");
  const initialDepositRefunds = initialDeposit ? birthday?.manualRefundFacts.filter((fact) => fact.paymentFactId === initialDeposit.id).reduce((total, fact) => total + fact.amountKzt, 0) ?? 0 : 0;
  const hasRequiredDeposit = Boolean(initialDeposit && initialDeposit.amountKzt === 10_000 && initialDepositRefunds === 0 && birthday?.netInitialDepositKzt === 10_000 && !reconciliationNeeded);
  const canConfirm = canManageBookings && Boolean(birthday) && ["new", "contacted", "qualified", "in_progress"].includes(lead.status);
  const key = (value?: string) => value && /^[0-9a-f-]{36}$/i.test(value) ? value : randomUUID();
  const requestedBookingDate = birthday?.requestedDate ?? lead.requestedDate ?? "";
  const bookingDate = isValidDate(query.bookingDate ?? "") ? query.bookingDate! : requestedBookingDate;
  const roomId = rooms.some((room) => room.id === query.bookingRoomId) ? query.bookingRoomId! : rooms[0]?.id ?? "";
  const packageId = packages.some((item) => item.id === query.bookingPackageId)
    ? query.bookingPackageId!
    : packages.some((item) => item.id === lead.package?.id) ? lead.package!.id : packages[0]?.id ?? "";
  const startTime = times.includes(query.bookingStartTime ?? "") ? query.bookingStartTime! : "";
  const agreedPrice = query.agreedPriceKzt && /^[1-9]\d{0,7}$/.test(query.agreedPriceKzt) ? query.agreedPriceKzt : "";

  return (
    <div className="crm-page grid gap-5">
      <Link href="/requests" className="w-fit text-sm font-bold text-grape-700 underline">← К заявкам</Link>
      <header className="grid gap-2">
        <p className="crm-eyebrow">Карточка обращения</p>
        <h1 className="crm-page-title">{lead.customerName || "Без имени"}</h1>
        <p className="crm-page-subtitle"><a href={`tel:${lead.phone}`} className="text-grape-700 underline">{lead.phone}</a> · {statuses[lead.status] ?? lead.status} · ID {lead.id}</p>
      </header>

      {query.notice && notices[query.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{notices[query.notice]}</p> : null}
      {query.error ? <p role="alert" className="crm-requests-message crm-requests-message-error">{errorMessages[query.error] ?? "Не удалось выполнить действие."}</p> : null}

      <section className={panel} aria-label="Детали заявки">
        <h2 className="mb-4 text-lg font-black">Детали заявки</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="font-bold text-muted">Создана</dt><dd>{dateTime(lead.createdAt)}</dd></div>
          <div><dt className="font-bold text-muted">Тип</dt><dd>{lead.type === "birthday_request" ? "Банкет" : "Обращение"}</dd></div>
          <div><dt className="font-bold text-muted">Источник</dt><dd>{lead.source}</dd></div>
          <div><dt className="font-bold text-muted">Способ связи</dt><dd>{lead.contactMethod}</dd></div>
          <div><dt className="font-bold text-muted">Филиал</dt><dd>{lead.branch?.name ?? "Не указан"}</dd></div>
          <div><dt className="font-bold text-muted">Пакет</dt><dd>{lead.package?.name ?? birthday?.packageNameSnapshot ?? "Не выбран"}</dd></div>
          <div><dt className="font-bold text-muted">Дата банкета</dt><dd>{birthday?.requestedDate ?? lead.requestedDate ?? "Не указана"}</dd></div>
          <div><dt className="font-bold text-muted">Гостей</dt><dd>{birthday?.guestCount ?? lead.guestCount ?? "Не указано"}</dd></div>
          {birthday?.childName ? <div><dt className="font-bold text-muted">Имя ребёнка</dt><dd>{birthday.childName}</dd></div> : null}
        </dl>
        {lead.notes || birthday?.comment ? <div className="mt-5 border-t border-line pt-4"><h3 className="font-bold">Комментарий</h3><p className="mt-1 whitespace-pre-wrap text-sm">{lead.notes ?? birthday?.comment}</p></div> : null}
      </section>

      <section className={`${panel} grid gap-4`} aria-label="Изменение статуса">
        <div><h2 className="text-lg font-black">Статус заявки</h2><p className="text-sm text-muted">Текущий статус: {statuses[lead.status] ?? lead.status}</p></div>
        <StatusForms lead={lead} />
        {lead.status === "lost" && birthday?.lostReason ? <p className="text-sm text-muted">Причина: {lostReasons.find(([value]) => value === birthday?.lostReason)?.[1] ?? birthday.lostReason}</p> : null}
      </section>

      {birthday ? (
        <section className={`${panel} grid gap-5`} aria-label="Финансовые факты">
          <div>
            <h2 className="text-lg font-black">Ручные платежи и возвраты</h2>
            <p className="mt-1 text-sm text-muted">Менеджер записывает только деньги, которые уже фактически получены или возвращены. CRM не запускает оплату и перевод.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <p className="rounded-xl bg-grape-50 p-3 text-sm">Предоплата: <strong>{money.format(birthday.netInitialDepositKzt)} ₸</strong></p>
            <p className="rounded-xl bg-grape-50 p-3 text-sm">Чистая сумма: <strong>{money.format(birthday.netManualPaymentAmountKzt)} ₸</strong></p>
            <p className="rounded-xl bg-grape-50 p-3 text-sm">Сверка: <strong>{birthday.manualPaymentFactStatus === "unreconciled" ? "требуется" : "не требуется"}</strong></p>
          </div>

          <div className="grid gap-2" aria-label="Журнал платежей">
            {birthday.manualPaymentFacts.length || birthday.manualRefundFacts.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line px-4">
                {birthday.manualPaymentFacts.map((payment) => (
                  <li key={`payment-${payment.id}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
                    <span><strong>Получено: {money.format(payment.amountKzt)} ₸</strong> · {payment.paymentKind === "initial_deposit" ? "предоплата" : payment.paymentKind === "additional" ? "доплата" : "тип не сверён"} · {methodLabels[payment.method] ?? payment.method}</span>
                    <time className="text-muted" dateTime={payment.receivedAt}>{dateTime(payment.receivedAt)}</time>
                    {payment.note ? <span className="text-muted">{payment.note}</span> : null}
                  </li>
                ))}
                {birthday.manualRefundFacts.map((refund) => (
                  <li key={`refund-${refund.id}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
                    <span><strong>Возвращено: {money.format(refund.amountKzt)} ₸</strong> · {methodLabels[refund.method] ?? refund.method} · {refund.reason}</span>
                    <time className="text-muted" dateTime={refund.refundedAt}>{dateTime(refund.refundedAt)}</time>
                    {refund.paymentFactId === null ? <span role="alert" className="text-danger">Не распределён по платежу — нужна ручная сверка.</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Ручных платежей и возвратов пока нет.</p>}
          </div>

          {canManageBookings ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid content-start gap-3 rounded-xl border border-line p-4">
                <h3 className="font-black">Зафиксировать полученную сумму</h3>
                {canRecordPayments && !initialDepositRecorded && birthday.manualPaymentFactStatus !== "unreconciled" ? (
                  <form action={recordManualPaymentAction} className="grid gap-3 border-b border-line pb-4">
                    <input type="hidden" name="id" value={lead.id} />
                    <input type="hidden" name="paymentKind" value="initial_deposit" />
                    <input type="hidden" name="amountKzt" value="10000" />
                    <input type="hidden" name="idempotencyKey" value={key(query.depositKey)} />
                    <p className="text-sm">Обязательная предоплата — ровно <strong>10 000 ₸</strong>.</p>
                    <label className={field}><span>Способ получения</span><select className={input} name="method" required defaultValue=""><option value="" disabled>Выберите способ</option>{paymentMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="receiptReceived" value="yes" required /><span>Подтверждаю: 10 000 ₸ уже фактически получены.</span></label>
                    <button type="submit" className={button}>Записать предоплату</button>
                  </form>
                ) : <p className="text-sm text-muted">{terminalStatus ? "Для закрытого, отменённого или потерянного обращения платежи не принимаются." : initialDepositRecorded ? "Факт предоплаты уже записан. Повторная предоплата недоступна." : "До записи предоплаты требуется сверить исторические платежи."}</p>}

                {canRecordPayments ? <form action={recordManualPaymentAction} className="grid gap-3">
                  <input type="hidden" name="id" value={lead.id} />
                  <input type="hidden" name="paymentKind" value="additional" />
                  <input type="hidden" name="idempotencyKey" value={key(query.paymentKey)} />
                  <label className={field}><span>Дополнительная сумма, ₸</span><input className={input} type="number" name="amountKzt" min="1" max="10000000" step="1" required /></label>
                  <label className={field}><span>Способ получения</span><select className={input} name="method" required defaultValue=""><option value="" disabled>Выберите способ</option>{paymentMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className={field}><span>Примечание, если нужно</span><input className={input} name="note" maxLength={300} /></label>
                  <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="receiptReceived" value="yes" required /><span>Подтверждаю: эта дополнительная сумма уже фактически получена и не заменяет предоплату.</span></label>
                  <button type="submit" className={button}>Записать доплату</button>
                </form> : null}
              </div>

              <div className="grid content-start gap-3 rounded-xl border border-line p-4">
                <h3 className="font-black">Зафиксировать выполненный возврат</h3>
                {lockedDepositRefund ? <p className="rounded-xl bg-sun-100 p-3 text-sm font-bold">Чтобы вернуть предоплату, сначала отмените бронь и освободите комнату в календаре. Доплату можно вернуть отдельно, пока внесённая предоплата остаётся не меньше 10 000 ₸.</p> : null}
                {reconciliationNeeded ? <p className="rounded-xl bg-sun-100 p-3 text-sm font-bold">Сначала сверьте нераспределённые старые платежи и возвраты.</p> : null}
                {!reconciliationNeeded && availableRefundChoices.length ? (
                  <form action={recordManualRefundAction} className="grid gap-3">
                    <input type="hidden" name="id" value={lead.id} />
                    <input type="hidden" name="idempotencyKey" value={key(query.refundKey)} />
                    <label className={field}><span>Платёж, который уже возвращён</span><select className={input} name="paymentFactId" required defaultValue=""><option value="" disabled>Выберите платёж</option>{availableRefundChoices.map((payment) => <option key={payment.id} value={payment.id}>{payment.paymentKind === "initial_deposit" ? "Предоплата" : "Доплата"} · остаток {money.format(remainingByPayment(birthday, payment.id))} ₸ · {dateTime(payment.receivedAt)}</option>)}</select></label>
                    <label className={field}><span>Возвращено, ₸</span><input className={input} type="number" name="amountKzt" min="1" max="10000000" step="1" required /></label>
                    <label className={field}><span>Способ возврата</span><select className={input} name="method" required defaultValue=""><option value="" disabled>Выберите способ</option>{paymentMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className={field}><span>Причина возврата</span><textarea className={input} name="reason" minLength={1} maxLength={300} rows={3} required /></label>
                    <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="refundCompleted" value="yes" required /><span>Подтверждаю: деньги уже фактически возвращены вручную.</span></label>
                    <button type="submit" className={buttonSecondary}>Записать факт возврата</button>
                  </form>
                ) : !reconciliationNeeded && !lockedDepositRefund ? <p className="text-sm text-muted">Нет сверенных платежей с доступным остатком для возврата.</p> : null}
                <p className="text-xs text-muted">Сумма возврата ограничена остатком выбранного зафиксированного платежа.</p>
              </div>
            </div>
          ) : <p className="text-sm text-muted">Ручные платежи и возвраты доступны владельцу и банкет-менеджеру.</p>}
        </section>
      ) : null}

      {birthday ? (
        <section className={`${panel} grid gap-4`} aria-label="Подтверждение брони">
          <div>
            <h2 className="text-lg font-black">Подтвердить бронь</h2>
            <p className="mt-1 text-sm text-muted">Выберите фактические условия, согласованные с клиентом. Цена пакета не подставляется автоматически.</p>
          </div>
          {catalogFailed ? <p role="alert" className="text-sm text-danger">Не удалось загрузить каталог филиала. Подтверждение заблокировано.</p> : null}
          {!catalogFailed && !catalogReady ? <p className="text-sm text-danger">Нужен каталог одного филиала с четырьмя активными комнатами и пакетами.</p> : null}
          {catalogReady && !bufferReady ? <p className="text-sm text-danger">Каталог должен содержать буфер 0 минут для новых броней.</p> : null}
          {canConfirm && !hasRequiredDeposit ? <p className="text-sm text-danger">Сначала запишите фактически полученные 10 000 ₸ предоплаты и сверьте все платежи и возвраты.</p> : null}
          {canConfirm && hasRequiredDeposit && catalogReady && bufferReady && times.length === 0 ? <p className="text-sm text-danger">В каталоге нет рабочего интервала, который вмещает четырёхчасовой праздник.</p> : null}
          {canConfirm && hasRequiredDeposit && catalogReady && bufferReady && times.length > 0 ? (
            <form action={confirmBirthdayBookingAction} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="branchId" value={branch!.id} />
              <input type="hidden" name="idempotencyKey" value={key(query.bookingKey)} />
              <label className={field}>Дата банкета<DatePicker name="bookingDate" label="Дата банкета" defaultValue={bookingDate} required allowClear={false} /></label>
              <label className={field}><span>Комната</span><select className={input} name="roomId" required defaultValue={roomId}>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
              <label className={field}><span>Пакет</span><select className={input} name="packageId" required defaultValue={packageId}>{packages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className={field}><span>Время начала</span><select className={input} name="startTime" required defaultValue={startTime}><option value="" disabled>Выберите время</option>{times.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
              <label className={field}><span>Согласованная цена, ₸</span><input className={input} type="number" name="agreedPriceKzt" min="1" max="10000000" step="1" required defaultValue={agreedPrice} /></label>
              <p className="self-center text-sm text-muted">Праздник длится ровно 4 часа; буфер между бронями — 0 минут.</p>
              <button type="submit" className={button}>Подтвердить бронь</button>
            </form>
          ) : null}
          {!canManageBookings ? <p className="text-sm text-muted">Подтверждать бронь может владелец или банкет-менеджер.</p> : null}
          {canManageBookings && !canConfirm ? <p className="text-sm text-muted">Подтверждение недоступно для текущего статуса заявки.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
