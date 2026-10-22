import type { Metadata } from "next";
import Link from "next/link";
import { listLeads } from "@/core/bookings";
import { listPackages, listRooms, listSlots } from "@/core/catalog";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { confirmLeadAction, leadStatusAction } from "./actions";

export const metadata: Metadata = { title: "Заявки" };

const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };
const NOTICES: Record<string, string> = { status: "Статус изменён." };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят. Выберите другую комнату или время.",
  invalid: "Проверьте дату, слот, комнату и пакет (у пакета должна быть цена; прошедший слот занять нельзя).",
  conflict: "Заявка уже обработана.", forbidden: "Недостаточно прав.",
};
const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("requests.manage");
  const sp = await searchParams;
  const status = sp.status && STATUS[sp.status] ? sp.status : undefined;
  const actor = { id: user.id, role: user.role };
  const pool = getPool();
  const [leads, packages, rooms, slots] = await Promise.all([listLeads(pool, actor, { status }), listPackages(pool), listRooms(pool), listSlots(pool)]);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const pkgName = (id: string | null) => packages.find((p) => p.id === id)?.name ?? "не выбран";

  return (
    <div className="grid min-w-0 gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Заявки</h1>
      <p className="text-sm text-muted">Заявка не занимает слот. Слот занимает только подтверждение. Цена фиксируется в момент подтверждения.</p>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}
      <nav aria-label="Фильтр" className="flex flex-wrap gap-2">
        <Link href="/requests" className={btnGhost + " flex items-center"}>Все</Link>
        {Object.entries(STATUS).map(([k, v]) => <Link key={k} href={`/requests?status=${k}`} className={btnGhost + " flex items-center"}>{v}</Link>)}
      </nav>
      <ul className="grid gap-3">
        {leads.map((l) => {
          const open = l.status === "new" || l.status === "in_progress";
          return (
            <li key={l.id} className="min-w-0 rounded-3xl border border-line bg-white p-5" data-lead={l.seq}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="break-words text-base font-black text-grape-800">№{l.seq} · {l.name}</h2>
                <span className="text-xs font-bold text-muted">{STATUS[l.status]}</span>
              </div>
              <p className="mt-1 text-sm">{l.phone} · {fmt.format(l.createdAt)}</p>
              <p className="text-sm text-muted">На {l.requestedDate} · пакет: {pkgName(l.packageId)}{l.children != null ? ` · детей: ${l.children}` : ""}</p>
              {l.reservationId ? <p className="mt-1 text-sm"><Link href={`/bookings?date=${l.requestedDate}`} className="font-extrabold text-grape-700 underline">Показать в календаре</Link></p> : null}
              {open ? (
                <>
                  <form action={confirmLeadAction} className="mt-3 grid gap-2 sm:grid-cols-2">
                    <input type="hidden" name="id" value={l.id} />
                    <input type="date" name="date" defaultValue={l.requestedDate} required className={input} aria-label="Дата" />
                    <select name="slotId" defaultValue={l.slotId ?? ""} required className={input} aria-label="Слот">
                      <option value="" disabled>Слот</option>
                      {slots.map((s) => <option key={s.id} value={s.id}>{s.startsAt}–{s.endsAt}</option>)}
                    </select>
                    <select name="roomId" defaultValue={l.roomId ?? ""} required className={input} aria-label="Комната">
                      <option value="" disabled>Комната</option>
                      {rooms.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <select name="packageId" defaultValue={l.packageId ?? ""} required className={input} aria-label="Пакет">
                      <option value="" disabled>Пакет</option>
                      {packages.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button type="submit" className={btn + " sm:col-span-2 sm:justify-self-start"}>Подтвердить бронь</button>
                  </form>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {l.status === "new" ? <form action={leadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="in_progress" /><button type="submit" className={btnGhost}>В работу</button></form> : null}
                    <form action={leadStatusAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value="cancelled" /><button type="submit" className={btnGhost}>Отклонить</button></form>
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
        {leads.length === 0 ? <li className="rounded-3xl border border-line bg-white p-5 text-sm text-muted">Заявок нет.</li> : null}
      </ul>
    </div>
  );
}
