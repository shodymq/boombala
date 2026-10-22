"use client";

import { useEffect, useState } from "react";
import { BOOKING_SLOTS } from "@/lib/lead";
import { birthdayRooms } from "@/data/birthdayRooms";
import { PreferredTime } from "@/components/booking/PreferredTime";

interface Day {
  slots: Array<{ id: number; startsAt: string; endsAt: string; freeRoomIds: string[] }>;
  prices: Record<string, { amountKzt: number; source: "date" | "weekday" | "base" } | null>;
}
interface Month {
  roomCount: number;
  days: Record<string, Record<string, number>>;
}

const kzt = new Intl.NumberFormat("ru-RU");
const SOURCE_LABEL = { date: "особая цена на эту дату", weekday: "будний день", base: "стандартная цена" } as const;
const roomName = (id: string) => birthdayRooms.find((r) => r.id === id)?.name ?? id;


/**
 * GET JSON from our own API. `loading`/`error` are derived from which request the stored answer belongs to (no setState in the
 * effect body). `retry()` repeats the same request after an error; a new URL or a retry never shows an older answer.
 */
function useFetched<T>(url: string | null): { data: T | null; error: boolean; loading: boolean; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [res, setRes] = useState<{ id: string; data: T | null; error: boolean } | null>(null);
  const id = url ? `${attempt}:${url}` : "";
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok || !data?.ok) throw new Error("unavailable");
        setRes({ id, data, error: false });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setRes({ id, data: null, error: true });
      });
    return () => ctrl.abort();
  }, [url, id]);
  const settled = !!url && res?.id === id;
  return { data: settled ? res!.data : null, error: settled && res!.error, loading: !!url && !settled, retry: () => setAttempt((n) => n + 1) };
}

export const calendarEnabled = process.env.NEXT_PUBLIC_BOOKING_CALENDAR === "1";

/**
 * Availability for the chosen date: free rooms per slot and the price of the chosen package ON THAT DATE.
 * It only reads. An enquiry does not reserve anything; the manager confirms. If the service cannot answer we say so.
 */
