import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { birthdayStartTimes } from "@/core/birthday-booking-time";
import { almatyToday, isValidDate } from "@/core/dates";
import { requirePermission } from "@/server/dal";
import { FastApiCrmClient, FastApiCrmError, unifiedFastapiCrmEnabled, type BookingTimeline, type FastApiBirthdayBookingCatalog } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import { DatePicker } from "@/components/date-picker";
import { blockAction, releaseAction } from "./actions";

export const metadata: Metadata = { title: "Календарь" };

const kzt = new Intl.NumberFormat("ru-RU");
const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function formatTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function apiError(error: unknown): string {
  if (error instanceof FastApiCrmError && error.status === 403) return "forbidden";
  return "fastapi_unavailable";
}

function UnifiedCalendar({
  branch,
  timeline,
  date,
  error,
  notice,
}: {
  branch: FastApiBirthdayBookingCatalog["branches"][number];
  timeline: BookingTimeline;
  date: string;
  error?: string;
  notice?: string;
}) {
  const times = birthdayStartTimes(branch.workingHours);
  const activeReservations = timeline.reservations.filter((item) => item.status !== "released");
  const counts = {
    bookings: activeReservations.filter((item) => item.kind === "booking").length,
    blocks: activeReservations.filter((item) => item.kind === "block").length,
  };
  const roomCount = timeline.rooms.length;
  const validConfiguration = timeline.branchId === branch.id && roomCount === 4 && times.length > 0 && timeline.bufferMinutes === 0;
  const allowBlocks = validConfiguration;
  const errorText: Record<string, string> = {
    booked: "Комната забронирована.",
    blocked: "Интервал заблокирован.",
    released: "Бронь или блокировка отменена.",
    slot_taken: "Интервал уже занят. Календарь обновлён.",
    conflict: "Действие уже выполнено или недоступно.",
    invalid: "Проверьте дату, время и причину.",
    forbidden: "Недостаточно прав.",
    fastapi_unavailable: "CRM API недоступен. Изменения не сохранены.",
    buffer_required: "Для бронирований должен быть настроен буфер 0 минут.",
  };

  return (
    <div className="crm-page crm-bookings-page">
      <div>
        <p className="crm-eyebrow">{branch.name} · {branch.city}</p>
        <h1 className="crm-page-title">Календарь</h1>
        <p className="crm-page-subtitle">Праздник длится ровно 4 часа; следующая бронь может начаться сразу после окончания.</p>
      </div>
      {notice && errorText[notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{errorText[notice]}</p> : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{errorText[error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav aria-label="Дата" className="crm-date-controls flex flex-wrap items-center gap-2">
        <Link href={`/bookings?date=${shift(date, -1)}`} className={btnGhost + " flex items-center"} aria-label="Предыдущий день">←</Link>
        <form method="get" className="flex items-center gap-2">
          <DatePicker key={date} name="date" label="Дата" defaultValue={date} className="crm-date-picker-compact" allowClear={false} />
          <button type="submit" className={btn}>Показать</button>
        </form>
        <Link href={`/bookings?date=${shift(date, 1)}`} className={btnGhost + " flex items-center"} aria-label="Следующий день">→</Link>
        <Link href="/bookings" className="text-sm font-extrabold text-grape-700 underline">Сегодня</Link>
      </nav>
      <p className="crm-page-subtitle">Активные брони: {counts.bookings} · блокировки: {counts.blocks}</p>
      {!validConfiguration ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Конфигурация календаря должна содержать четыре комнаты, корректный рабочий график и буфер 0 минут. Изменения заблокированы.</p>
      ) : null}
      <p className="text-sm text-muted">Новая бронь создаётся из заявки после фиксации фактически полученной предоплаты. <Link href="/requests" className="font-bold text-grape-700 underline">Открыть заявки</Link></p>

      <section aria-label="Комнаты и брони" className="grid gap-4">
        {timeline.rooms.map((room) => {
          const reservations = activeReservations.filter((item) => item.roomId === room.id).sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
          return (
            <article key={room.id} className="crm-room-card grid gap-3 rounded-3xl border border-line bg-white p-4">
              <h2 className="text-lg font-black text-grape-800">{room.name}</h2>
              {reservations.length === 0 ? <p className="text-sm text-muted">На эту дату нет броней и блокировок.</p> : null}
              {reservations.map((reservation) => (
                <div key={reservation.id} data-reservation={reservation.id} className="rounded-2xl border-2 border-grape-200 bg-paper p-3">
                  <p className="text-sm font-black text-grape-800">
                    {reservation.kind === "booking" ? "Бронь" : "Блокировка"} · {reservation.startsAt ? formatTime(reservation.startsAt, timeline.timezone) : "—"}–{reservation.endsAt ? formatTime(reservation.endsAt, timeline.timezone) : "—"}
                  </p>
                  {reservation.occupiedEndsAt !== reservation.endsAt ? <p className="text-xs text-muted">Комната занята до {formatTime(reservation.occupiedEndsAt, timeline.timezone)}.</p> : null}
                  {reservation.kind === "booking" ? (
                    <p className="mt-1 break-words text-sm text-grape-900">
                      {reservation.customerName ?? "Клиент"}{reservation.customerPhone ? ` · ${reservation.customerPhone}` : ""}
                      {reservation.packageName ? <><br />{reservation.packageName}</> : null}
                      {reservation.priceKzt != null ? ` · ${kzt.format(reservation.priceKzt)} ₸` : ""}
                      <br />Оплата: {reservation.paymentStatus === "prepaid" ? `предоплата зафиксирована (${kzt.format(reservation.paidKzt)} ₸)` : reservation.paymentStatus === "unreconciled" ? "требует сверки" : "не зафиксирована"}
                    </p>
                  ) : null}
                  {reservation.note ? <p className="mt-1 break-words text-xs text-muted">{reservation.note}</p> : null}
                  {reservation.requestId ? <Link href={`/requests/${encodeURIComponent(reservation.requestId)}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-grape-700 underline">Открыть заявку</Link> : null}
                  <form action={releaseAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <input type="hidden" name="date" value={date} />
                    <input type="hidden" name="id" value={reservation.id} />
                    <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                    <input name="reason" placeholder="Причина отмены" required maxLength={300} className={input} aria-label="Причина отмены" />
                    <button type="submit" className={btnGhost}>{reservation.kind === "booking" ? "Отменить бронь" : "Снять блокировку"}</button>
                  </form>
                </div>
              ))}
              {allowBlocks ? (
                <details className="mt-1">
                  <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">Заблокировать время</summary>
                  <form action={blockAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <input type="hidden" name="date" value={date} />
                    <input type="hidden" name="branchId" value={branch.id} />
                    <input type="hidden" name="roomId" value={room.id} />
                    <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                    <select name="startTime" required className={input} aria-label={`Время блокировки, ${room.name}`}>
                      {times.map((time) => <option key={time} value={time}>{time}</option>)}
                    </select>
                    <input name="reason" placeholder="Причина блокировки" required maxLength={300} className={input} aria-label="Причина блокировки" />
                    <button type="submit" className={btnGhost}>Заблокировать 4 часа</button>
                  </form>
                </details>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ date?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("bookings.manage");
  const sp = await searchParams;
  const date = sp.date && isValidDate(sp.date) ? sp.date : almatyToday();
  if (!unifiedFastapiCrmEnabled()) {
    return <main className="crm-page"><h1 className="crm-page-title">Календарь недоступен</h1><p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">Основной CRM API не настроен. Создание и изменение бронирований заблокировано.</p></main>;
  }
  let calendar: { branch: FastApiBirthdayBookingCatalog["branches"][number]; timeline: BookingTimeline } | null = null;
  let loadError: string | null = null;
  try {
    const requestId = randomUUID();
    const actor = await fastApiActorForStaff(user, { requestId });
    const client = new FastApiCrmClient(actor);
    const catalog = await client.getBookingCatalog();
    if (catalog.branches.length !== 1) {
      loadError = "branch_count";
    } else {
      const branch = catalog.branches[0];
      const catalogRoomIds = catalog.rooms.filter((room) => room.branchId === branch.id).map((room) => room.id).sort();
      if (catalogRoomIds.length !== 4) {
        loadError = "room_count";
      } else {
        const timeline = await client.getBookingTimeline(branch.id, date);
        const timelineRoomIds = timeline.rooms.map((room) => room.id).sort();
        if (timeline.branchId !== branch.id || timeline.date !== date || timelineRoomIds.length !== catalogRoomIds.length || catalogRoomIds.some((id, index) => id !== timelineRoomIds[index])) {
          loadError = "timeline_mismatch";
        } else {
          calendar = { branch, timeline };
        }
      }
    }
  } catch (error) {
    loadError = apiError(error);
  }
  if (loadError) {
    const message = loadError === "forbidden"
      ? "Недостаточно прав для чтения CRM-календаря."
      : loadError === "fastapi_unavailable"
        ? "Не удалось получить данные CRM. Изменения не выполнялись."
        : loadError === "branch_count"
          ? "FastAPI вернул неожиданное число активных филиалов. Изменения заблокированы."
          : loadError === "room_count"
            ? "Для филиала ожидались четыре комнаты. Изменения заблокированы."
            : "FastAPI вернул календарь с другим филиалом, датой или составом комнат. Изменения заблокированы.";
    return <main className="crm-page"><h1 className="crm-page-title">Календарь недоступен</h1><p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{message}</p></main>;
  }
  if (!calendar) return <main className="crm-page"><h1 className="crm-page-title">Календарь недоступен</h1><p role="alert">Не удалось получить данные CRM.</p></main>;
  return <UnifiedCalendar branch={calendar.branch} timeline={calendar.timeline} date={date} error={sp.error} notice={sp.notice} />;
}
