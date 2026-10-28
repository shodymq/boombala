import { randomUUID } from "node:crypto";
import { Fragment } from "react";
import Link from "next/link";
import {
  almatyDate,
  formatMinutes,
  isCalendarDate,
  assignLanes,
  GRID_OPEN_MIN,
  gridColumn,
  gridRangeColumns,
  overlappingIds,
  parseWorkingHours,
  bookedWithRealPayment,
  QUICK_STARTS,
  START_STEP_MINUTES,
  startOptions,
  type WorkingWindow,
} from "../../../core/booking-calendar.ts";
import { COLUMN_SPAN, COLUMN_START, LANE_START } from "../../../core/booking-grid-classes.ts";
import type { ValidSession } from "../../../core/session.ts";
import { withFastApiClient } from "../../../server/crm-actor.ts";
import { FastApiCrmError, type BookingCatalog, type BookingCatalogBranch, type BookingTimeline, type BookingTimelineReservation, type BirthdayLeadState } from "../../../server/fastapi-crm.ts";
import { blockAction, confirmPaidRequestAction, createBookingAction, rescheduleAction, releaseAction } from "./crm-actions";
import { FlashClean } from "./crm-flash-clean";

const NOTICES: Record<string, string> = {
  booked: "Бронь создана и подтверждена. Заявка и предоплата записаны.",
  blocked: "Время заблокировано.",
  released: "Бронь отменена, комната свободна.",
  rescheduled: "Бронь перенесена.",
};

const ERRORS: Record<string, string> = {
  paid_request_pending: "По этому клиенту уже есть оплаченная заявка, которая не подтверждена. Новая заявка и новая предоплата не созданы: подтвердите ту заявку ниже.",
  time_conflict: "Комната занята в это время: пересекается бронь или блокировка. Выберите другое время или комнату. Заявка и предоплата при этом сохраняются: выберите другое время в блоке «Оплаченная заявка».",
  slot_taken: "Комната занята в это время. Данные обновлены.",
  outside_working_hours: "Выбранное время выходит за часы работы филиала.",
  branch_hours_unknown: "Часы работы филиала не распознаны, поэтому бронирование отключено.",
  start_in_past: "Нельзя занять прошедшее время.",
  invalid_start_time: "Время начала должно идти с шагом 15 минут.",
  birthday_prepayment_required: "Чтобы подтвердить бронь, сначала нужна предоплата.",
  birthday_request_not_bookable: "Заявка не может быть забронирована в текущем статусе.",
  birthday_request_not_payable: "По этой заявке нельзя записать предоплату.",
  request_already_booked: "По этой заявке уже есть бронь.",
  reservation_not_found: "Бронь не найдена. Обновите страницу.",
  reservation_already_released: "Бронь уже отменена. Обновите страницу.",
  idempotency_conflict: "Это действие уже выполнялось с другими данными. Обновите страницу и проверьте календарь.",
  idempotency_in_progress: "Это действие уже выполняется. Обновите страницу, чтобы увидеть результат.",
  forbidden: "Недостаточно прав для этого действия.",
  branch_access_denied: "Этот филиал недоступен для вашей учётной записи.",
  invalid: "Проверьте введённые данные.",
  unavailable: "Система бронирования временно недоступна. Ничего не подтверждено, попробуйте позже.",
  failed: "Не удалось выполнить действие. Обновите страницу и проверьте календарь.",
};

const STATUS_LABEL = { confirmed: "Подтверждено", blocked: "Заблокировано", released: "Снято" } as const;
const METHOD_LABEL = { cash: "Наличные", card_terminal: "Терминал", bank_transfer: "Перевод", other_manual: "Другое" } as const;
const kzt = new Intl.NumberFormat("ru-RU");
const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-50";
const btnGhost = "flex h-11 items-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

type Search = { branch?: string; date?: string; start?: string; ok?: string; reservation?: string; error?: string; request?: string };

