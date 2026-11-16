import Link from "next/link";
import { assignLanes, axisRange, axisSpan, formatMinutes, overlappingIds, paymentLabel, type Axis, type WorkingWindow } from "../../../core/booking-calendar.ts";
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
  selectedId,
}: {
  rooms: { id: string; name: string }[];
  reservations: BookingTimelineReservation[];
  axis: Axis;
  hours: WorkingWindow | null;
  hrefFor: (reservationId: string) => string;
  selectedId?: string;
}) {
  const active = reservations.filter((r) => r.status !== "released");
  const flagged = overlappingIds(active.map((r) => ({ id: r.id, roomId: r.roomId, startsAt: r.startsAt, endsAt: r.occupiedEndsAt })));
  const marks: number[] = [];
  for (let m = axis.startMin; m <= axis.endMin; m += 60) marks.push(m);
  const closed = hours ? [axisRange(axis, axis.startMin, hours.openMin), axisRange(axis, hours.closeMin, axis.endMin)].filter((x) => x !== null) : [];

  return (
    <div className="max-h-[calc(100vh-15rem)] min-h-[26rem] overflow-auto rounded-2xl border border-line bg-white" data-timeline>
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
            .map((r) => ({ r, span: axisSpan(axis, r.startsAt, r.endsAt), buffer: axisSpan(axis, r.endsAt, r.occupiedEndsAt) }))
            .filter((x): x is { r: BookingTimelineReservation; span: { top: number; height: number }; buffer: { top: number; height: number } | null } => x.span !== null);
          const lanes = assignLanes(items.map((x) => ({ id: x.r.id, start: x.span.top, span: x.span.height })));
          const laneCount = Math.min(Math.max(1, ...[...lanes.values()]), 3);
          return (
            <div key={room.id} className="min-w-44 flex-1 border-r border-line last:border-r-0" role="group" aria-label={room.name}>
              <h2 className="sticky top-0 z-20 flex h-12 items-center justify-center border-b border-line bg-grape-50 px-2 text-center text-sm font-black text-grape-800">{room.name}</h2>
              <div className={`relative ${heightClass(axis.minutes)} bg-paper`} role="list" aria-label={`Занятость: ${room.name}`}>
                {closed.map((c, i) => (c ? <div key={i} aria-hidden="true" className={`absolute inset-x-0 ${topClass(c.top)} ${heightClass(c.height)} bg-line/50`} /> : null))}
                {marks.map((m, i) => (i === 0 ? null : <div key={m} aria-hidden="true" className={`absolute inset-x-0 ${topClass(m - axis.startMin)} border-t border-grape-100`} />))}
                {items.map(({ r, span, buffer }) => {
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
                        {r.kind === "block" ? (
                          <span className="block truncate font-bold">Блокировка{r.note ? `: ${r.note}` : ""}</span>
                        ) : (
                          <>
                            <span className="block truncate font-bold">{r.packageName ?? "Праздник"}</span>
                            {short ? null : <span className="block truncate">{r.customerName ?? "Клиент скрыт"}</span>}
                            <span className="block truncate font-bold">{pay.tone === "prepaid" ? "✓ " : "⏳ "}{pay.text}</span>
                          </>
                        )}
                      </Link>
                      {buffer ? <div aria-hidden="true" data-buffer={r.id} className={`absolute inset-x-1 z-0 ${topClass(buffer.top)} ${heightClass(buffer.height)} rounded border border-dashed border-muted bg-line/70`} /> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
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
