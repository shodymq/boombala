import Link from "next/link";
import { almatyDate, almatyMinutes, almatyWindow, assignLanes, axisRange, axisSpan, formatMinutes, overlappingIds, paymentLabel, startOptions, windowOverlapsRoom, type Axis, type WorkingWindow } from "../../../core/booking-calendar.ts";
import { heightClass, LANE_CLASSES, topClass } from "../../../core/booking-grid-classes.ts";
import type { BookingTimelineReservation } from "../../../server/fastapi-crm.ts";

const kzt = new Intl.NumberFormat("ru-RU");

export function clock(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

type Tone = "confirmed" | "prepay" | "block" | "conflict";

const TONE_CLASS: Record<Tone, string> = {
  confirmed: "border-ok bg-green-50 text-grape-900",
  prepay: "border-sun-400 bg-sun-100 text-grape-900",
  block: "border-muted bg-line text-grape-900 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(92_80_117/0.12)_6px_12px)]",
  conflict: "border-danger bg-red-100 text-grape-900",
};
const TONE_LABEL: Record<Tone, string> = { confirmed: "Подтверждена", prepay: "Ждёт предоплату", block: "Блокировка", conflict: "Конфликт" };

/**
 * The day as the paper journal shows it: time runs down, rooms run across. Positions are exact minutes (see
 * booking-grid-classes.ts). Only what the FastAPI timeline returned is drawn: there are no empty "free slot" targets, and a
 * request without a confirmed room and time never appears here.
 */
export function DayTimeline({
  rooms,
  reservations,
  axis,
  hours,
  hrefFor,
  createHrefFor,
  date,
  selectedId,
}: {
  rooms: { id: string; name: string; occupancyMode?: "exclusive" | "shared" }[];
  reservations: BookingTimelineReservation[];
  axis: Axis;
  hours: WorkingWindow | null;
  hrefFor: (reservationId: string) => string;
  createHrefFor: (roomId: string, startTime: string) => string;
  date: string;
  selectedId?: string;
}) {
  const active = reservations.filter((r) => r.status !== "released");
  const exclusiveIds = new Set(rooms.filter((room) => room.occupancyMode !== "shared").map((room) => room.id));
  const flagged = overlappingIds(active.filter((r) => exclusiveIds.has(r.roomId)).map((r) => ({ id: r.id, roomId: r.roomId, startsAt: r.startsAt, endsAt: r.endsAt })));
  const marks: number[] = [];
  for (let m = axis.startMin; m <= axis.endMin; m += 60) marks.push(m);
  const closed = hours ? [axisRange(axis, axis.startMin, hours.openMin), axisRange(axis, hours.closeMin, axis.endMin)].filter((x) => x !== null) : [];

  return (
    <>
    <div className="hidden max-h-[calc(100vh-15rem)] min-h-[26rem] overflow-auto rounded-2xl border border-line bg-white md:block" data-timeline>
      <div className="flex min-w-max md:min-w-full">
        <div className="sticky left-0 z-30 w-14 shrink-0 border-r border-line bg-white">
          <div className="sticky top-0 z-40 h-12 border-b border-line bg-white" />
          <div className={`relative ${heightClass(axis.minutes)}`} aria-hidden="true">
            {marks.map((m, i) => (
              <span key={m} className={`absolute right-1.5 ${topClass(m - axis.startMin)} ${i === 0 ? "" : "-translate-y-1/2"} text-xs font-extrabold text-muted`}>
                {formatMinutes(m)}
              </span>
            ))}
          </div>
        </div>
        {rooms.map((room) => {
          const items = active
            .filter((r) => r.roomId === room.id)
            .map((r) => ({ r, span: axisSpan(axis, r.startsAt, r.endsAt) }))
            .filter((x): x is { r: BookingTimelineReservation; span: { top: number; height: number } } => x.span !== null);
          const lanes = assignLanes(items.map((x) => ({ id: x.r.id, start: x.span.top, span: x.span.height })));
          const laneCount = Math.min(Math.max(1, ...[...lanes.values()]), 3);
          return (
            <div key={room.id} className="min-w-44 flex-1 border-r border-line last:border-r-0" role="group" aria-label={room.name}>
              <h2 className="sticky top-0 z-20 flex h-12 items-center justify-center border-b border-line bg-grape-50 px-2 text-center text-sm font-black text-grape-800">{room.name}</h2>
              <div className={`relative ${heightClass(axis.minutes)} bg-paper`} role="list" aria-label={`Занятость: ${room.name}`}>
                {closed.map((c, i) => (c ? <div key={i} aria-hidden="true" className={`absolute inset-x-0 ${topClass(c.top)} ${heightClass(c.height)} bg-line/50`} /> : null))}
                {marks.map((m, i) => (i === 0 ? null : <div key={m} aria-hidden="true" className={`absolute inset-x-0 ${topClass(m - axis.startMin)} border-t border-grape-100`} />))}
                {items.map(({ r, span }) => {
                  const conflict = flagged.has(r.id);
                  const pay = paymentLabel(r, (n) => kzt.format(n));
                  const tone: Tone = conflict ? "conflict" : r.kind === "block" ? "block" : pay.tone === "prepaid" ? "confirmed" : "prepay";
                  const lane = Math.min(lanes.get(r.id) ?? 1, laneCount);
                  const pos = LANE_CLASSES[laneCount][lane - 1];
                  const short = span.height < 90;
                  return (
                    <div key={r.id} role="listitem" className="contents">
                      <Link
                        href={hrefFor(r.id)}
                        prefetch={false}
                        scroll={false}
                        data-reservation={r.id}
                        data-state={conflict ? "conflict" : r.kind === "block" ? "blocked" : "booked"}
                        data-payment={r.kind === "block" ? "none" : pay.tone}
                        data-start={clock(r.startsAt)}
                        data-end={clock(r.endsAt)}
                        aria-label={`${room.name}, ${clock(r.startsAt)}–${clock(r.endsAt)}, ${TONE_LABEL[tone]}`}
                        className={`absolute z-10 ${topClass(span.top)} ${heightClass(span.height)} ${pos.left} ${pos.width} overflow-hidden rounded-lg border-2 px-2 py-1 text-xs leading-tight ${TONE_CLASS[tone]} ${selectedId === r.id ? "ring-4 ring-grape-600" : ""} hover:brightness-95`}
                      >
                        <span className="block truncate font-black">{clock(r.startsAt)}–{clock(r.endsAt)}{conflict ? " · конфликт" : ""}</span>
                        {r.sourceManaged ? (
                          <>
                            <span className="block truncate font-bold">{r.packageName ?? "Мероприятие из таблицы"}</span>
                            {short ? null : <span className="block truncate">{r.customerName ?? "Клиент"}</span>}
                            <span className="block truncate font-bold">{r.sourceState === "source_missing" ? "Источник удалён · сверка" : r.sourceState === "manual_review" ? "Требуется сверка" : "Google Sheets · синхронизация"}</span>
                          </>
                        ) : r.kind === "block" ? (
                          <span className="block truncate font-bold">Блокировка{r.note ? `: ${r.note}` : ""}</span>
                        ) : (
                          <>
                            <span className="block truncate font-bold">{r.packageName ?? "Праздник"}</span>
                            {short ? null : <span className="block truncate">{r.customerName ?? "Клиент скрыт"}</span>}
                            <span className="block truncate font-bold">{pay.tone === "prepaid" ? "✓ " : "⏳ "}{pay.text}</span>
                          </>
                        )}
                      </Link>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
    <div className="grid gap-3 md:hidden" data-mobile-calendar>
      {rooms.map((room) => {
        const roomEvents = active.filter((r) => r.roomId === room.id).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        const nowMinute = date === almatyDate() ? almatyMinutes(new Date().toISOString()) : null;
        const candidates = hours ? startOptions(hours).filter((start) => {
          if (nowMinute !== null && (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) <= nowMinute)) return false;
          if (room.occupancyMode === "shared") return true;
          const window = almatyWindow(date, start);
          return !windowOverlapsRoom(active.map((r) => ({ roomId: r.roomId, startsAt: r.startsAt, endsAt: r.endsAt, status: r.status })), room.id, window.startIso, window.endIso);
        }) : [];
        const defaultStart = candidates[0] ?? null;
        return (
          <article key={room.id} className="grid gap-3 rounded-2xl border border-line bg-white p-3" data-mobile-room={room.id}>
            <header className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="break-words text-base font-black text-grape-800">{room.name}</h2>
                {room.occupancyMode === "shared" ? <p className="mt-1 text-xs font-bold text-grape-700">Общая зона · параллельные мероприятия допустимы</p> : null}
              </div>
              <span className="shrink-0 rounded-full bg-grape-50 px-2.5 py-1 text-xs font-extrabold text-grape-800">{roomEvents.length} занято</span>
            </header>
            {roomEvents.length ? (
              <ul className="grid gap-2" aria-label={`Занятые интервалы: ${room.name}`}>
                {roomEvents.map((r) => {
                  const pay = paymentLabel(r, (n) => kzt.format(n));
                  const stateLabel = r.kind === "block" ? "Блокировка" : r.status === "confirmed" ? "Подтверждена" : "Ждёт предоплату";
                  return <li key={r.id}>
                    <Link href={hrefFor(r.id)} prefetch={false} scroll={false} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3 py-2 text-sm text-grape-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-grape-700" data-mobile-reservation={r.id}>
                      <span className="min-w-0"><strong className="tabular-nums">{clock(r.startsAt)}–{clock(r.endsAt)}</strong><span className="block truncate text-xs font-semibold text-muted">{r.kind === "block" ? "Блокировка" : r.packageName ?? "Праздник"}</span></span>
                      <span className="shrink-0 text-right text-xs font-extrabold">{stateLabel}{r.kind === "booking" ? <span className="block font-semibold text-muted">{pay.tone === "prepaid" ? "Предоплата есть" : "Ожидает предоплату"}</span> : null}</span>
                    </Link>
                  </li>;
                })}
              </ul>
            ) : <p className="rounded-xl bg-paper px-3 py-2 text-sm font-semibold text-muted">Броней и блокировок на эту дату нет.</p>}
            {hours ? <div className="grid gap-2">
              <p className="text-xs font-extrabold text-muted">{candidates.length ? `Свободное начало: ${candidates.slice(0, 3).join(", ")}${candidates.length > 3 ? " и другие" : ""}` : "Свободного будущего начала в рабочем окне нет"}</p>
              {defaultStart ? <Link href={createHrefFor(room.id, defaultStart)} prefetch={false} scroll={false} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-grape-700 px-4 text-sm font-extrabold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-700">Создать бронь · {defaultStart}</Link> : null}
            </div> : null}
          </article>
        );
      })}
    </div>
    </>
  );
}

export function TimelineLegend() {
  const chip = (cls: string, text: string) => (
    <span className="inline-flex items-center gap-1"><span aria-hidden="true" className={`inline-block h-3 w-4 rounded border-2 ${cls}`} />{text}</span>
  );
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-muted">
      {chip(TONE_CLASS.confirmed, "подтверждена, предоплата записана")}
      {chip(TONE_CLASS.prepay, "ждёт предоплату")}
      {chip(TONE_CLASS.block, "блокировка")}
      {chip(TONE_CLASS.conflict, "конфликт: сообщите администратору")}
      <span>Серая зона — вне часов работы. Заявки без подтверждённой комнаты в сетке не показываются.</span>
    </p>
  );
}
