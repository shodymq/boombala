import type { Metadata } from "next";
import Link from "next/link";
import { getGrid, type Cell } from "@/core/bookings";
import { listPackages } from "@/core/catalog";
import { almatyToday, isValidDate } from "@/core/dates";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { blockAction, manualBookingAction, releaseAction } from "./actions";

export const metadata: Metadata = { title: "Календарь" };

const NOTICES: Record<string, string> = { booked: "Бронь создана.", blocked: "Слот заблокирован.", released: "Освобождено." };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят (кто-то успел раньше). Данные обновлены.",
  invalid: "Проверьте введённые данные (дата, пакет, имя, телефон; прошедший слот занять нельзя).",
  conflict: "Действие уже выполнено или недоступно.",
  forbidden: "Недостаточно прав.",
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

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ date?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("bookings.manage");
  const sp = await searchParams;
  const date = sp.date && isValidDate(sp.date) ? sp.date : almatyToday();
  const actor = { id: user.id, role: user.role };
  const [grid, packages] = await Promise.all([getGrid(getPool(), actor, date), listPackages(getPool())]);
  const activePackages = packages.filter((p) => p.isActive);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  const cellOf = (roomId: string, slotId: number) => grid.cells.find((c) => c.roomId === roomId && c.slotId === slotId) as Cell;

  return (
    <div className="grid min-w-0 gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Календарь</h1>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav aria-label="Дата" className="flex flex-wrap items-center gap-2">
        <Link href={`/bookings?date=${shift(date, -1)}`} className={btnGhost + " flex items-center"} aria-label="Предыдущий день">←</Link>
        <form method="get" className="flex items-center gap-2">
          <input type="date" name="date" defaultValue={date} className={input + " w-auto"} aria-label="Дата" />
          <button type="submit" className={btn}>Показать</button>
        </form>
        <Link href={`/bookings?date=${shift(date, 1)}`} className={btnGhost + " flex items-center"} aria-label="Следующий день">→</Link>
        <Link href="/bookings" className="text-sm font-extrabold text-grape-700 underline">Сегодня</Link>
      </nav>
      <p className="text-base font-bold text-grape-900 first-letter:uppercase">{weekday}</p>
      {grid.unplacedLeads ? (
        <p className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          Заявок на эту дату без выбранной комнаты или слота: {grid.unplacedLeads}. <Link href="/requests?status=new" className="underline">Открыть заявки</Link>
        </p>
      ) : null}

      <div className="hidden grid-cols-[8rem_repeat(3,1fr)] gap-3 text-sm font-black text-grape-800 md:grid" aria-hidden="true">
        <span />
        {grid.slots.map((s) => <span key={s.id}>{s.startsAt}–{s.endsAt}</span>)}
      </div>

      <section aria-label="Комнаты и слоты" className="grid gap-4">
        {grid.rooms.map((room) => (
          <article key={room.id} className="grid gap-3 rounded-3xl border border-line bg-white p-4 md:grid-cols-[8rem_repeat(3,1fr)] md:items-start">
            <h2 className="text-lg font-black text-grape-800 md:pt-2">{room.name}</h2>
            {grid.slots.map((slot) => {
              const cell = cellOf(room.id, slot.id);
              const tone = cell.state === "free" ? "border-grape-200 bg-paper" : cell.state === "booked" ? "border-grape-600 bg-grape-100" : "border-muted bg-sun-100";
              return (
                <div key={slot.id} data-cell={`${room.id}:${slot.id}`} data-state={cell.state} className={`min-w-0 rounded-2xl border-2 p-3 ${tone}`}>
                  <p className="text-xs font-extrabold text-muted md:hidden">{slot.startsAt}–{slot.endsAt}</p>
                  {cell.state === "free" ? (
                    <>
                      <p className="text-sm font-black text-grape-800">Свободно{cell.pendingLeads ? ` · заявок: ${cell.pendingLeads}` : ""}</p>
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
