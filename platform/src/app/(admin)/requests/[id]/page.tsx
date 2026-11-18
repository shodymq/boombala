import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { listLeads } from "@/core/bookings";
import { listPackages, listRooms, listSlots } from "@/core/catalog";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { SESSION_COOKIE } from "@/server/env";
import { confirmLeadAction, leadStatusAction } from "../actions";

export const metadata: Metadata = { title: "Карточка заявки" };

const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };
const ERRORS: Record<string, string> = {
  slot_taken: "Этот слот уже занят. Выберите другую комнату или время.",
  invalid: "Проверьте дату, слот, комнату и пакет (у пакета должна быть цена; прошедший слот занять нельзя).",
  conflict: "Заявка уже обработана.", forbidden: "Недостаточно прав.",
};
const NOTICES: Record<string, string> = { status: "Статус изменён." };
const input = "crm-requests-control";
const btn = "crm-requests-action";
const btnGhost = "crm-requests-action crm-requests-action-secondary";
const panel = "rounded-2xl border border-line bg-white p-5 shadow-sm";

type Catalog = { packages: Awaited<ReturnType<typeof listPackages>>; rooms: Awaited<ReturnType<typeof listRooms>>; slots: Awaited<ReturnType<typeof listSlots>> };

/**
 * Request card on the current production contract: the list RPC (bridge) or the database (direct mode).
 * There is no per-request endpoint, so the card is looked up in the full list. Payments and refunds are deliberately absent:
 * production has no supported operation for them on this path.
 */
export default async function RequestCardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("requests.manage");
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) notFound();
  const sp = await searchParams;
  let leads: Awaited<ReturnType<typeof listLeads>>;
  let cat: Catalog;
  const bridge = legacyBridgeEnabled();
  if (bridge) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new Error("session_missing");
    const [remoteCatalog, remoteLeads] = await Promise.all([
      bridgeRpc<Catalog>("catalog", {}, token),
      bridgeRpc<Awaited<ReturnType<typeof listLeads>>>("requests.list", {}, token),
    ]);
    leads = remoteLeads.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }));
    cat = remoteCatalog;
  } else {
    const pool = getPool();
    const actor = { id: user.id, role: user.role };
    const [l, packages, rooms, slots] = await Promise.all([listLeads(pool, actor, {}, 500), listPackages(pool), listRooms(pool), listSlots(pool)]);
    leads = l;
    cat = { packages, rooms, slots };
  }
  const lead = leads.find((l) => l.id === id);
  if (!lead) notFound();
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Almaty" });
  const open = lead.status === "new" || lead.status === "in_progress";
  const pkg = cat.packages.find((p) => p.id === lead.packageId)?.name ?? "не выбран";
  const room = cat.rooms.find((r) => r.id === lead.roomId)?.name ?? "не выбрана";

  return (
    <div className="crm-page crm-requests-page">
      <nav aria-label="Назад"><Link href="/requests" className="text-sm font-extrabold text-grape-700 underline">← Все заявки</Link></nav>
      <header className="crm-requests-heading">
        <div>
          <p className="crm-eyebrow">Заявка №{lead.seq}</p>
          <h1 className="crm-page-title">{lead.name}</h1>
          <p className="crm-page-subtitle">Создана {fmt.format(lead.createdAt)} (Алматы)</p>
        </div>
        <span className="crm-requests-status" data-status={lead.status}>{STATUS[lead.status] ?? lead.status}</span>
      </header>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="crm-requests-message crm-requests-message-success">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="crm-requests-message crm-requests-message-error">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <section className={panel} aria-labelledby="req-info">
        <h2 id="req-info" className="text-lg font-black text-grape-800">Данные заявки</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Телефон</dt><dd className="font-bold">{lead.phone}</dd></div>
          <div><dt className="text-muted">Желаемая дата</dt><dd className="font-bold">{lead.requestedDate ?? "не указана"}</dd></div>
          <div><dt className="text-muted">Пакет</dt><dd className="font-bold">{pkg}</dd></div>
          <div><dt className="text-muted">Комната</dt><dd className="font-bold">{room}</dd></div>
          <div><dt className="text-muted">Детей</dt><dd className="font-bold">{lead.children ?? "—"}</dd></div>
        </dl>
        {lead.reservationId ? <p className="mt-4 text-sm"><Link href={`/bookings?date=${lead.requestedDate}`} className="font-extrabold text-grape-700 underline">Показать бронь в календаре</Link></p> : null}
      </section>

      {open ? (
        <section className={panel} aria-labelledby="req-actions">
          <h2 id="req-actions" className="text-lg font-black text-grape-800">Действия</h2>
          {bridge ? (
            <p className="mt-3 text-sm font-bold text-muted">Подтверждение выполняется в календаре после фиксации ручной предоплаты. <Link href={`/bookings?date=${lead.requestedDate ?? ""}&new=1`} className="text-grape-700 underline">Открыть календарь</Link></p>
          ) : (
            <form action={confirmLeadAction} className="crm-requests-confirm mt-3">
              <input type="hidden" name="id" value={lead.id} />
              <input type="date" name="date" defaultValue={lead.requestedDate} required className={input} aria-label="Дата" />
              <select name="slotId" defaultValue={lead.slotId ?? ""} required className={input} aria-label="Слот">
                <option value="" disabled>Слот</option>
                {cat.slots.map((s) => <option key={s.id} value={s.id}>{s.startsAt}–{s.endsAt}</option>)}
              </select>
              <select name="roomId" defaultValue={lead.roomId ?? ""} required className={input} aria-label="Комната">
                <option value="" disabled>Комната</option>
                {cat.rooms.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select name="packageId" defaultValue={lead.packageId ?? ""} required className={input} aria-label="Пакет">
                <option value="" disabled>Пакет</option>
                {cat.packages.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="submit" className={btn}>Подтвердить бронь</button>
            </form>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {lead.status === "new" ? <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="in_progress" /><button type="submit" className={btnGhost}>В работу</button></form> : null}
            <form action={leadStatusAction}><input type="hidden" name="id" value={lead.id} /><input type="hidden" name="status" value="cancelled" /><button type="submit" className={btnGhost}>Отклонить</button></form>
          </div>
        </section>
      ) : null}
    </div>
  );
}
