import { randomUUID } from "node:crypto";
import Link from "next/link";
import { remainingKzt, paymentLabel } from "../../../core/booking-calendar.ts";
import type { BookingCatalogPackage, BookingTimelineReservation } from "../../../server/fastapi-crm.ts";
import { blockAction, confirmPaidRequestAction, createBookingAction, recordManualPrepaymentAction, releaseAction, rescheduleAction } from "./crm-actions";
import { StartTimeField } from "./start-time-field";
import { SubmitButton } from "./submit-button";
import { BookingActionForm } from "./server-action-form";
import { clock } from "./timeline";

const kzt = new Intl.NumberFormat("ru-RU");
const field = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const label = "grid gap-1 text-xs font-extrabold text-muted";
const primary = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-50";
const ghost = "flex h-11 items-center justify-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-50";
const METHOD_LABEL = { cash: "Наличные", card_terminal: "Терминал", bank_transfer: "Перевод", other_manual: "Другое" } as const;

/** Right-hand panel (full screen on a phone). Server-rendered and driven by the address, so it works without client scripts. */
export function Drawer({ title, closeHref, children, wide = false }: { title: string; closeHref: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[70] flex justify-end md:z-50" role="dialog" aria-modal="true" aria-label={title} data-drawer>
      <Link href={closeHref} prefetch={false} scroll={false} aria-label="Закрыть" className="hidden flex-1 bg-ink/40 md:block" />
      <aside className={`flex w-full flex-col overflow-y-auto bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl ${wide ? "md:max-w-2xl" : "md:max-w-md"}`}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-xl font-black text-grape-800">{title}</h2>
          <Link href={closeHref} prefetch={false} scroll={false} className={ghost + " min-h-11 px-3 md:h-9 md:min-h-0"}>Закрыть</Link>
        </div>
        {children}
      </aside>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 border-b border-line py-1.5 text-sm">
      <dt className="font-extrabold text-muted">{term}</dt>
      <dd className="min-w-0 break-words font-bold text-grape-900">{children}</dd>
    </div>
  );
}

function Hidden({ branchId, reservationId }: { branchId: string; reservationId?: string }) {
  return (
    <>
      <input type="hidden" name="branchId" value={branchId} />
      {reservationId ? <input type="hidden" name="reservationId" value={reservationId} /> : null}
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
    </>
  );
}

