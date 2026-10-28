import { randomUUID } from "node:crypto";
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
  QUICK_STARTS,
  START_STEP_MINUTES,
  startOptions,
  type WorkingWindow,
} from "../../../core/booking-calendar.ts";
import { COLUMN_SPAN, COLUMN_START, LANE_START } from "../../../core/booking-grid-classes.ts";
import type { ValidSession } from "../../../core/session.ts";
import { crmActorForSession } from "../../../server/crm-actor.ts";
import { FastApiCrmClient, FastApiCrmError, type BookingTimeline, type BookingTimelineReservation, type FastApiBirthdayPackage, type FastApiBranch } from "../../../server/fastapi-crm.ts";
import { blockAction, createBookingAction, rescheduleAction, releaseAction } from "./crm-actions";

const NOTICES: Record<string, string> = {
  booked: "Бронь создана и подтверждена. Заявка и предоплата записаны.",
  blocked: "Время заблокировано.",
  released: "Бронь отменена, комната свободна.",
  rescheduled: "Бронь перенесена.",
};

const ERRORS: Record<string, string> = {
  time_conflict: "Комната занята в это время: пересекается бронь или блокировка. Выберите другое время или комнату. Если вы создавали бронь, проверьте раздел «Заявки»: заявка и предоплата могли сохраниться.",
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

type Search = { branch?: string; date?: string; start?: string; notice?: string; error?: string; request?: string; paid?: string };

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
  let branches: FastApiBranch[];
  let timeline: BookingTimeline;
  let packages: FastApiBirthdayPackage[];
  let loadFailed = false;
  try {
    const client = new FastApiCrmClient(await crmActorForSession(session, randomUUID()));
    branches = (await client.listBranches()).filter((b) => b.is_active).sort((a, b) => a.display_order - b.display_order);
    const selected = branches.find((b) => b.id === search.branch) ?? branches[0];
    [timeline, packages] = await Promise.all([
      selected ? client.getBookingTimeline(selected.id, date) : Promise.resolve(null as unknown as BookingTimeline),
      client.listBirthdayPackages(),
    ]);
  } catch (error) {
    // Fail closed: no grid, no guessed availability. The page says the data is unavailable. Only the code is logged.
    console.error("[crm-calendar] load failed:", error instanceof FastApiCrmError ? `${error.status} ${error.code}` : "unexpected");
    loadFailed = true;
    branches = [];
    timeline = null as unknown as BookingTimeline;
    packages = [];
  }

  if (loadFailed) {
    return (
      <div className="grid gap-5">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
        <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Не удалось загрузить календарь из системы бронирования. Данные не показаны, чтобы не вводить в заблуждение. Обновите страницу позже.</p>
      </div>
    );
  }
  if (branches.length === 0) {
    return <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900">Для вашей учётной записи нет доступных филиалов.</p>;
  }

  const branch = branches.find((b) => b.id === search.branch) ?? branches[0];
  const hours = parseWorkingHours(branch.working_hours);
  const starts = hours ? startOptions(hours) : [];
  const branchPackages = packages.filter((p) => p.branch_id === branch.id && p.is_active);
  const active = timeline.reservations.filter((r) => r.status !== "released");
  const flagged = overlappingIds(active.map((r) => ({ id: r.id, roomId: r.roomId, startsAt: r.startsAt, endsAt: r.endsAt })));
  const hourMarks: number[] = [];
  for (let m = GRID_OPEN_MIN; m < 24 * 60; m += 60) hourMarks.push(m);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const notice = search.notice && NOTICES[search.notice];
  const errorText = search.error && ERRORS[search.error];
  const newStart = search.start && starts.includes(search.start) ? search.start : starts[0] ?? "";
  const idempotencyKey = () => randomUUID();
  const branchQuery = { branch: branch.id, date };

  return (
    <div className="grid min-w-0 gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
      {notice ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{notice}</p> : null}
      {errorText ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{errorText}</p> : null}
      {search.request ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          Бронь НЕ подтверждена. Заявка {search.request} {search.paid === "1" ? "создана, предоплата записана" : "создана"}. Не создавайте новую заявку: откройте её в разделе «Заявки» и разберите вручную.
        </p>
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
      <p className="text-base font-bold text-grape-900 first-letter:uppercase">{weekday} · {branch.name} · часы {hours ? branch.working_hours : "не распознаны"}</p>
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
            {timeline.rooms.map((room) => {
              const items = active
                .filter((r) => r.roomId === room.id)
                .map((r) => ({ reservation: r, column: gridColumn(r.startsAt, r.endsAt) }))
                .filter((x): x is { reservation: BookingTimelineReservation; column: { start: number; span: number } } => x.column !== null);
              const lanes = assignLanes(items.map((x) => ({ id: x.reservation.id, start: x.column.start, span: x.column.span })));
              return (
                <div key={room.id} className="mt-2 grid grid-cols-[8rem_1fr] gap-2">
                  <h2 className="self-center text-sm font-black text-grape-800">{room.name}</h2>
                  <div className="relative grid auto-rows-[2.75rem] grid-cols-[repeat(60,minmax(0,1fr))] gap-y-1 rounded-xl border border-grape-100 bg-paper py-1" role="list" aria-label={`Занятость: ${room.name}`}>
                    {closedColumns(hours).map((range) => (
                      <div key={`${range.start}-${range.span}`} aria-hidden="true" className={`${COLUMN_START[range.start]} ${COLUMN_SPAN[range.span]} row-start-1 row-span-1 self-stretch bg-line/30`} />
                    ))}
                    {items.map(({ reservation: r, column }) => {
                      const conflict = flagged.has(r.id);
                      const tone = conflict ? "border-red-700 bg-red-100" : r.kind === "block" ? "border-muted bg-sun-100" : "border-grape-600 bg-grape-100";
                      return (
                        <div
                          key={r.id}
                          role="listitem"
                          data-reservation={r.id}
                          data-state={conflict ? "conflict" : r.kind === "block" ? "blocked" : "booked"}
                          className={`${COLUMN_START[column.start]} ${COLUMN_SPAN[column.span]} ${LANE_START[lanes.get(r.id) ?? 1]} z-10 mx-px min-w-0 overflow-hidden rounded-lg border-2 px-2 py-1 text-xs ${tone}`}
                        >
                          <p className="truncate font-black text-grape-900">{clock(r.startsAt)}–{clock(r.endsAt)} · {r.kind === "block" ? "Блок" : STATUS_LABEL[r.status]}{conflict ? " · конфликт" : ""}</p>
                          <p className="truncate text-grape-900">{r.kind === "block" ? r.note ?? "" : r.customerName ?? "Клиент скрыт"}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-xs font-bold text-muted">Серый фон — свободно. Бежевый — блокировка. Сиреневый — бронь. Красный — пересечение, которого быть не должно: сообщите администратору.</p>
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
        <section aria-labelledby="new-booking" className="grid gap-3 rounded-3xl border border-line bg-white p-4">
          <h2 id="new-booking" className="text-lg font-black text-grape-800">Новая бронь на 4 часа</h2>
          {hours && branchPackages.length > 0 && timeline.rooms.length > 0 ? (
            <form action={createBookingAction} className="grid gap-2">
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey()} />
              <label className="grid gap-1 text-xs font-extrabold text-muted">Комната
                <select name="roomId" required className={input}>{timeline.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </label>
              <label className="grid gap-1 text-xs font-extrabold text-muted">Начало
                <select name="startTime" required defaultValue={newStart} className={input}>{starts.map((s) => <option key={s} value={s}>{s}–{formatMinutes(Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) + 240)}</option>)}</select>
              </label>
              <label className="grid gap-1 text-xs font-extrabold text-muted">Пакет
                <select name="packageId" required className={input}>{branchPackages.map((p) => <option key={p.id} value={p.id}>{p.name} (от {kzt.format(p.price_from)} ₸)</option>)}</select>
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
              <p className="text-xs text-muted">Бронь подтверждается только после записи предоплаты. Повторное нажатие не создаст вторую бронь.</p>
              <button type="submit" className={btn}>Создать и подтвердить</button>
            </form>
          ) : (
            <p className="text-sm font-bold text-muted">{!hours ? "Бронирование отключено: часы филиала не распознаны." : "Нет активных пакетов или комнат для этого филиала."}</p>
          )}
        </section>

        <section aria-labelledby="block" className="grid gap-3 rounded-3xl border border-line bg-white p-4">
          <h2 id="block" className="text-lg font-black text-grape-800">Ручная блокировка</h2>
          {hours && timeline.rooms.length > 0 ? (
            <form action={blockAction} className="grid gap-2">
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey()} />
              <select name="roomId" required className={input} aria-label="Комната блокировки">{timeline.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              <select name="startTime" required defaultValue={newStart} className={input} aria-label="Начало блокировки">{starts.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <input name="reason" required maxLength={300} placeholder="Причина" aria-label="Причина блокировки" className={input} />
              <button type="submit" className={btnGhost}>Заблокировать на 4 часа</button>
            </form>
          ) : <p className="text-sm font-bold text-muted">Блокировка недоступна: нет часов работы или комнат.</p>}
        </section>
      </div>

      <section aria-labelledby="day-list" className="grid gap-3">
        <h2 id="day-list" className="text-lg font-black text-grape-800">Бронирования и блоки на день ({active.length})</h2>
        {active.length === 0 ? <p className="text-sm font-bold text-muted">На эту дату ничего не забронировано.</p> : null}
        {active.map((r) => (
          <ReservationRow key={r.id} r={r} rooms={timeline.rooms} starts={starts} branchId={branch.id} date={date} conflict={flagged.has(r.id)} />
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
  const paid = r.paidKzt > 0 ? `${kzt.format(r.paidKzt)} ₸` : "предоплата не записана";
  return (
    <article className={`grid gap-2 rounded-2xl border-2 p-4 ${conflict ? "border-red-700 bg-red-50" : "border-line bg-white"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-base font-black text-grape-800">{roomName} · {clock(r.startsAt)}–{clock(r.endsAt)} · {r.kind === "block" ? "Блокировка" : STATUS_LABEL[r.status]}</p>
        {conflict ? <p className="text-sm font-black text-red-800">Пересечение: сообщите администратору</p> : null}
      </div>
      <p className="break-words text-sm text-grape-900">
        {r.kind === "block" ? r.note ?? "Без причины" : `${r.customerName ?? "Клиент скрыт"}${r.customerPhone ? ` · ${r.customerPhone}` : ""} · ${r.packageName ?? "пакет не указан"}${r.priceKzt != null ? ` · ${kzt.format(r.priceKzt)} ₸` : ""} · ${paid}`}
      </p>
      {r.kind === "booking" && r.createdByAdminId ? <p className="text-xs text-muted">Ответственный (ID в CRM): {r.createdByAdminId}</p> : null}
      <div className="flex flex-wrap gap-2">
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
      </div>
    </article>
  );
}
