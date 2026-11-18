import { randomUUID } from "node:crypto";
import Link from "next/link";
import { remainingKzt, paymentLabel } from "../../../core/booking-calendar.ts";
import type { BookingCatalogPackage, BookingTimelineReservation } from "../../../server/fastapi-crm.ts";
import { blockAction, continueRequestAction, createBookingAction, releaseAction, rescheduleAction } from "./crm-actions";
import { StartTimeField } from "./start-time-field";
import { SubmitButton } from "./submit-button";
import { clock } from "./timeline";

const kzt = new Intl.NumberFormat("ru-RU");
const field = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const label = "grid gap-1 text-xs font-extrabold text-muted";
const primary = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-50";
const ghost = "flex h-11 items-center justify-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50 disabled:opacity-50";
const METHOD_LABEL = { cash: "Наличные", card_terminal: "Терминал", bank_transfer: "Перевод", other_manual: "Другое" } as const;
/** The agreed manual prepayment of the business model. The manager can change it; nothing is recorded until the form is sent. */
const DEFAULT_PREPAYMENT_KZT = 10_000;

/** Right-hand panel (full screen on a phone). Server-rendered and driven by the address, so it works without client scripts. */
export function Drawer({ title, closeHref, children }: { title: string; closeHref: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title} data-drawer>
      <Link href={closeHref} scroll={false} aria-label="Закрыть" className="hidden flex-1 bg-ink/40 md:block" />
      <aside className="flex w-full flex-col overflow-y-auto bg-white p-4 shadow-2xl md:max-w-md">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-xl font-black text-grape-800">{title}</h2>
          <Link href={closeHref} scroll={false} className={ghost + " h-9 px-3"}>Закрыть</Link>
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
}) {
  const isBlock = r.kind === "block";
  const released = r.status === "released";
  const pay = paymentLabel(r, (n) => kzt.format(n));
  const remaining = remainingKzt(r);
  const dayLabel = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  return (
    <Drawer title={isBlock ? "Блокировка комнаты" : "Бронь праздника"} closeHref={closeHref}>
      <dl data-reservation-card={r.id}>
        <Row term="Статус">{released ? "Снята (история)" : isBlock ? "Блокировка" : "Подтверждена"}</Row>
        {isBlock ? null : <Row term="Клиент">{r.customerName ?? "Скрыто для вашей роли"}</Row>}
        {isBlock || !r.customerPhone ? null : <Row term="Телефон">{r.customerPhone}</Row>}
        <Row term="Пакет">{isBlock ? "—" : r.packageName ?? "не указан"}</Row>
        <Row term="Комната">{roomName}</Row>
        <Row term="Дата">{dayLabel}</Row>
        <Row term="Время">{clock(r.startsAt)}–{clock(r.endsAt)} (4 часа)</Row>
        {r.occupiedEndsAt !== r.endsAt ? <Row term="Занято до">{clock(r.occupiedEndsAt)} (с подготовкой)</Row> : null}
        {isBlock ? null : (
          <>
            <Row term="Сумма">{r.priceKzt != null ? `${kzt.format(r.priceKzt)} ₸${r.priceSource === "manager_agreed" ? "" : " (ориентир каталога)"}` : "не указана"}</Row>
            <Row term="Предоплата">{pay.tone === "prepaid" ? `${kzt.format(r.paidKzt)} ₸ записана вручную (не онлайн-оплата)` : "не записана"}</Row>
            <Row term="Остаток">{remaining !== null ? `${kzt.format(remaining)} ₸` : "неизвестен: нет согласованной цены"}</Row>
            <Row term="Ответственный">{r.createdByName ?? "не указан"}</Row>
          </>
        )}
        <Row term={isBlock ? "Причина" : "Комментарий"}>{r.note ?? "—"}</Row>
        {r.requestId ? <Row term="Заявка №">{r.requestId}</Row> : null}
        {released ? <Row term="Снята">{r.releasedAt ? clock(r.releasedAt) : "—"}</Row> : null}
      </dl>
      <p className="mt-3 rounded-xl bg-paper p-2 text-xs text-muted">
        Имя и возраст ребёнка, число детей и взрослых, аниматор и история изменений пока не отдаются API бронирования, поэтому здесь их нет. Ребёнок, указанный при создании, сохраняется в комментарии.
      </p>

      {released ? null : (
        <div className="mt-4 grid gap-3">
          {isBlock ? null : rescheduling ? (
            <form action={rescheduleAction} className="grid gap-2 rounded-2xl border border-line p-3" aria-label="Перенос брони">
              <h3 className="text-sm font-black text-grape-800">Перенести бронь</h3>
              <Hidden branchId={branchId} reservationId={r.id} />
              <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
              <label className={label}>Комната
                <select name="roomId" defaultValue={r.roomId} className={field}>{rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              </label>
              <StartTimeField defaultValue={clock(r.startsAt)} quick={hoursKnown ? quick : []} label="Новое начало" />
              <p className="text-xs text-muted">Перенос делает сервер одной операцией: если новое время занято, прежняя бронь остаётся. Предоплата не дублируется.</p>
              <div className="flex gap-2"><SubmitButton className={primary} pending="Переносим…">Перенести на 4 часа</SubmitButton><Link href={detailHref} scroll={false} className={ghost}>Отмена</Link></div>
            </form>
          ) : (
            <Link href={rescheduleHref} scroll={false} className={ghost}>Перенести бронь</Link>
          )}
          <details className="rounded-2xl border border-line p-3">
            <summary className="flex min-h-9 cursor-pointer items-center text-sm font-extrabold text-danger">{isBlock ? "Освободить комнату" : "Отменить бронь"}</summary>
            <form action={releaseAction} className="mt-2 grid gap-2">
              <Hidden branchId={branchId} reservationId={r.id} />
              <input type="hidden" name="date" value={date} />
              <input name="reason" maxLength={300} placeholder="Причина" aria-label="Причина" className={field} />
              <SubmitButton className={ghost} pending="Выполняем…">{isBlock ? "Освободить комнату" : "Отменить бронь"}</SubmitButton>
            </form>
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
    <Drawer title={mode === "block" ? "Заблокировать комнату" : "Добавить бронь"} closeHref={closeHref}>
      {mode === "block" ? (
        <form action={blockAction} className="grid gap-2" aria-label="Блокировка комнаты">
          <Hidden branchId={branchId} />
          <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
          <label className={label}>Комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <StartTimeField defaultValue={defaultStart} quick={quick} />
          <input name="reason" required maxLength={300} placeholder="Причина" aria-label="Причина блокировки" className={field} />
          <SubmitButton className={primary}>Заблокировать на 4 часа</SubmitButton>
        </form>
      ) : (
        <form action={createBookingAction} className="grid gap-2" aria-label="Новая бронь">
          <Hidden branchId={branchId} />
          <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
          <label className={label}>Комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <StartTimeField defaultValue={defaultStart} quick={quick} />
          <input name="customerName" required maxLength={120} placeholder="Клиент (имя)" aria-label="Имя клиента" className={field} />
          <input name="phone" type="tel" required maxLength={20} placeholder="+7 707 123 45 67" aria-label="Телефон" className={field} />
          <input name="childName" maxLength={80} placeholder="Ребёнок (имя, возраст) — уйдёт в комментарий" aria-label="Ребёнок" className={field} />
          <label className={label}>Пакет
            <select name="packageId" required className={field}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
          </label>
          <input name="guestCount" type="number" min={0} max={500} placeholder="Количество гостей" aria-label="Количество гостей" className={field} />
          <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Сумма праздника, ₸" aria-label="Сумма праздника" className={field} />
          <div className="grid grid-cols-2 gap-2">
            <input name="prepaymentKzt" type="number" required min={1} max={10000000} defaultValue={DEFAULT_PREPAYMENT_KZT} aria-label="Предоплата" className={field} />
            <select name="prepaymentMethod" required className={field} aria-label="Способ предоплаты">{Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <textarea name="note" maxLength={300} placeholder="Комментарий" aria-label="Комментарий" className="min-h-20 rounded-xl border-2 border-grape-200 bg-white p-3 text-base" />
          <p className="text-xs text-muted">Предоплата записывается менеджером вручную (по умолчанию 10 000 ₸) — это не онлайн-оплата. Бронь показывается как успешная только после того, как система бронирования подтвердила её и деньги при повторном чтении.</p>
          <SubmitButton className={primary} pending="Создаём бронь…">Создать заявку, записать предоплату и подтвердить</SubmitButton>
        </form>
      )}
    </Drawer>
  );
}

export type ContinuedRequest = { id: string; seq: number; name: string; phone: string; packageId: string | null; children: number | null; prepaymentKzt: number | null };

/** Books an existing request: the customer data comes from the request, nothing is typed twice, no new request is created. */
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
    <Drawer title={`Заявка №${request.seq}: подтвердить бронь`} closeHref={closeHref}>
      <form action={continueRequestAction} className="grid gap-2" aria-label="Подтверждение брони по заявке" data-testid="continue-request-form">
        <Hidden branchId={branchId} />
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <dl className="grid gap-1 rounded-xl bg-grape-50 p-3 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-muted">Клиент</dt><dd className="font-bold">{request.name}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Телефон</dt><dd className="font-bold">{request.phone}</dd></div>
          {request.children !== null ? <div className="flex justify-between gap-3"><dt className="text-muted">Детей</dt><dd className="font-bold">{request.children}</dd></div> : null}
        </dl>
        <label className={label}>Дата<input type="date" name="date" required defaultValue={date} className={field} /></label>
        <label className={label}>Комната<select name="roomId" required defaultValue={defaultRoomId} className={field}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <StartTimeField defaultValue={defaultStart} quick={quick} />
        <label className={label}>Пакет
          <select name="packageId" required defaultValue={request.packageId ?? undefined} className={field}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
        </label>
        <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Сумма праздника, ₸" aria-label="Сумма праздника" className={field} />
        {prepaid ? (
          <p className="text-sm font-bold text-grape-900">Предоплата уже записана вручную: {kzt.format(request.prepaymentKzt ?? 0)} ₸. Повторно она не записывается.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <input name="prepaymentKzt" type="number" required min={1} max={10000000} defaultValue={DEFAULT_PREPAYMENT_KZT} aria-label="Предоплата" className={field} />
            <select name="prepaymentMethod" required className={field} aria-label="Способ предоплаты">{Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
        )}
        <textarea name="note" maxLength={300} placeholder="Комментарий" aria-label="Комментарий" className="min-h-20 rounded-xl border-2 border-grape-200 bg-white p-3 text-base" />
        <p className="text-xs text-muted">Бронь продолжит эту заявку: новая заявка не создаётся. Предоплата — ручная запись менеджера, не онлайн-оплата.</p>
        <SubmitButton className={primary} pending="Подтверждаем…">{prepaid ? "Подтвердить бронь" : "Записать предоплату и подтвердить"}</SubmitButton>
      </form>
    </Drawer>
  );
}