export function ReservationDetails({
  r,
  roomName,
  rooms,
  quick,
  hoursKnown,
  branchId,
  date,
  closeHref,
  rescheduling,
  rescheduleHref,
  detailHref,
  cardHref,
}: {
  r: BookingTimelineReservation;
  roomName: string;
  rooms: { id: string; name: string }[];
  quick: string[];
  hoursKnown: boolean;
  branchId: string;
  date: string;
  closeHref: string;
  rescheduling: boolean;
  rescheduleHref: string;
  detailHref: string;
  cardHref: string;
}) {
  const isBlock = r.kind === "block";
  const released = r.status === "released";
  const pay = paymentLabel(r, (n) => kzt.format(n));
  const remaining = remainingKzt(r);
  const dayLabel = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  return (
    <Drawer title={isBlock ? "Блокировка комнаты" : "Бронь праздника"} closeHref={closeHref}>
      <dl data-reservation-card={r.id}>
        <Row term="Статус">{released ? "Снята (история)" : r.sourceHandedOver ? "Передано из таблицы в CRM" : r.sourceManaged ? r.sourceState === "source_missing" ? "Импортировано · строка отсутствует · сверка" : r.sourceState === "manual_review" ? "Импортировано · требуется сверка" : "Импортировано из Google Sheets · только чтение" : isBlock ? "Блокировка" : "Подтверждена"}</Row>
        {!isBlock || r.sourceManaged ? <Row term="Клиент">{r.customerName ?? "Скрыто для вашей роли"}</Row> : null}
        {(!isBlock || r.sourceManaged) && r.customerPhone ? <Row term="Телефон">{r.customerPhone}</Row> : null}
        <Row term="Пакет">{isBlock && !r.sourceManaged ? "—" : r.packageName ?? "не указан"}</Row>
        <Row term="Комната">{roomName}</Row>
        <Row term="Дата">{dayLabel}</Row>
        <Row term="Время">{clock(r.startsAt)}–{clock(r.endsAt)} (4 часа)</Row>
        {r.occupiedEndsAt !== r.endsAt ? <Row term="Занято до">{clock(r.occupiedEndsAt)} (с подготовкой)</Row> : null}
        {r.sourceManaged && r.sourceDetails ? (
          <>
            {r.sourceDetails.childName ? <Row term="Именинник">{r.sourceDetails.childName}</Row> : null}
            {r.sourceDetails.childAge ? <Row term="Возраст">{r.sourceDetails.childAge}</Row> : null}
            {r.sourceDetails.children ? <Row term="Детей">{r.sourceDetails.children}</Row> : null}
            {r.sourceDetails.adults ? <Row term="Взрослых">{r.sourceDetails.adults}</Row> : null}
            {r.sourceDetails.animator ? <Row term="Аниматор">{r.sourceDetails.animator}</Row> : null}
            {r.sourceDetails.prepaymentRaw ? <Row term="Предоплата из таблицы">{r.sourceDetails.prepaymentRaw} · не подтверждена</Row> : null}
            {r.sourceDetails.comment ? <Row term="Комментарий">{r.sourceDetails.comment}</Row> : null}
          </>
        ) : null}
        {isBlock ? null : (
          <>
            <Row term="Сумма">{r.priceKzt != null ? `${kzt.format(r.priceKzt)} ₸${r.priceSource === "manager_agreed" ? "" : " (ориентир каталога)"}` : "не указана"}</Row>
            <Row term="Предоплата">{pay.tone === "prepaid" ? `${kzt.format(r.paidKzt)} ₸ записана вручную (не онлайн-оплата)` : "не записана"}</Row>
            <Row term="Остаток">{remaining !== null ? `${kzt.format(remaining)} ₸` : "неизвестен: нет согласованной цены"}</Row>
            <Row term="Создал">{r.createdByName ?? "не указан"}</Row>
            <Row term="Ответственный">{r.card?.responsibleName ?? "не назначен"}</Row>
          </>
        )}
        {r.card ? (
          <>
            {r.card.childName ? <Row term="Именинник">{r.card.childName}</Row> : null}
            <Row term="Гости">{r.card.headcountMode === "by_fact" ? "по факту" : `детей ${r.card.childrenTotal ?? "—"}, взрослых ${r.card.adultsTotal ?? "—"}`}</Row>
            <Row term="Программа">{r.card.programStatus === "approved" ? "согласована" : "не согласована"}</Row>
            <Row term="Итого">{r.card.totalKzt !== null ? `${kzt.format(r.card.totalKzt)} ₸` : "не рассчитано (расчёт неполный)"}</Row>
          </>
        ) : null}
        <Row term={isBlock ? "Причина" : "Комментарий"}>{r.note ?? "—"}</Row>
        {r.requestId ? <Row term="Заявка №">{r.requestId}</Row> : null}
        {released ? <Row term="Снята">{r.releasedAt ? clock(r.releasedAt) : "—"}</Row> : null}
      </dl>
      {r.sourceManaged ? (
        <p className="mt-3 rounded-xl bg-paper p-2 text-xs text-muted">Эта запись управляется таблицей «Банкеты». Перенос и отмена в CRM отключены, пока работает синхронизация. Сумма предоплаты из таблицы не считается подтверждением поступления денег.</p>
      ) : null}
      <Link href={cardHref} prefetch={false} scroll={false} className={ghost + " mt-3"} data-open-card>Открыть карточку{released ? " (история)" : ""}</Link>

      {released || r.sourceManaged ? null : (
        <div className="mt-4 grid gap-3">
          {isBlock ? null : rescheduling ? (
            <BookingActionForm action={rescheduleAction} className="grid gap-2 rounded-2xl border border-line p-3" label="Перенос брони">
              <h3 className="text-sm font-black text-grape-800">Перенести бронь</h3>
              <Hidden branchId={branchId} reservationId={r.id} />
              <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
              <label className={label}>Комната
                <select name="roomId" defaultValue={r.roomId} className={field}>{rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              </label>
              <StartTimeField defaultValue={clock(r.startsAt)} quick={hoursKnown ? quick : []} label="Новое начало" />
              <p className="text-xs text-muted">Перенос делает сервер одной операцией: если новое время занято, прежняя бронь остаётся. Предоплата не дублируется.</p>
              <div className="flex gap-2 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:bg-white/95 max-md:py-2 max-md:pb-[env(safe-area-inset-bottom)]"><SubmitButton className={primary + " min-h-11 flex-1 md:min-h-0"} pending="Переносим…">Перенести на 4 часа</SubmitButton><Link href={detailHref} prefetch={false} scroll={false} className={ghost + " min-h-11 md:min-h-0"}>Отмена</Link></div>
            </BookingActionForm>
          ) : (
            <Link href={rescheduleHref} prefetch={false} scroll={false} className={ghost}>Перенести бронь</Link>
          )}
          <details className="rounded-2xl border border-line p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-danger md:min-h-9">{isBlock ? "Освободить комнату" : "Отменить бронь"}</summary>
            <BookingActionForm action={releaseAction} className="mt-2 grid gap-2" label={isBlock ? "Освобождение комнаты" : "Отмена брони"}>
              <Hidden branchId={branchId} reservationId={r.id} />
              <input type="hidden" name="date" value={date} />
              <input name="reason" maxLength={300} placeholder="Причина" aria-label="Причина" className={field} />
              <SubmitButton className={ghost} pending="Выполняем…">{isBlock ? "Освободить комнату" : "Отменить бронь"}</SubmitButton>
            </BookingActionForm>
          </details>
        </div>
      )}
    </Drawer>
  );
}

export function NewBookingForm({
  rooms,
  packages,
  quick,
  branchId,
  date,
  closeHref,
  defaultRoomId,
  defaultStart,
  mode,
}: {
  rooms: { id: string; name: string }[];
  packages: BookingCatalogPackage[];
  quick: string[];
  branchId: string;
  date: string;
  closeHref: string;
  defaultRoomId?: string;
  defaultStart: string;
  mode: "booking" | "block";
}) {
  return (
    <Drawer title={mode === "block" ? "Заблокировать комнату" : "Новая заявка на праздник"} closeHref={closeHref}>
      {mode === "block" ? (
        <BookingActionForm action={blockAction} className="grid gap-2" label="Блокировка комнаты">
          <Hidden branchId={branchId} />
          <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
          <label className={label}>Комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <StartTimeField defaultValue={defaultStart} quick={quick} />
          <input name="reason" required maxLength={300} placeholder="Причина" aria-label="Причина блокировки" className={field} />
          <SubmitButton className={primary + " max-md:sticky max-md:bottom-0 max-md:z-10 max-md:min-h-11"}>Заблокировать на 4 часа</SubmitButton>
        </BookingActionForm>
      ) : (
        <BookingActionForm action={createBookingAction} className="grid gap-2" label="Новая заявка на праздник">
          <Hidden branchId={branchId} />
          <label className={label}>Желаемая дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
          <label className={label}>Желаемая комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <StartTimeField defaultValue={defaultStart} quick={quick} label="Желаемое начало" />
          <input name="customerName" required maxLength={120} placeholder="Клиент (имя)" aria-label="Имя клиента" className={field} />
          <input name="phone" type="tel" required maxLength={20} placeholder="+7 707 123 45 67" aria-label="Телефон" className={field} />
          <label className={label}>Пакет
            <select name="packageId" required className={field}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
          </label>
          <input name="guestCount" type="number" min={0} max={200} placeholder="Детей" aria-label="Количество детей" className={field} />
          <p className="text-xs text-muted">Создание заявки не фиксирует оплату и не занимает комнату. После фактического получения предоплаты менеджер отдельно зафиксирует её, затем подтвердит бронь.</p>
          <SubmitButton className={primary + " max-md:sticky max-md:bottom-0 max-md:z-10 max-md:min-h-11"} pending="Создаём заявку…">Создать заявку без оплаты</SubmitButton>
        </BookingActionForm>
      )}
    </Drawer>
  );
}

export type ContinuedRequest = { id: string; seq: number; name: string; phone: string; packageId: string | null; children: number | null; prepaymentKzt: number | null };

/** Payment receipt and reservation confirmation are separate, backend-verified steps. */
export function ContinueRequestForm({ request, rooms, packages, quick, branchId, date, closeHref, defaultRoomId, defaultStart }: {
  request: ContinuedRequest;
  rooms: { id: string; name: string }[];
  packages: BookingCatalogPackage[];
  quick: string[];
  branchId: string;
  date: string;
  closeHref: string;
  defaultRoomId?: string;
  defaultStart: string;
}) {
  const prepaid = request.prepaymentKzt !== null && request.prepaymentKzt > 0;
  return (
    <Drawer title={prepaid ? `Заявка №${request.seq}: подтвердить бронь` : `Заявка №${request.seq}: предоплата`} closeHref={closeHref}>
      <dl className="grid gap-1 rounded-xl bg-grape-50 p-3 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted">Клиент</dt><dd className="font-bold">{request.name}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Телефон</dt><dd className="font-bold">{request.phone}</dd></div>
        {request.children !== null ? <div className="flex justify-between gap-3"><dt className="text-muted">Детей</dt><dd className="font-bold">{request.children}</dd></div> : null}
      </dl>
      {prepaid ? (
        <>
          <p className="mt-3 rounded-xl bg-grape-50 p-3 text-sm font-bold text-grape-900">Предоплата {kzt.format(request.prepaymentKzt ?? 0)} ₸ уже записана в CRM. Повторно деньги не фиксируются. Подтверждение брони проверит оплату на сервере; комната будет занята только после успешного подтверждения.</p>
          <BookingActionForm action={confirmPaidRequestAction} className="mt-3 grid gap-2" label="Подтверждение оплаченной заявки">
            <Hidden branchId={branchId} />
            <input type="hidden" name="requestId" value={request.id} />
            <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
            <label className={label}>Комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <StartTimeField defaultValue={defaultStart} quick={quick} />
            <label className={label}>Пакет
              <select name="packageId" required defaultValue={request.packageId ?? undefined} className={field}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
            </label>
            <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Согласованная цена, ₸" aria-label="Согласованная цена" className={field} />
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <input name="childName" maxLength={80} placeholder="Именинник (имя)" aria-label="Имя именинника" className={field} />
              <input name="childAge" type="number" min={0} max={99} placeholder="Возраст" aria-label="Возраст именинника" className={field} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input name="childrenTotal" type="number" min={0} max={200} placeholder="Детей" aria-label="Детей с именинником" className={field} />
              <input name="adultsTotal" type="number" min={0} max={200} placeholder="Взрослых" aria-label="Взрослых" className={field} />
            </div>
            <select name="preferredLanguage" aria-label="Язык общения" defaultValue="" className={field}>
              <option value="">Язык общения не указан</option><option value="ru">Русский</option><option value="kk">Қазақша</option>
            </select>
            <textarea name="note" maxLength={300} placeholder="Комментарий" aria-label="Комментарий" className="min-h-20 rounded-xl border-2 border-grape-200 bg-white p-3 text-base" />
            <SubmitButton className={primary + " max-md:sticky max-md:bottom-0 max-md:z-10 max-md:min-h-11"} pending="Подтверждаем…">Подтвердить бронь</SubmitButton>
          </BookingActionForm>
        </>
      ) : (
        <BookingActionForm action={recordManualPrepaymentAction} className="mt-3 grid gap-2" label="Фиксация полученной предоплаты">
          <Hidden branchId={branchId} />
          <input type="hidden" name="requestId" value={request.id} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="roomId" value={defaultRoomId ?? rooms[0]?.id ?? ""} />
          <input type="hidden" name="startTime" value={defaultStart} />
          <label className={label}>Полученная сумма, ₸<input name="amountKzt" type="number" required min={10000} max={10000} step={1} inputMode="numeric" aria-label="Полученная сумма предоплаты" className={field} /></label>
          <label className={label}>Способ получения
            <select name="prepaymentMethod" required defaultValue="" className={field}>
              <option value="" disabled>Выберите способ</option>
              {Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-line p-3 text-sm font-bold text-grape-900">
            <input type="checkbox" name="receiptConfirmed" value="yes" required className="mt-0.5 h-5 w-5 shrink-0 accent-violet-700" />
            <span>Подтверждаю, что предоплата фактически получена</span>
          </label>
          <textarea name="note" maxLength={300} placeholder="Комментарий к полученной предоплате" aria-label="Комментарий к предоплате" className="min-h-20 rounded-xl border-2 border-grape-200 bg-white p-3 text-base" />
          <p className="text-xs text-muted">Это действие только фиксирует уже полученные 10 000 ₸ и не бронирует комнату. После подтверждения системы вы отдельно выберете слот и подтвердите бронь.</p>
          <SubmitButton className={primary + " max-md:sticky max-md:bottom-0 max-md:z-10 max-md:min-h-11"} pending="Проверяем и фиксируем…">Зафиксировать полученную предоплату</SubmitButton>
        </BookingActionForm>
      )}
    </Drawer>
  );
}