/** The state a successful action must produce in FastAPI. Anything else is shown as not confirmed. */
const EXPECTED_STATUS: Record<string, "confirmed" | "blocked" | "released"> = { booked: "confirmed", rescheduled: "confirmed", blocked: "blocked", released: "released" };

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Grid columns outside the branch's working hours, shaded so a closed hour never reads as bookable. */
function closedColumns(hours: WorkingWindow | null) {
  if (!hours) return [];
  return [gridRangeColumns(GRID_OPEN_MIN, hours.openMin), gridRangeColumns(hours.closeMin, 24 * 60)].filter(
    (x): x is { start: number; span: number } => x !== null,
  );
}

function hour(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export async function CrmCalendar({ session, search }: { session: ValidSession; search: Search }) {
  const today = almatyDate();
  const date = isCalendarDate(search.date) ? search.date : today;
  let catalog: BookingCatalog | null = null;
  let timeline: BookingTimeline | null = null;
  let branch: BookingCatalogBranch | undefined;
  let requestState: BirthdayLeadState | null = null;
  let bookingLead: BirthdayLeadState | null = null;
  try {
    const loaded = await withFastApiClient(session, async (client) => {
      const cat = await client.getBookingCatalog();
      const branches = [...cat.branches].sort((a, b) => a.name.localeCompare(b.name, "ru"));
      // For an operator the server returns only the assigned branch, so a foreign branch in the URL falls back to the first
      // visible one and is never requested from FastAPI.
      const picked = branches.find((b) => b.id === search.branch) ?? branches[0];
      const tl = picked ? await client.getBookingTimeline(picked.id, date) : null;
      // A failed or refused read is "unknown", never "unpaid" and never "booked".
      const lead = search.request ? await client.getBirthdayLead(search.request).then((x) => x as BirthdayLeadState).catch(() => null) : null;
      // A success is shown only with the money behind it: read the request of the reservation the URL names, if any.
      const named = tl?.reservations.find((r) => r.id === search.reservation);
      const bookingLead = named?.requestId ? await client.getBirthdayLead(named.requestId).then((x) => x as BirthdayLeadState).catch(() => null) : null;
      return { cat, picked, tl, lead, bookingLead };
    });
    catalog = loaded.cat;
    branch = loaded.picked;
    timeline = loaded.tl;
    requestState = loaded.lead;
    bookingLead = loaded.bookingLead;
  } catch (error) {
    // Fail closed: no grid, no guessed availability. Only the code is logged.
    console.error("[crm-calendar] load failed:", error instanceof FastApiCrmError ? `${error.status} ${error.code}` : "unexpected");
    return (
      <div className="grid gap-5">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
        <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Не удалось загрузить календарь из системы бронирования. Данные не показаны, чтобы не вводить в заблуждение. Обновите страницу позже.</p>
      </div>
    );
  }
  if (!catalog || !branch || !timeline) {
    return <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Для вашей учётной записи нет доступных филиалов.</p>;
  }

  const branches = [...catalog.branches].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const rooms = catalog.rooms.filter((r) => r.branchId === branch.id);
  const packages = catalog.packages.filter((p) => p.branchId === branch.id);
  const hours = parseWorkingHours(branch.workingHours);
  const starts = hours ? startOptions(hours) : [];
  const active = timeline.reservations.filter((r) => r.status !== "released");
  // The kernel decides on occupiedEndsAt (party plus buffer). This flag is a UX hint, never the authority.
  const flagged = overlappingIds(active.map((r) => ({ id: r.id, roomId: r.roomId, startsAt: r.startsAt, endsAt: r.occupiedEndsAt })));
  const hourMarks: number[] = [];
  for (let m = GRID_OPEN_MIN; m < 24 * 60; m += 60) hourMarks.push(m);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const errorText = search.error && ERRORS[search.error];
  const newStart = search.start && starts.includes(search.start) ? search.start : starts[0] ?? "";
  const branchQuery = { branch: branch.id, date };
  // Success is shown only when FastAPI's timeline holds the reservation in the expected state. The URL is a hint.
  const expected = search.ok ? EXPECTED_STATUS[search.ok] : undefined;
  const confirmedRecord = search.reservation && expected ? timeline.reservations.find((r) => r.id === search.reservation) : undefined;
  // Booked and rescheduled need the money too: the reservation's payment and the request's manual fact must both be there.
  const moneyRequired = search.ok === "booked" || search.ok === "rescheduled";
  const verifiedOk =
    confirmedRecord && expected && confirmedRecord.status === expected && (!moneyRequired || bookedWithRealPayment(confirmedRecord, bookingLead))
      ? search.ok
      : null;
  const unverifiedOk = Boolean(search.ok) && !verifiedOk;
  // A paid request that is not booked, as FastAPI reports it, blocks new bookings: the manager confirms that request.
  const pendingPaid = requestState && requestState.bookedAt == null && requestState.manualPaymentFactStatus === "prepaid" && requestState.manualPaymentFactAmountKzt > 0 ? requestState : null;
  const paidPending = pendingPaid ? pendingPaid.id : null;

  return (
    <div className="grid min-w-0 gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
      {search.ok || search.error ? <FlashClean /> : null}
      {verifiedOk ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[verifiedOk]} Проверено по данным системы.</p> : null}
      {unverifiedOk ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Результат действия не подтверждён системой. Обновите страницу и проверьте список ниже: без этого ничего не считается выполненным.</p> : null}
      {errorText ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{errorText}</p> : null}
      {search.request ? (
        requestState ? (
          <div role="alert" className="grid gap-1 rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
            <p>Заявка № {search.request}. Бронь: {requestState.bookedAt ? "подтверждена" : "НЕ подтверждена"}.</p>
            <p>
              Предоплата: {requestState.manualPaymentFactStatus === "prepaid" && requestState.manualPaymentFactAmountKzt > 0
                ? `записана вручную, ${kzt.format(requestState.manualPaymentFactAmountKzt)} ₸ (не онлайн-оплата)`
                : "не записана"}.
            </p>
            <p>{pendingPaid ? "Ниже можно подтвердить эту заявку на другое время без повторной предоплаты." : "Разберите заявку в разделе «Заявки». Не создавайте новую заявку по этому же клиенту."}</p>
          </div>
        ) : (
          <div role="alert" className="grid gap-1 rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
            <p>Не удалось прочитать заявку № {search.request} из системы. Состояние оплаты неизвестно: проверьте раздел «Заявки». Новую заявку и предоплату по этому клиенту не создавайте.</p>
          </div>
        )
      ) : null}

      <nav aria-label="Филиал и дата" className="flex flex-wrap items-end gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs font-extrabold text-muted">
            Филиал
            <select name="branch" defaultValue={branch.id} className={input + " min-w-48"}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-extrabold text-muted">
            Дата
            <input type="date" name="date" defaultValue={date} className={input + " w-auto"} />
          </label>
          <button type="submit" className={btn}>Показать</button>
        </form>
        <div className="flex items-center gap-2">
          <Link href={{ pathname: "/bookings", query: { ...branchQuery, date: shiftDate(date, -1) } }} className={btnGhost} aria-label="Предыдущий день">←</Link>
          <Link href={{ pathname: "/bookings", query: { ...branchQuery, date: shiftDate(date, 1) } }} className={btnGhost} aria-label="Следующий день">→</Link>
          <Link href={{ pathname: "/bookings", query: { ...branchQuery, date: today } }} className="text-sm font-extrabold text-grape-700 underline">Сегодня</Link>
        </div>
      </nav>
      <p className="text-base font-bold text-grape-900 first-letter:uppercase">
        {weekday} · {branch.name} · часы {hours ? branch.workingHours : "не распознаны"} · подготовка после брони {timeline.bufferMinutes} мин
      </p>
      {!hours ? <p className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Часы работы филиала не распознаны. Бронирование отключено, до исправления часов работы показывается только занятость.</p> : null}

      <section aria-label="Комнаты" className="grid gap-2">
        <div className="overflow-x-auto rounded-3xl border border-line bg-white p-3">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <span />
              <div className="grid grid-cols-[repeat(60,minmax(0,1fr))] text-xs font-bold text-muted">
                {hourMarks.map((m) => (
                  <span key={m} className={`${COLUMN_START[(m - GRID_OPEN_MIN) / START_STEP_MINUTES + 1]} col-span-4`}>{hour(m)}</span>
                ))}
              </div>
            </div>
            {rooms.map((room) => {
              const items = active
                .filter((r) => r.roomId === room.id)
                .map((r) => ({ reservation: r, column: gridColumn(r.startsAt, r.endsAt), buffer: gridColumn(r.endsAt, r.occupiedEndsAt), occupied: gridColumn(r.startsAt, r.occupiedEndsAt) }))
                .filter((x): x is { reservation: BookingTimelineReservation; column: { start: number; span: number }; buffer: { start: number; span: number } | null; occupied: { start: number; span: number } } => x.column !== null && x.occupied !== null);
              const lanes = assignLanes(items.map((x) => ({ id: x.reservation.id, start: x.occupied.start, span: x.occupied.span })));
              return (
                <div key={room.id} className="mt-2 grid grid-cols-[8rem_1fr] gap-2">
                  <h2 className="self-center text-sm font-black text-grape-800">{room.name}</h2>
                  <div className="relative grid auto-rows-[2.75rem] grid-cols-[repeat(60,minmax(0,1fr))] gap-y-1 rounded-xl border border-grape-100 bg-paper py-1" role="list" aria-label={`Занятость: ${room.name}`}>
                    {closedColumns(hours).map((range) => (
                      <div key={`${range.start}-${range.span}`} aria-hidden="true" className={`${COLUMN_START[range.start]} ${COLUMN_SPAN[range.span]} row-start-1 row-span-1 self-stretch bg-line/30`} />
                    ))}
                    {items.map(({ reservation: r, column, buffer }) => {
                      const conflict = flagged.has(r.id);
                      const tone = conflict ? "border-red-700 bg-red-100" : r.kind === "block" ? "border-muted bg-sun-100" : "border-grape-600 bg-grape-100";
                      const lane = LANE_START[lanes.get(r.id) ?? 1];
                      return (
                        <Fragment key={r.id}>
                          <div
                            role="listitem"
                            data-reservation={r.id}
                            data-state={conflict ? "conflict" : r.kind === "block" ? "blocked" : "booked"}
                            className={`${COLUMN_START[column.start]} ${COLUMN_SPAN[column.span]} ${lane} z-10 mx-px min-w-0 overflow-hidden rounded-lg border-2 px-2 py-1 text-xs ${tone}`}
                          >
                            <p className="truncate font-black text-grape-900">{clock(r.startsAt)}–{clock(r.endsAt)} · {r.kind === "block" ? "Блок" : STATUS_LABEL[r.status]}{conflict ? " · конфликт" : ""}</p>
                            <p className="truncate text-grape-900">{r.kind === "block" ? r.note ?? "" : r.customerName ?? "Клиент скрыт"}</p>
                          </div>
                          {buffer ? (
                            <div
                              aria-hidden="true"
                              data-buffer={r.id}
                              className={`${COLUMN_START[buffer.start]} ${COLUMN_SPAN[buffer.span]} ${lane} z-10 mx-px min-w-0 overflow-hidden rounded-lg border border-dashed border-muted bg-line/60 px-2 py-1 text-[11px] font-bold text-muted`}
                            >
                              буфер до {clock(r.occupiedEndsAt)}
                            </div>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-xs font-bold text-muted">Серый фон — свободно. Бежевый — блокировка. Сиреневый — бронь. Пунктир — буфер подготовки после брони. Красный — пересечение, которого быть не должно: сообщите администратору.</p>
      </section>

      {hours ? (
        <section aria-label="Быстрый выбор начала" className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-extrabold text-grape-800">Быстрый старт:</span>
          {QUICK_STARTS.filter((s) => starts.includes(s)).map((s) => (
            <Link key={s} href={{ pathname: "/bookings", query: { ...branchQuery, start: s } }} className={btnGhost}>{s}</Link>
          ))}
          <span className="text-xs text-muted">Любой старт с шагом 15 минут также доступен в форме.</span>
        </section>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        {paidPending ? (
          <section aria-labelledby="paid-request" className="grid gap-3 rounded-3xl border-2 border-sun-600 bg-white p-4">
            <h2 id="paid-request" className="text-lg font-black text-grape-800">Оплаченная заявка № {paidPending}</h2>
            <p className="text-sm text-grape-900">Предоплата {kzt.format(pendingPaid?.manualPaymentFactAmountKzt ?? 0)} ₸ записана вручную в системе. Бронь НЕ подтверждена. Подтвердите её на выбранные комнату и время: новая предоплата не записывается.</p>
            {hours && packages.length > 0 && rooms.length > 0 ? (
              <form action={confirmPaidRequestAction} className="grid gap-2">
                <input type="hidden" name="branchId" value={branch.id} />
                <input type="hidden" name="date" value={date} />
                <input type="hidden" name="requestId" value={paidPending} />
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <label className="grid gap-1 text-xs font-extrabold text-muted">Комната
                  <select name="roomId" required className={input}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                </label>
                <label className="grid gap-1 text-xs font-extrabold text-muted">Начало
                  <select name="startTime" required defaultValue={newStart} className={input}>{starts.map((s) => <option key={s} value={s}>{s}–{formatMinutes(Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) + 240)}</option>)}</select>
                </label>
                <label className="grid gap-1 text-xs font-extrabold text-muted">Пакет
                  <select name="packageId" required className={input}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (ориентир от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
                </label>
                <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Согласованная цена, ₸" aria-label="Согласованная цена" className={input} />
                <button type="submit" className={btn}>Подтвердить без повторной предоплаты</button>
              </form>
            ) : <p className="text-sm font-bold text-muted">Подтверждение недоступно: нет часов работы, комнат или пакетов.</p>}
          </section>
        ) : (
        <section aria-labelledby="new-booking" className="grid gap-3 rounded-3xl border border-line bg-white p-4">
          <h2 id="new-booking" className="text-lg font-black text-grape-800">Новая бронь на 4 часа</h2>
          {hours && packages.length > 0 && rooms.length > 0 ? (
            <form action={createBookingAction} className="grid gap-2">
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <label className="grid gap-1 text-xs font-extrabold text-muted">Комната
                <select name="roomId" required className={input}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </label>
              <label className="grid gap-1 text-xs font-extrabold text-muted">Начало
                <select name="startTime" required defaultValue={newStart} className={input}>{starts.map((s) => <option key={s} value={s}>{s}–{formatMinutes(Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) + 240)}</option>)}</select>
              </label>
              <label className="grid gap-1 text-xs font-extrabold text-muted">Пакет
                <select name="packageId" required className={input}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (ориентир от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
              </label>
              <input name="customerName" required maxLength={120} placeholder="Имя клиента" aria-label="Имя клиента" className={input} />
              <input name="phone" type="tel" required maxLength={20} placeholder="+7 707 123 45 67" aria-label="Телефон" className={input} />
              <input name="guestCount" type="number" min={0} max={500} placeholder="Гостей" aria-label="Количество гостей" className={input} />
              <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Согласованная цена, ₸" aria-label="Согласованная цена" className={input} />
              <div className="grid grid-cols-2 gap-2">
                <input name="prepaymentKzt" type="number" required min={1} max={10000000} placeholder="Предоплата, ₸" aria-label="Предоплата" className={input} />
                <select name="prepaymentMethod" required className={input} aria-label="Способ предоплаты">
                  {Object.entries(METHOD_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
              <textarea name="note" maxLength={300} placeholder="Заметка" aria-label="Заметка" className="min-h-20 rounded-xl border-2 border-grape-200 bg-white p-3 text-base" />
              <p className="text-xs text-muted">Предоплата записывается вручную менеджером; это не онлайн-оплата. Бронь подтверждается только после записи предоплаты и успешного подтверждения.</p>
              <button type="submit" className={btn}>Создать заявку, записать предоплату и подтвердить</button>
            </form>
          ) : (
            <p className="text-sm font-bold text-muted">{!hours ? "Бронирование отключено: часы филиала не распознаны." : "Нет активных пакетов или комнат для этого филиала."}</p>
          )}
        </section>
        )}

        <section aria-labelledby="block" className="grid gap-3 rounded-3xl border border-line bg-white p-4">
          <h2 id="block" className="text-lg font-black text-grape-800">Ручная блокировка</h2>
          {hours && rooms.length > 0 ? (
            <form action={blockAction} className="grid gap-2">
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <select name="roomId" required className={input} aria-label="Комната блокировки">{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              <select name="startTime" required defaultValue={newStart} className={input} aria-label="Начало блокировки">{starts.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <input name="reason" required maxLength={300} placeholder="Причина" aria-label="Причина блокировки" className={input} />
              <button type="submit" className={btnGhost}>Заблокировать на 4 часа</button>
            </form>
          ) : <p className="text-sm font-bold text-muted">Блокировка недоступна: нет часов работы или комнат.</p>}
        </section>
      </div>

      <section aria-labelledby="day-list" className="grid gap-3">
        <h2 id="day-list" className="text-lg font-black text-grape-800">Бронирования и блоки на день ({active.length}) · история: {timeline.reservations.length - active.length}</h2>
        {timeline.reservations.length === 0 ? <p className="text-sm font-bold text-muted">На эту дату ничего не забронировано.</p> : null}
        {[...timeline.reservations].sort((x, y) => x.startsAt.localeCompare(y.startsAt)).map((r) => (
          <ReservationRow key={r.id} r={r} rooms={rooms} starts={starts} branchId={branch.id} date={date} conflict={flagged.has(r.id)} />
        ))}
      </section>
    </div>
  );
}

function ReservationRow({
  r,
  rooms,
  starts,
  branchId,
  date,
  conflict,
}: {
  r: BookingTimelineReservation;
  rooms: { id: string; name: string }[];
  starts: string[];
  branchId: string;
  date: string;
  conflict: boolean;
}) {
  const roomName = rooms.find((x) => x.id === r.roomId)?.name ?? "—";
  const history = r.status === "released";
  const payment = r.paymentStatus === "prepaid" && r.paidKzt > 0 ? `предоплата записана вручную: ${kzt.format(r.paidKzt)} ₸ (не онлайн-оплата)` : "предоплата не записана";
  return (
    <article className={`grid gap-2 rounded-2xl border-2 p-4 ${conflict ? "border-red-700 bg-red-50" : "border-line bg-white"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-base font-black text-grape-800">{roomName} · {clock(r.startsAt)}–{clock(r.endsAt)} · {r.kind === "block" ? "Блокировка" : STATUS_LABEL[r.status]}</p>
        {conflict ? <p className="text-sm font-black text-red-800">Пересечение: сообщите администратору</p> : null}
      </div>
      <p className="text-xs text-muted">Занято до {clock(r.occupiedEndsAt)} включая буфер подготовки</p>
      <p className="break-words text-sm text-grape-900">
        {r.kind === "block" ? r.note ?? "Без причины" : `${r.customerName ?? "Клиент скрыт"}${r.customerPhone ? ` · ${r.customerPhone}` : ""} · ${r.packageName ?? "пакет не указан"}${r.priceKzt != null ? ` · ${kzt.format(r.priceKzt)} ₸` : ""} · ${payment}`}
      </p>
      {r.kind === "booking" && r.createdByName ? <p className="text-xs text-muted">Ответственный: {r.createdByName}</p> : null}
      {history ? <p className="text-sm font-bold text-muted">Отменено {r.releasedAt ? clock(r.releasedAt) : ""}. Интервал свободен; запись сохранена для истории.</p> : null}
      {history ? null : <div className="flex flex-wrap gap-2">
        <details className="min-w-0">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">Перенести</summary>
          <form action={rescheduleAction} className="mt-2 grid gap-2">
            <input type="hidden" name="branchId" value={branchId} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="reservationId" value={r.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <select name="roomId" defaultValue={r.roomId} className={input} aria-label="Комната">{rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <select name="startTime" required defaultValue={clock(r.startsAt)} className={input} aria-label="Новое начало">{starts.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <button type="submit" className={btnGhost}>Перенести на 4 часа</button>
          </form>
        </details>
        <details className="min-w-0">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">{r.kind === "block" ? "Снять блокировку" : "Отменить бронь"}</summary>
          <form action={releaseAction} className="mt-2 grid gap-2">
            <input type="hidden" name="branchId" value={branchId} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="reservationId" value={r.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <input name="reason" maxLength={300} placeholder="Причина" aria-label="Причина" className={input} />
            <button type="submit" className={btnGhost}>{r.kind === "block" ? "Снять блокировку" : "Отменить бронь"}</button>
          </form>
        </details>
      </div>}
    </article>
  );
}
