import type { Metadata } from "next";
import Link from "next/link";
import { listContacts, type ContactFilters } from "@/core/crm";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";

export const metadata: Metadata = { title: "Клиенты" };

const SOURCE = { qr: "QR-регистрация", birthday_form: "Заявка на праздник", manual: "Вручную" } as const;
const VERIFY = { unverified: "не подтверждён", verified: "подтверждён" } as const;
const input = "h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";

type Params = { q?: string; source?: string; verification?: string; from?: string; to?: string; status?: string; page?: string };
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : undefined;
const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { user } = await requirePermission("contacts.view");
  const sp = await searchParams;
  const filters: ContactFilters = {
    q: sp.q?.slice(0, 80),
    source: pick(sp.source, ["qr", "birthday_form", "manual"] as const),
    verification: pick(sp.verification, ["unverified", "verified"] as const),
    from: date(sp.from),
    to: date(sp.to),
    leadStatus: pick(sp.status, ["new", "in_progress", "confirmed", "cancelled", "completed"] as const),
  };
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const { rows, total, pageSize } = await listContacts(getPool(), { id: user.id, role: user.role }, filters, page);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const qs = (n: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(n));
    return `/contacts?${p}`;
  };

  return (
    <div className="grid gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Клиенты</h1>
      <form method="get" className="grid gap-3 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-3">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Имя или телефон" maxLength={80} className={input} aria-label="Поиск" />
        <select name="source" defaultValue={filters.source ?? ""} className={input} aria-label="Источник">
          <option value="">Любой источник</option>
          {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select name="status" defaultValue={filters.leadStatus ?? ""} className={input} aria-label="Статус заявки">
          <option value="">Любой статус заявки</option>
          <option value="new">Новая</option><option value="in_progress">В работе</option><option value="confirmed">Подтверждена</option>
          <option value="cancelled">Отменена</option><option value="completed">Завершена</option>
        </select>
        <select name="verification" defaultValue={filters.verification ?? ""} className={input} aria-label="Подтверждение телефона">
          <option value="">Телефон: любой</option><option value="unverified">не подтверждён</option><option value="verified">подтверждён</option>
        </select>
        <label className="grid gap-1 text-xs font-bold text-muted">С даты регистрации<input type="date" name="from" defaultValue={filters.from ?? ""} className={input} /></label>
        <label className="grid gap-1 text-xs font-bold text-muted">По дату<input type="date" name="to" defaultValue={filters.to ?? ""} className={input} /></label>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <button type="submit" className={btn}>Найти</button>
          <Link href="/contacts" className="flex h-11 items-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700">Сбросить</Link>
        </div>
      </form>
      <p className="text-sm text-muted">Найдено: {total}. Регистрация по QR не означает визит.</p>
      <ul className="grid gap-3">
        {rows.map((c) => (
          <li key={c.id}>
            <Link href={`/contacts/${c.id}`} className="block rounded-3xl border border-line bg-white p-5 hover:border-grape-400">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-black text-grape-800">{c.name}</span>
                <span className="text-sm font-bold">{c.phone}</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {SOURCE[c.source as keyof typeof SOURCE]} · с {fmt.format(c.firstRegisteredAt)} · активность {fmt.format(c.lastActivityAt)} · телефон {VERIFY[c.phoneVerification as keyof typeof VERIFY]}
              </p>
              <p className="mt-1 text-xs text-muted">Заявок: {c.leadsCount} · QR-регистраций: {c.registrationsCount}{c.samePhoneOthers ? ` · тот же номер у ещё ${c.samePhoneOthers}` : ""}</p>
            </Link>
          </li>
        ))}
        {rows.length === 0 ? <li className="rounded-3xl border border-line bg-white p-5 text-sm text-muted">Никого не найдено.</li> : null}
      </ul>
      <nav className="flex items-center gap-3" aria-label="Страницы">
        {page > 1 ? <Link href={qs(page - 1)} className="font-extrabold text-grape-700">← Назад</Link> : null}
        {page * pageSize < total ? <Link href={qs(page + 1)} className="font-extrabold text-grape-700">Дальше →</Link> : null}
      </nav>
    </div>
  );
}
