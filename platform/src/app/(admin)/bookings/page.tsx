import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getGrid, type Cell } from "@/core/bookings";
import { listPackages } from "@/core/catalog";
import { almatyToday, isValidDate } from "@/core/dates";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { DatePicker } from "@/components/date-picker";
import { FastApiCrmClient, unifiedFastapiCrmEnabled, type BookingTimeline, type BirthdayBookingCatalog } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import type { SessionUser } from "@/core/session";
import { blockAction, manualBookingAction, releaseAction, rescheduleAction } from "./actions";

export const metadata: Metadata = { title: "Календарь" };

const NOTICES: Record<string, string> = { booked: "Бронь создана.", blocked: "Время заблокировано.", released: "Бронь отменена или блокировка снята. Возврат денег не выполнялся.", rescheduled: "Бронь перенесена." };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят (кто-то успел раньше). Данные обновлены.",
  invalid: "Проверьте введённые данные (дата, пакет, имя, телефон; прошедший слот занять нельзя).",
  conflict: "Действие уже выполнено или недоступно.",
  forbidden: "Недостаточно прав.",
  fastapi_unavailable: "FastAPI CRM временно недоступна. Повторите действие через несколько секунд.",
};
const kzt = new Intl.NumberFormat("ru-RU");
const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ date?: string; notice?: string; error?: string; requestKey?: string; retryAction?: string; retryTarget?: string; blockKey?: string; releaseKey?: string; rescheduleKey?: string }> }) {
  const { user } = await requirePermission("bookings.manage");
  const sp = await searchParams;
  const date = sp.date && isValidDate(sp.date) ? sp.date : almatyToday();
  if (unifiedFastapiCrmEnabled()) return UnifiedBookingsPage({ user, date, notice: sp.notice, error: sp.error, requestKey: sp.requestKey, retryAction: sp.retryAction, retryTarget: sp.retryTarget, blockKey: sp.blockKey, releaseKey: sp.releaseKey, rescheduleKey: sp.rescheduleKey });
  const actor = { id: user.id, role: user.role };
  const [grid, packages] = await Promise.all([getGrid(getPool(), actor, date), listPackages(getPool())]);
  const activePackages = packages.filter((p) => p.isActive);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const slotCounts = {
    free: grid.cells.filter((cell) => cell.state === "free").length,
    booked: grid.cells.filter((cell) => cell.state === "booked").length,
    blocked: grid.cells.filter((cell) => cell.state === "blocked").length,
  };

  const cellOf = (roomId: string, slotId: number) => grid.cells.find((c) => c.roomId === roomId && c.slotId === slotId) as Cell;

  return (
    <div className="crm-page crm-bookings-page">
      <div>
        <p className="crm-eyebrow">Расписание филиала</p>
        <h1 className="crm-page-title">Календарь</h1>
      </div>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav aria-label="Дата" className="crm-date-controls flex flex-wrap items-center gap-2">
        <Link href={`/bookings?date=${shift(date, -1)}`} className={btnGhost + " flex items-center"} aria-label="Предыдущий день">←</Link>
        <form method="get" className="flex items-center gap-2">
          <DatePicker key={date} name="date" label="Дата" defaultValue={date} className="crm-date-picker-compact" allowClear={false} />
          <button type="submit" className={btn}>Показать</button>
        </form>
        <Link href={`/bookings?date=${shift(date, 1)}`} className={btnGhost + " flex items-center"} aria-label="Следующий день">→</Link>
        <Link href="/bookings" className="text-sm font-extrabold text-grape-700 underline">Сегодня</Link>
      </nav>
      <p className="crm-page-subtitle first-letter:uppercase">{weekday}</p>
      <div className="crm-calendar-legend" aria-label="Состояния слотов">
        <span><i data-state="free" aria-hidden="true" />Свободно · {slotCounts.free}</span>
        <span><i data-state="booked" aria-hidden="true" />Бронь · {slotCounts.booked}</span>
        <span><i data-state="blocked" aria-hidden="true" />Блокировка · {slotCounts.blocked}</span>
      </div>
      {grid.unplacedLeads ? (
        <p className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          Заявок на эту дату без выбранной комнаты или слота: {grid.unplacedLeads}. <Link href="/requests?status=new" className="underline">Открыть заявки</Link>
        </p>
      ) : null}

      <div className="crm-calendar-header hidden grid-cols-[8rem_repeat(3,1fr)] gap-3 text-sm font-black text-grape-800 md:grid" aria-hidden="true">
        <span />
        {grid.slots.map((s) => <span key={s.id}>{s.startsAt}–{s.endsAt}</span>)}
      </div>

      <section aria-label="Комнаты и слоты" className="grid gap-4">
        {grid.rooms.map((room) => (
          <article key={room.id} className="crm-room-card grid gap-3 rounded-3xl border border-line bg-white p-4 md:grid-cols-[8rem_repeat(3,1fr)] md:items-start">
            <h2 className="text-lg font-black text-grape-800 md:pt-2">{room.name}</h2>
            {grid.slots.map((slot) => {
              const cell = cellOf(room.id, slot.id);
              const tone = cell.state === "free" ? "border-grape-200 bg-paper" : cell.state === "booked" ? "border-grape-600 bg-grape-100" : "border-muted bg-sun-100";
              return (
                <div key={slot.id} data-cell={`${room.id}:${slot.id}`} data-state={cell.state} className={`min-w-0 rounded-2xl border-2 p-3 ${tone}`}>
                  <p className="text-xs font-extrabold text-muted md:hidden">{slot.startsAt}–{slot.endsAt}</p>
                  {cell.state === "free" ? (
                    <>
                      <p className="text-sm font-black text-grape-800">Свободно</p>
                      {cell.pendingLeads ? <p className="mt-1 rounded-lg bg-white/80 px-2 py-1 text-xs font-bold text-grape-700">Заявок: {cell.pendingLeads} · слот ещё свободен</p> : null}
                      <details className="mt-2">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">Ручная бронь</summary>
                        <form action={manualBookingAction} className="mt-2 grid gap-2">
                          <input type="hidden" name="date" value={date} /><input type="hidden" name="slotId" value={slot.id} /><input type="hidden" name="roomId" value={room.id} />
                          <input name="name" placeholder="Имя" required maxLength={120} className={input} aria-label="Имя" />
                          <input name="phone" type="tel" placeholder="+7 707 123 45 67" required className={input} aria-label="Телефон" />
                          <select name="packageId" required className={input} aria-label="Пакет">
                            {activePackages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <input name="children" type="number" min={0} max={200} placeholder="Детей" className={input} aria-label="Детей" />
                          <input name="note" placeholder="Заметка" maxLength={300} className={input} aria-label="Заметка" />
                          <button type="submit" className={btn}>Забронировать</button>
                        </form>
                      </details>
                      <details className="mt-2">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">Заблокировать</summary>
                        <form action={blockAction} className="mt-2 grid gap-2">
                          <input type="hidden" name="date" value={date} /><input type="hidden" name="slotId" value={slot.id} /><input type="hidden" name="roomId" value={room.id} />
                          <input name="note" placeholder="Причина" maxLength={300} className={input} aria-label="Причина блокировки" />
                          <button type="submit" className={btnGhost}>Заблокировать</button>
                        </form>
                      </details>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-black text-grape-800">{cell.state === "booked" ? "Забронировано" : "Заблокировано"}</p>
                      {cell.state === "booked" ? (
                        <p className="mt-1 break-words text-sm text-grape-900">{cell.customer} · {cell.phone}<br />{cell.packageName} · {cell.priceKzt != null ? `${kzt.format(cell.priceKzt)} ₸` : ""}</p>
                      ) : null}
                      {cell.note ? <p className="mt-1 break-words text-xs text-muted">{cell.note}</p> : null}
                      <form action={releaseAction} className="mt-2 grid gap-2">
                        <input type="hidden" name="date" value={date} /><input type="hidden" name="id" value={cell.reservationId} />
                        <input name="reason" placeholder="Причина" maxLength={300} className={input} aria-label="Причина" />
                        <button type="submit" className={btnGhost}>{cell.state === "booked" ? "Отменить бронь" : "Снять блокировку"}</button>
                      </form>
                    </>
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </section>
    </div>
  );
}

async function UnifiedBookingsPage({ user, date, notice, error, requestKey, retryAction, retryTarget, blockKey, releaseKey, rescheduleKey }: {
  user: SessionUser;
  date: string;
  notice?: string;
  error?: string;
  requestKey?: string;
  retryAction?: string;
  retryTarget?: string;
  blockKey?: string;
  releaseKey?: string;
  rescheduleKey?: string;
}) {
  let catalog: BirthdayBookingCatalog | null = null;
  let timeline: BookingTimeline | null = null;
  let loadError = false;
  try {
    const requestId = randomUUID();
    const actor = await fastApiActorForStaff({ id: user.id, email: user.email }, { requestId });
    const client = new FastApiCrmClient(actor);
    catalog = await client.getBookingCatalog();
    if (catalog.branches.length === 1) timeline = await client.getBookingTimeline(catalog.branches[0].id, date);
  } catch {
    loadError = true;
  }

  const branch = catalog?.branches.length === 1 ? catalog.branches[0] : null;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const stableRequestKey = requestKey && uuidPattern.test(requestKey) ? requestKey : randomUUID();
  if (!loadError && branch && stableRequestKey !== requestKey) {
    const params = new URLSearchParams({ date, requestKey: stableRequestKey });
    if (notice) params.set("notice", notice);
    if (error) params.set("error", error);
    if (retryAction) params.set("retryAction", retryAction);
    if (retryTarget) params.set("retryTarget", retryTarget);
    if (blockKey) params.set("blockKey", blockKey);
    if (releaseKey) params.set("releaseKey", releaseKey);
    if (rescheduleKey) params.set("rescheduleKey", rescheduleKey);
    redirect(`/bookings?${params.toString()}`);
  }

  const activeReservations = timeline?.reservations.filter((item) => item.status !== "released") ?? [];
  const bookings = activeReservations.filter((item) => item.kind === "booking").length;
  const blocks = activeReservations.filter((item) => item.kind === "block").length;
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const time = (value: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Almaty" }).format(new Date(value));
  const keyForForm = (action: string, target: string, key?: string) =>
    action === retryAction && target === retryTarget && key && uuidPattern.test(key) ? key : randomUUID();

  return (
    <div className="crm-page crm-bookings-page crm-fastapi-calendar">
      <header className="crm-calendar-heading">
        <div><p className="crm-eyebrow">Расписание одного филиала</p><h1 className="crm-page-title">Календарь</h1><p className="crm-page-subtitle">{weekday}</p></div>
        <div className="crm-calendar-branch"><span aria-hidden="true" />{branch?.name ?? "Филиал не выбран"}</div>
      </header>
      {notice && NOTICES[notice] ? <p className="crm-detail-message" role="status">{NOTICES[notice]}</p> : null}
      {error ? <p className="crm-detail-message crm-detail-message-error" role="alert">{ERRORS[error] ?? "Не удалось выполнить действие."}</p> : null}
      {loadError ? <p className="crm-detail-message crm-detail-message-error" role="alert">FastAPI CRM недоступна. Календарь из старой базы не подменяет данные FastAPI.</p> : null}
      {!loadError && !branch ? <p className="crm-detail-message crm-detail-message-error" role="alert">В учётной записи доступно не ровно одно отделение. Автоматический выбор отключён до проверки филиальной привязки.</p> : null}

      <nav aria-label="Дата календаря" className="crm-date-controls crm-fastapi-date-controls">
        <Link href={`/bookings?date=${shift(date, -1)}`} className={btnGhost} aria-label="Предыдущий день">←</Link>
        <form method="get" className="crm-calendar-date-form"><DatePicker key={date} name="date" label="Дата календаря" defaultValue={date} className="crm-date-picker-compact" allowClear={false} /><button type="submit" className={btn}>Показать</button></form>
        <Link href={`/bookings?date=${shift(date, 1)}`} className={btnGhost} aria-label="Следующий день">→</Link>
        <Link href="/bookings" className="crm-calendar-today">Сегодня</Link>
      </nav>

      {branch && catalog && timeline ? (
        <>
          <div className="crm-fastapi-calendar-summary" aria-label="Сводка календаря">
            <span><strong>{bookings}</strong> активных броней</span>
            <span><strong>{blocks}</strong> блокировок</span>
            <span><strong>{timeline.bufferMinutes} мин</strong> подготовка после праздника</span>
          </div>

          <details className="crm-detail-panel crm-fastapi-staff-request">
            <summary>Создать заявку от имени сотрудника</summary>
            <p className="crm-detail-help">Сначала создаётся заявка. После подтверждения фактической предоплаты бронь оформляется в карточке заявки. Эта форма не отмечает согласие клиента.</p>
            <form action={manualBookingAction} className="crm-detail-form crm-detail-booking-form">
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="branchId" value={branch.id} />
              <input type="hidden" name="idempotencyKey" value={stableRequestKey} />
              <label className="crm-detail-field"><span>Клиент</span><input name="name" required maxLength={120} /></label>
              <label className="crm-detail-field"><span>Телефон</span><input name="phone" type="tel" required maxLength={20} placeholder="+7 707 123 45 67" /></label>
              <label className="crm-detail-field"><span>Пакет</span><select name="packageId" required defaultValue=""><option value="" disabled>Выбрать пакет</option>{catalog.packages.filter((item) => item.branchId === branch.id).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.priceLabel}</option>)}</select></label>
              <label className="crm-detail-field"><span>Предпочтительная дата</span><DatePicker name="requestedDate" label="Предпочтительная дата" defaultValue={date} required allowClear={false} /></label>
              <label className="crm-detail-field"><span>Количество гостей</span><input name="children" type="number" min="0" max="500" step="1" /></label>
              <label className="crm-detail-field"><span>Заметка</span><input name="note" maxLength={300} /></label>
              <button type="submit" className="crm-detail-button">Создать заявку</button>
            </form>
          </details>

          <section className="crm-fastapi-rooms" aria-label="Расписание комнат">
            {timeline.rooms.map((room) => {
              const reservations = timeline!.reservations.filter((item) => item.roomId === room.id).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
              return (
                <article key={room.id} className="crm-detail-panel crm-fastapi-room">
                  <header className="crm-fastapi-room-heading"><div><p className="crm-eyebrow">Комната</p><h2>{room.name}</h2></div><span>{reservations.filter((item) => item.status !== "released").length} активных записей</span></header>
                  {reservations.length ? (
                    <div className="crm-fastapi-reservations">
                      {reservations.map((reservation) => {
                        const released = reservation.status === "released";
                        const statusText = released ? "Освобождена" : reservation.kind === "block" ? "Заблокировано" : "Бронь подтверждена";
                        return (
                          <section key={reservation.id} className="crm-fastapi-reservation" data-state={released ? "released" : reservation.kind}>
                            <div className="crm-fastapi-reservation-heading"><div><span className="crm-fastapi-time">{time(reservation.startsAt)}–{time(reservation.endsAt)}</span><span className="crm-fastapi-status">{statusText}</span></div><span className="crm-fastapi-buffer">{released ? "Не занимает время" : `Занято до ${time(reservation.occupiedEndsAt)}`}</span></div>
                            {reservation.kind === "booking" ? (
                              <div className="crm-fastapi-reservation-details">
                                <strong>{reservation.customerName ?? "Данные клиента скрыты для этой роли"}</strong>
                                {reservation.customerPhone ? <a href={`tel:${reservation.customerPhone}`}>{reservation.customerPhone}</a> : null}
                                <span>{reservation.packageName ?? "Пакет не указан"}{reservation.priceKzt == null ? "" : ` · ${kzt.format(reservation.priceKzt)} ₸`}</span>
                                <span>{reservation.paymentStatus === "prepaid" ? `Ручная предоплата ${kzt.format(reservation.paidKzt)} ₸` : "Ручная предоплата не отмечена"}</span>
                                {reservation.requestId ? <Link href={`/requests/${encodeURIComponent(reservation.requestId)}`}>Открыть заявку</Link> : null}
                              </div>
                            ) : <p className="crm-detail-help">{reservation.note || "Причина блокировки не указана."}</p>}
                            {!released ? (
                              <details className="crm-fastapi-reservation-actions">
                                <summary>Перенести или отменить</summary>
                                <div className="crm-fastapi-row-actions">
                                  <form action={rescheduleAction} className="crm-detail-form crm-fastapi-reschedule-form">
                                    <input type="hidden" name="date" value={date} /><input type="hidden" name="branchId" value={branch.id} /><input type="hidden" name="id" value={reservation.id} /><input type="hidden" name="idempotencyKey" value={keyForForm("reschedule", reservation.id, rescheduleKey)} />
                                    <label className="crm-detail-field"><span>Новая дата</span><DatePicker name="bookingDate" label="Новая дата" defaultValue={date} required allowClear={false} /></label>
                                    <label className="crm-detail-field"><span>Начало</span><input name="startTime" type="time" step="900" defaultValue={time(reservation.startsAt)} required /></label>
                                    <label className="crm-detail-field"><span>Комната</span><select name="roomId" required defaultValue={reservation.roomId}>{timeline.rooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                                    <button type="submit" className="crm-detail-button crm-detail-button-secondary">Перенести</button>
                                  </form>
                                  <form action={releaseAction} className="crm-detail-form crm-fastapi-release-form">
                                    <input type="hidden" name="date" value={date} /><input type="hidden" name="branchId" value={branch.id} /><input type="hidden" name="id" value={reservation.id} /><input type="hidden" name="idempotencyKey" value={keyForForm("release", reservation.id, releaseKey)} />
                                    <label className="crm-detail-field"><span>{reservation.kind === "booking" ? "Причина отмены" : "Причина снятия блокировки"}</span><input name="reason" maxLength={300} required /></label>
                                    <p className="crm-detail-help">Деньги не возвращаются автоматически.</p>
                                    <button type="submit" className="crm-detail-button crm-detail-button-secondary">{reservation.kind === "booking" ? "Отменить бронь" : "Снять блокировку"}</button>
                                  </form>
                                </div>
                              </details>
                            ) : null}
                          </section>
                        );
                      })}
                    </div>
                  ) : <p className="crm-detail-help">На эту дату записей нет.</p>}

                  <details className="crm-fastapi-block-form">
                    <summary>Заблокировать время</summary>
                    <form action={blockAction} className="crm-detail-form">
                      <input type="hidden" name="date" value={date} /><input type="hidden" name="branchId" value={branch.id} /><input type="hidden" name="roomId" value={room.id} /><input type="hidden" name="idempotencyKey" value={keyForForm("block", room.id, blockKey)} />
                      <label className="crm-detail-field"><span>Время начала</span><input name="startTime" type="time" step="900" required /></label>
                      <label className="crm-detail-field"><span>Причина</span><input name="reason" maxLength={300} required /></label>
                      <button type="submit" className="crm-detail-button crm-detail-button-secondary">Заблокировать</button>
                    </form>
                  </details>
                </article>
              );
            })}
          </section>
          <p className="crm-detail-help">Отмена освобождает время с аудитом. Она не оформляет возврат денег; CRM не выполняет возвраты автоматически.</p>
        </>
      ) : null}
    </div>
  );
}
