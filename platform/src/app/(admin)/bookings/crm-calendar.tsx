import { randomUUID } from "node:crypto";
import Link from "next/link";
import {
  almatyDate,
  dayAxis,
  isCalendarDate,
  openRequestsForDate,
  parseWorkingHours,
  bookedWithRealPayment,
  startOptions,
} from "../../../core/booking-calendar.ts";
import type { ValidSession } from "../../../core/session.ts";
import { withFastApiClient } from "../../../server/crm-actor.ts";
import { FastApiCrmError, type BookingCatalog, type BookingCatalogBranch, type BookingTimeline, type BirthdayLeadState, type FastApiLeadListItem } from "../../../server/fastapi-crm.ts";
import { NewBookingForm, ReservationDetails } from "./booking-drawer";
import { confirmPaidRequestAction } from "./crm-actions";
import { FlashClean } from "./crm-flash-clean";
import { StartTimeField } from "./start-time-field";
import { SubmitButton } from "./submit-button";
import { clock, DayTimeline, TimelineLegend } from "./timeline";

const NOTICES: Record<string, string> = {
  booked: "Бронь создана и подтверждена. Заявка и предоплата записаны.",
  blocked: "Время заблокировано.",
  released: "Бронь отменена, комната свободна.",
  rescheduled: "Бронь перенесена.",
};