export function AvailabilityPanel({
  date,
  packageId,
  slot,
  onSlot,
  onPickDate,
  minDate,
}: {
  date: string;
  packageId: string;
  slot: string;
  onSlot: (id: string) => void;
  onPickDate: (date: string) => void;
  minDate: string;
}) {
  const [month, setMonth] = useState((date || minDate).slice(0, 7));
  const [open, setOpen] = useState(false);
  const dayRes = useFetched<Day>(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `/api/availability?date=${date}` : null);
  const monthRes = useFetched<Month>(open ? `/api/availability?month=${month}` : null);
  const day = dayRes.data;
  const dayState = dayRes.error ? "error" : dayRes.loading ? "loading" : "idle";
  const monthData = monthRes.data;
  const monthState = monthRes.error ? "error" : monthRes.loading ? "loading" : "idle";

  const price = day && packageId !== "undecided" ? day.prices[packageId] : null;
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shiftMonth = (d: number) => {
    const n = new Date(Date.UTC(y, m - 1 + d, 1));
    setMonth(`${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <div className="grid gap-3 rounded-2xl border-2 border-grape-200 bg-grape-50 p-4" data-testid="availability">
      <button type="button" onClick={() => { if (!open && /^\d{4}-\d{2}-\d{2}$/.test(date)) setMonth(date.slice(0, 7)); setOpen((v) => !v); }} aria-expanded={open} className="flex min-h-11 items-center text-left font-display text-sm font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4">
        {open ? "Скрыть календарь" : "Посмотреть свободные даты"}
      </button>
      {open ? (
        <div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Предыдущий месяц" className="h-11 w-11 rounded-full text-lg font-black text-grape-800">‹</button>
            <span className="font-display text-sm font-extrabold text-grape-800 first-letter:uppercase">{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(first)}</span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="Следующий месяц" className="h-11 w-11 rounded-full text-lg font-black text-grape-800">›</button>
          </div>
          {monthState === "error" ? (
            <div className="mt-2 grid gap-2">
              <p role="alert" className="text-sm font-semibold text-[#b3261e]">Не удалось загрузить календарь. Попробуйте позже или отправьте заявку, менеджер подтвердит дату.</p>
              <button type="button" onClick={monthRes.retry} className="min-h-11 justify-self-start rounded-full border-2 border-grape-200 bg-white px-4 font-display text-sm font-extrabold text-grape-800">Проверить ещё раз</button>
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-7 gap-1 text-center text-sm" aria-busy={monthState === "loading"}>
              {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => <span key={w} className="text-xs font-bold text-muted">{w}</span>)}
              {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: count }, (_, i) => {
                const iso = `${month}-${String(i + 1).padStart(2, "0")}`;
                const free = monthData?.days[iso];
                const past = iso < minDate;
                const full = !!free && Object.values(free).every((n) => n === 0);
                const partial = !!free && !full && Object.values(free).some((n) => n < (monthData?.roomCount ?? 4));
                const state = past ? "past" : monthState !== "idle" || !monthData ? "unknown" : full ? "full" : partial ? "partial" : "free";
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={past || full}
                    onClick={() => onPickDate(iso)}
                    data-day={iso}
                    data-state={state}
                    aria-label={`${i + 1}: ${state === "full" ? "занято" : state === "partial" ? "есть свободные слоты" : state === "free" ? "свободно" : ""}`}
                    className={`h-11 rounded-xl text-sm font-bold disabled:cursor-not-allowed ${
                      iso === date ? "bg-grape-700 text-white" : state === "full" ? "bg-grape-100 text-muted line-through" : state === "partial" ? "bg-sun-100 text-grape-900" : state === "free" ? "bg-white text-grape-900" : "bg-white/60 text-muted"
                    }`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">Белые: свободно. Жёлтые: часть слотов занята. Зачёркнутые: всё занято.</p>
        </div>
      ) : null}

      {date ? (
        dayState === "error" ? (
          // Outage fallback: the API cannot answer, so NOTHING is claimed (no free rooms, no prices). The visitor can still
          // state a preferred interval; date and interval stay in the form and the calendar can be asked again.
          <div className="grid gap-3" data-testid="availability-outage">
            <p role="alert" className="text-sm font-semibold text-[#b3261e]">Сейчас не удаётся получить свободное время и цену на эту дату. Вы можете отправить заявку: менеджер подтвердит время и стоимость.</p>
            <button type="button" onClick={dayRes.retry} className="min-h-11 justify-self-start rounded-full border-2 border-grape-200 bg-white px-4 font-display text-sm font-extrabold text-grape-800">Проверить ещё раз</button>
            <PreferredTime slot={slot} onSlot={onSlot} />
          </div>
        ) : day ? (
          <div aria-busy={dayState === "loading"}>
            <p className="font-display text-sm font-extrabold text-grape-800">Время (по желанию)</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Желаемое время">
              {BOOKING_SLOTS.map((s) => {
                const info = day.slots.find((x) => String(x.id) === s.id);
                const free = info?.freeRoomIds.length ?? 0;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={slot === s.id}
                    disabled={free === 0}
                    data-slot={s.id}
                    onClick={() => onSlot(slot === s.id ? "" : s.id)}
                    className={`min-h-12 rounded-xl border-2 px-3 py-2 text-left text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${slot === s.id ? "border-grape-700 bg-grape-700 text-white" : "border-grape-200 bg-white text-grape-900"}`}
                  >
                    {s.label}
                    <span className="block text-xs font-medium opacity-80">{free === 0 ? "занято" : `свободно комнат: ${free}`}</span>
                  </button>
                );
              })}
            </div>
            {slot && (day.slots.find((x) => String(x.id) === slot)?.freeRoomIds.length ?? 0) === 0 ? (
              <p role="alert" className="mt-2 text-sm font-semibold text-[#b3261e]">Выбранное время занято на эту дату. Выберите другое или отправьте заявку, менеджер предложит варианты.</p>
            ) : null}
            {slot ? (
              <p className="mt-2 text-xs text-muted">
                Свободны: {day.slots.find((x) => String(x.id) === slot)?.freeRoomIds.map(roomName).join(", ") || "нет"}.
              </p>
            ) : null}
            {price ? (
              <p className="mt-3 text-base font-black text-grape-800" data-testid="price">
                Стоимость на {date.split("-").reverse().join(".")}: {kzt.format(price.amountKzt)} ₸ <span className="text-xs font-medium text-muted">({SOURCE_LABEL[price.source]})</span>
              </p>
            ) : packageId === "undecided" ? (
              <p className="mt-3 text-sm text-muted">Выберите пакет, чтобы увидеть стоимость на эту дату.</p>
            ) : null}
            <p className="mt-2 text-xs text-muted">Заявка не бронирует время: слот закрепляется после подтверждения менеджером. Оплаты на сайте нет.</p>
          </div>
        ) : dayState === "loading" ? (
          <p className="text-sm text-muted">Загружаем свободное время…</p>
        ) : null
      ) : null}
    </div>
  );
}
