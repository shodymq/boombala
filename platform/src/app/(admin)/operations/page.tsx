import type { Metadata } from "next";
import { cookies } from "next/headers";
import { almatyDate } from "@/core/booking-calendar";
import { buildUpcomingBirthdayOperations, upcomingOperationDates } from "@/core/operations-overview";
import type { OperationsReadRow } from "@/core/operations-overview";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { requirePermissionAnd } from "@/server/dal";
import { SESSION_COOKIE } from "@/server/env";

export const metadata: Metadata = { title: "Ближайшие праздники" };

const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const TIME_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Almaty",
});
const KZT_FORMAT = new Intl.NumberFormat("ru-RU");

type ReadResult = OperationsReadRow[] | null;

async function readLegacyOperations(dates: string[]): Promise<OperationsReadRow[]> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new Error("session_missing");
  return bridgeRpc<{ timezone: "Asia/Almaty"; reservations: OperationsReadRow[] }>("operations.overview", { dates }, token)
    .then((response) => {
      if (response.timezone !== "Asia/Almaty" || !Array.isArray(response.reservations)) throw new Error("operations_response_invalid");
      return response.reservations;
    });
}

function dateLabel(date: string): string {
  return DATE_FORMAT.format(new Date(`${date}T00:00:00.000Z`));
}

function timeLabel(instant: string): string {
  return TIME_FORMAT.format(new Date(instant));
}

function programLabel(status: "approved" | "draft" | null): string {
  if (status === "approved") return "Согласована";
  if (status === "draft") return "Не согласована";
  return "Не указано";
}

function propsLabel(status: "not_started" | "preparing" | "ready" | null): string {
  if (status === "ready") return "Готовы";
  if (status === "preparing") return "Готовятся";
  if (status === "not_started") return "Не начаты";
  return "Не указано";
}

function invitationLabel(status: "not_applicable" | "not_started" | "in_progress" | "sent"): string {
  if (status === "not_applicable") return "Не требуется";
  if (status === "not_started") return "Не начато";
  if (status === "in_progress") return "Готовится";
  return "Отправлено";
}

export default async function OperationsPage() {
  const dates = upcomingOperationDates(almatyDate());
  const { data } = await requirePermissionAnd("bookings.manage", async (): Promise<ReadResult> => {
    try {
      // The current FastAPI timeline includes customer PII and source payloads. Fail closed until it exposes this same
      // narrow allowlisted read model; never fetch the full timeline just to discard private fields in the page.
      if (!legacyBridgeEnabled()) return null;
      return await readLegacyOperations(dates);
    } catch {
      return null;
    }
  });

  let loadFailed = data === null;

  let events = [] as ReturnType<typeof buildUpcomingBirthdayOperations>;
  if (!loadFailed && data) {
    try {
      events = buildUpcomingBirthdayOperations(data);
    } catch {
      loadFailed = true;
    }
  }
  const grouped = dates
    .map((date) => ({ date, events: events.filter((event) => event.date === date) }))
    .filter((group) => group.events.length > 0);

  return (
    <div className="grid min-w-0 gap-5" data-testid="operations-overview">
      <header className="grid gap-1">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Ближайшие праздники</h1>
        <p className="text-sm font-semibold text-muted">Сегодня и следующие 6 дней · время Алматы · бронирования и импортированные записи на проверку</p>
      </header>

      {loadFailed ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900" data-testid="operations-error">
          Не удалось загрузить расписание. События не показаны, чтобы пустой список не выглядел как свободные даты. Обновите страницу позже.
        </p>
      ) : events.length === 0 ? (
        <p className="rounded-2xl border border-line bg-white p-5 text-sm font-semibold text-muted" data-testid="operations-empty">
          На ближайшие 7 дней подтверждённых праздников нет.
        </p>
      ) : (
        <div className="grid gap-5" data-testid="operations-events">
          {grouped.map((group) => (
            <section key={group.date} aria-labelledby={`operations-day-${group.date}`} className="grid gap-3">
              <h2 id={`operations-day-${group.date}`} className="text-lg font-black capitalize text-grape-800">
                {dateLabel(group.date)}
              </h2>
              <ul className="grid gap-3">
                {group.events.map((event) => (
                  <li key={event.id}>
                    <article className="grid gap-4 rounded-2xl border border-line bg-white p-4 sm:p-5" data-testid="operations-event">
                      {event.recordStatus !== "confirmed" ? (
                        <p className="w-fit rounded-full bg-sun-100 px-3 py-1 text-xs font-bold text-grape-900" data-testid="operations-record-review">
                          {event.recordStatus === "source_missing" ? "Источник не содержит строку · требуется сверка" : event.recordStatus === "crm_managed" ? "Передано CRM · подтверждение брони не зарегистрировано" : "Импортировано · требуется ручная проверка"}
                        </p>
                      ) : null}
                      <div className="grid gap-1 sm:grid-cols-[minmax(7rem,auto)_1fr] sm:items-baseline sm:gap-3">
                        <p className="text-lg font-black tabular-nums text-grape-800">{timeLabel(event.startsAt)}</p>
                        <p className="break-words text-base font-extrabold text-grape-900">{event.room} <span aria-hidden="true">·</span> {event.packageName}</p>
                      </div>
                      {event.recordStatus === "confirmed" ? (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 xl:grid-cols-5">
                          <div>
                            <dt className="font-semibold text-muted">Ответственный</dt>
                            <dd className="mt-0.5 font-bold text-ink">{event.responsibleManager ?? "Не назначен"}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-muted">Программа</dt>
                            <dd className="mt-0.5 font-bold text-ink">{programLabel(event.programStatus)}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-muted">Реквизит</dt>
                            <dd className="mt-0.5 font-bold text-ink">{propsLabel(event.propsStatus)}</dd>
                          </div>
                          {event.invitationStatus ? (
                            <div>
                              <dt className="font-semibold text-muted">Приглашение</dt>
                              <dd className="mt-0.5 font-bold text-ink">{invitationLabel(event.invitationStatus)}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt className="font-semibold text-muted">Предоплата</dt>
                            <dd className="mt-0.5 font-bold text-ink" data-testid="operations-payment">
                              {event.paymentFact.status === "confirmed"
                                ? `Подтверждено: ${KZT_FORMAT.format(event.paymentFact.amountKzt)} ₸`
                                : "Факт не записан"}
                            </dd>
                          </div>
                        </dl>
                      ) : null}
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