const ERRORS: Record<string, string> = {
  paid_request_pending: "По этому клиенту уже есть оплаченная заявка, которая не подтверждена. Новая заявка и новая предоплата не созданы: подтвердите ту заявку ниже.",
  time_conflict: "Комната занята в это время: пересекается бронь или блокировка. Ничего не подтверждено. Выберите другое время или комнату. Если по клиенту уже записана предоплата, это показано в сообщении о заявке.",
  slot_taken: "Комната занята в это время. Данные обновлены.",
  outside_working_hours: "Выбранное время выходит за часы работы филиала.",
  branch_hours_unknown: "Часы работы филиала не распознаны, поэтому бронирование отключено.",
  start_in_past: "Нельзя занять прошедшее время.",
  invalid_start_time: "Сервер бронирования не принял это время начала. Укажите корректное время в пределах часов работы филиала. Бронь не подтверждена.",
  invalid_booking_duration: "Бронь должна длиться ровно 4 часа. Бронь не подтверждена.",
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

const kzt = new Intl.NumberFormat("ru-RU");
const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600 disabled:opacity-50";
const btnGhost = "flex h-11 items-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

type Search = { branch?: string; date?: string; ok?: string; reservation?: string; error?: string; request?: string; new?: string; block?: string; move?: string; room?: string; start?: string };

/** The state a successful action must produce in FastAPI. Anything else is shown as not confirmed. */
const EXPECTED_STATUS: Record<string, "confirmed" | "blocked" | "released"> = { booked: "confirmed", rescheduled: "confirmed", blocked: "blocked", released: "released" };

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export async function CrmCalendar({ session, search }: { session: ValidSession; search: Search }) {
  const today = almatyDate();
  const date = isCalendarDate(search.date) ? search.date : today;
  let catalog: BookingCatalog | null = null;
  let timeline: BookingTimeline | null = null;
  let branch: BookingCatalogBranch | undefined;
  let requestState: BirthdayLeadState | null = null;
  let bookingLead: BirthdayLeadState | null = null;
  // null means "unknown": a failed read of requests is never shown as zero requests.
  let openRequests: FastApiLeadListItem[] | null = null;
  let requestsTruncated = false;
  try {
    const loaded = await withFastApiClient(session, async (client) => {
      const cat = await client.getBookingCatalog();
      const branches = [...cat.branches].sort((a, b) => a.name.localeCompare(b.name, "ru"));
      // For an operator the server returns only the assigned branch, so a foreign branch in the URL falls back to the first
      // visible one and is never requested from FastAPI.
      const picked = branches.find((b) => b.id === search.branch) ?? branches[0];
      const tl = picked ? await client.getBookingTimeline(picked.id, date) : null;
      const lead = search.request ? await client.getBirthdayLead(search.request).then((x) => x as BirthdayLeadState).catch(() => null) : null;
      const named = tl?.reservations.find((r) => r.id === search.reservation);
      const bookingLead = named?.requestId ? await client.getBirthdayLead(named.requestId).then((x) => x as BirthdayLeadState).catch(() => null) : null;
      const leads = picked ? await client.listLeads({ branchId: picked.id }).catch(() => null) : null;
      return { cat, picked, tl, lead, bookingLead, leads };
    });
    catalog = loaded.cat;
    branch = loaded.picked;
    timeline = loaded.tl;
    requestState = loaded.lead;
    bookingLead = loaded.bookingLead;
    if (loaded.leads) {
      openRequests = openRequestsForDate(loaded.leads.items, date);
      requestsTruncated = loaded.leads.total > loaded.leads.items.length;
    }
  } catch (error) {
    // Fail closed: no grid, no guessed availability. Only the code is logged.
    console.error("[crm-calendar] load failed:", error instanceof FastApiCrmError ? `${error.status} ${error.code}` : "unexpected");
    return (
      <div className="grid gap-5">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
        <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Не удалось загрузить календарь из системы бронирования. Расписание не показано, чтобы пустая сетка не выглядела как свободные комнаты. Обновите страницу позже.</p>
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
  const quick = hours ? startOptions(hours) : [];
  const defaultStart = quick.includes("13:00") ? "13:00" : quick[0] ?? "13:00";
  const active = timeline.reservations.filter((r) => r.status !== "released");
  const released = timeline.reservations.filter((r) => r.status === "released");
  const axis = dayAxis(hours, active);
  const bookings = active.filter((r) => r.kind === "booking");
  const blocks = active.filter((r) => r.kind === "block");

  const q = (extra: Record<string, string | undefined> = {}, base: Record<string, string> = { branch: branch.id, date }) => {
    const params = new URLSearchParams(base);
    for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
    return `/bookings?${params.toString()}`;
  };
  const dayHref = q();
  // After an action `reservation` only names the record to verify; the card opens only for a plain click on a block.
  const selected = search.reservation && !search.ok && !search.error ? timeline.reservations.find((r) => r.id === search.reservation) : undefined;

  // Success is shown only when FastAPI's timeline holds the reservation in the expected state. The URL is a hint.
  const expected = search.ok ? EXPECTED_STATUS[search.ok] : undefined;
  const confirmedRecord = search.reservation && expected ? timeline.reservations.find((r) => r.id === search.reservation) : undefined;
  const moneyRequired = search.ok === "booked" || search.ok === "rescheduled";
  const verifiedOk =
    confirmedRecord && expected && confirmedRecord.status === expected && (!moneyRequired || bookedWithRealPayment(confirmedRecord, bookingLead))
      ? search.ok
      : null;
  const unverifiedOk = Boolean(search.ok) && !verifiedOk;
  const errorText = search.error && ERRORS[search.error];
  const pendingPaid = requestState && requestState.bookedAt == null && requestState.manualPaymentFactStatus === "prepaid" && requestState.manualPaymentFactAmountKzt > 0 ? requestState : null;
  const paidPending = pendingPaid ? pendingPaid.id : null;

  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const summary = [
    dayMonth,
    `${rooms.length} ${plural(rooms.length, "комната", "комнаты", "комнат")}`,
    `${bookings.length} ${plural(bookings.length, "бронь", "брони", "броней")}`,
    ...(blocks.length ? [`${blocks.length} ${plural(blocks.length, "блокировка", "блокировки", "блокировок")}`] : []),
    openRequests === null
      ? "заявки: нет данных"
      : `${openRequests.length}${requestsTruncated ? "+" : ""} ${plural(openRequests.length, "заявка ожидает", "заявки ожидают", "заявок ожидают")} решения`,
  ].join(" · ");

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
        {hours && packages.length > 0 && rooms.length > 0 ? (
          <Link href={q({ new: "1" })} scroll={false} className={btn + " flex items-center"}>Добавить бронь</Link>
        ) : null}
      </div>
      {search.ok || search.error ? <FlashClean /> : null}
      {verifiedOk ? <p role="status" className="rounded-2xl bg-green-100 p-3 text-sm font-bold text-grape-900">{NOTICES[verifiedOk]} Проверено по данным системы.</p> : null}
      {unverifiedOk ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Результат действия не подтверждён системой. Обновите страницу и проверьте календарь: без этого ничего не считается выполненным.</p> : null}
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

      <nav aria-label="Дата и филиал" className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <Link href={q({}, { branch: branch.id, date: shiftDate(date, -1) })} className={btnGhost} aria-label="Предыдущий день">←</Link>
          <Link href={q({}, { branch: branch.id, date: today })} className={btnGhost + (date === today ? " bg-grape-50" : "")}>Сегодня</Link>
          <Link href={q({}, { branch: branch.id, date: shiftDate(date, 1) })} className={btnGhost} aria-label="Следующий день">→</Link>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          {branches.length > 1 ? (
            <label className="grid gap-1 text-xs font-extrabold text-muted">Филиал
              <select name="branch" defaultValue={branch.id} className={input + " min-w-44"}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </label>
          ) : <input type="hidden" name="branch" value={branch.id} />}
          <label className="grid gap-1 text-xs font-extrabold text-muted">Дата
            <input type="date" name="date" defaultValue={date} className={input + " w-auto"} />
          </label>
          <button type="submit" className={btnGhost}>Показать</button>
        </form>
      </nav>
      <p className="text-sm font-black text-grape-900 first-letter:uppercase" data-summary>{weekday} · {branch.name}</p>
      <p className="text-base font-bold text-grape-900" data-summary-counts>{summary}</p>
      {!hours ? <p className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Часы работы филиала не распознаны. Бронирование отключено, до исправления часов работы показывается только занятость.</p> : null}

      <section aria-label="Расписание комнат" className="grid gap-2">
        {rooms.length === 0 ? (
          <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Для этого филиала нет комнат в системе бронирования.</p>
        ) : (
          <DayTimeline rooms={rooms} reservations={timeline.reservations} axis={axis} hours={hours} hrefFor={(id) => q({ reservation: id })} selectedId={selected?.id} />
        )}
        {active.length === 0 && rooms.length > 0 ? <p className="text-sm font-bold text-muted" data-empty>На эту дату система не вернула ни одной брони или блокировки.</p> : null}
        <TimelineLegend />
      </section>

      {paidPending ? (
        <section aria-labelledby="paid-request" className="grid gap-3 rounded-3xl border-2 border-sun-400 bg-white p-4">
          <h2 id="paid-request" className="text-lg font-black text-grape-800">Оплаченная заявка № {paidPending}</h2>
          <p className="text-sm text-grape-900">Предоплата {kzt.format(pendingPaid?.manualPaymentFactAmountKzt ?? 0)} ₸ записана вручную в системе. Бронь НЕ подтверждена. Подтвердите её на выбранные комнату и время: новая предоплата не записывается.</p>
          {hours && packages.length > 0 && rooms.length > 0 ? (
            <form action={confirmPaidRequestAction} className="grid max-w-md gap-2">
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="requestId" value={paidPending} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <label className="grid gap-1 text-xs font-extrabold text-muted">Комната
                <select name="roomId" required className={input}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </label>
              <StartTimeField defaultValue={defaultStart} quick={quick} />
              <label className="grid gap-1 text-xs font-extrabold text-muted">Пакет
                <select name="packageId" required className={input}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} (ориентир от {kzt.format(p.priceFrom)} ₸)</option>)}</select>
              </label>
              <input name="agreedPriceKzt" type="number" required min={1} max={10000000} placeholder="Согласованная цена, ₸" aria-label="Согласованная цена" className={input} />
              <SubmitButton className={btn} pending="Подтверждаем…">Подтвердить без повторной предоплаты</SubmitButton>
            </form>
          ) : <p className="text-sm font-bold text-muted">Подтверждение недоступно: нет часов работы, комнат или пакетов.</p>}
        </section>
      ) : null}

      <section aria-labelledby="requests" className="grid gap-2 rounded-3xl border border-line bg-white p-4">
        <h2 id="requests" className="text-lg font-black text-grape-800">Заявки на эту дату без подтверждённой брони</h2>
        {openRequests === null ? (
          <p role="alert" className="text-sm font-bold text-grape-900">Не удалось прочитать заявки. Количество неизвестно.</p>
        ) : openRequests.length === 0 ? (
          <p className="text-sm font-bold text-muted">Нет заявок, ожидающих решения{requestsTruncated ? " среди загруженных (список в системе длиннее, проверьте раздел «Заявки»)" : ""}.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {openRequests.map((l) => <li key={l.id} className="font-bold text-grape-900">{l.customerName} · статус «{l.status}» · не занимает комнату</li>)}
          </ul>
        )}
        <p className="text-xs text-muted">Заявка занимает комнату только после подтверждения брони менеджером в системе бронирования. Запись из бумажного журнала или Google Sheets сначала вносится сюда кнопкой «Добавить бронь».</p>
        <Link href="/requests?status=new" className="text-sm font-extrabold text-grape-700 underline">Открыть раздел «Заявки»</Link>
      </section>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {hours && rooms.length > 0 ? <Link href={q({ block: "1" })} scroll={false} className="font-extrabold text-grape-700 underline">Заблокировать комнату на 4 часа</Link> : null}
        <span className="text-muted">История дня (снятые брони): {released.length}</span>
      </div>
      {released.length > 0 ? (
        <ul className="grid gap-1 text-xs text-muted" aria-label="Снятые брони">
          {released.map((r) => <li key={r.id}>{rooms.find((x) => x.id === r.roomId)?.name ?? "—"} · {clock(r.startsAt)}–{clock(r.endsAt)} · {r.kind === "block" ? "блокировка" : r.customerName ?? "клиент скрыт"} · снята {r.releasedAt ? clock(r.releasedAt) : ""}</li>)}
        </ul>
      ) : null}

      {selected ? (
        <ReservationDetails
          r={selected}
          roomName={rooms.find((x) => x.id === selected.roomId)?.name ?? "—"}
          rooms={rooms}
          quick={quick}
          hoursKnown={Boolean(hours)}
          branchId={branch.id}
          date={date}
          closeHref={dayHref}
          rescheduling={search.move === "1"}
          rescheduleHref={q({ reservation: selected.id, move: "1" })}
          detailHref={q({ reservation: selected.id })}
        />
      ) : search.new === "1" && hours ? (
        <NewBookingForm rooms={rooms} packages={packages} quick={quick} branchId={branch.id} date={date} closeHref={dayHref} defaultRoomId={search.room} defaultStart={search.start ?? defaultStart} mode="booking" />
      ) : search.block === "1" && hours ? (
        <NewBookingForm rooms={rooms} packages={packages} quick={quick} branchId={branch.id} date={date} closeHref={dayHref} defaultRoomId={search.room} defaultStart={search.start ?? defaultStart} mode="block" />
      ) : null}
    </div>
  );
}
