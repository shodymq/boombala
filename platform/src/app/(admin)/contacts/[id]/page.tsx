import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContact } from "@/core/crm";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";

export const metadata: Metadata = { title: "Клиент" };

const KIND: Record<string, string> = {
  privacy_policy: "Политика обработки данных", visit_rules: "Правила посещения", companion_duties: "Обязанности сопровождающего",
  personal_data_consent: "Согласие на обработку данных", third_party_escort: "Сопровождение третьим лицом", group_visits: "Групповые посещения",
};
const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePermission("contacts.view");
  const { id } = await params;
  const card = await getContact(getPool(), { id: user.id, role: user.role }, id);
  if (!card) notFound();
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const { contact: c } = card;

  return (
    <div className="grid gap-5">
      <Link href="/contacts" className="text-sm font-extrabold text-grape-700">← Все клиенты</Link>
      <h1 className="text-3xl font-black tracking-tight text-grape-800">{c.name}</h1>
      <section className="rounded-3xl border border-line bg-white p-5 text-sm">
        <p><b>Телефон:</b> {c.phone ? `${c.phone} (${c.phoneVerification === "verified" ? "подтверждён" : "не подтверждён"})` : "не указан"}</p>
        <p><b>Источник:</b> {c.source}</p>
        <p><b>Первая регистрация:</b> {fmt.format(c.firstRegisteredAt)}</p>
        <p><b>Последняя активность:</b> {fmt.format(c.lastActivityAt)}</p>
        {card.samePhone.length ? (
          <p className="mt-2 rounded-2xl bg-sun-100 p-3 font-bold text-grape-900">
            Этот номер указан у других контактов (не объединены, так как номер не подтверждён):{" "}
            {card.samePhone.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/contacts/${s.id}`} className="underline">{s.name}</Link></span>)}
          </p>
        ) : null}
      </section>
      <section className="rounded-3xl border border-line bg-white p-5">
        <h2 className="text-lg font-black text-grape-800">Заявки ({card.leads.length})</h2>
        <ul className="mt-2 grid gap-1 text-sm">
          {card.leads.map((l) => (
            <li key={l.id}>№{l.seq} · {fmt.format(l.createdAt)} · на {l.requestedDate} · {STATUS[l.status]}{l.packageId ? ` · ${l.packageId}` : ""}{l.children != null ? ` · детей: ${l.children}` : ""}</li>
          ))}
          {card.leads.length === 0 ? <li className="text-muted">Нет</li> : null}
        </ul>
      </section>
      <section className="rounded-3xl border border-line bg-white p-5">
        <h2 className="text-lg font-black text-grape-800">QR-регистрации ({card.registrations.length})</h2>
        <p className="text-xs text-muted">Регистрация не означает фактический визит.</p>
        <ul className="mt-2 grid gap-1 text-sm">{card.registrations.map((r) => <li key={r.id}>№{r.seq} · {fmt.format(r.createdAt)}</li>)}</ul>
      </section>
      <section className="rounded-3xl border border-line bg-white p-5">
        <h2 className="text-lg font-black text-grape-800">История согласий</h2>
        <ul className="mt-2 grid gap-1 text-sm">
          {card.consents.map((e) => (
            <li key={e.id}>{fmt.format(e.occurredAt)} · {e.event === "given" ? "дано" : "отозвано"} · {KIND[e.kind] ?? e.kind}, редакция {e.version} · {e.method === "web_checkbox" ? "отметка на сайте" : "сотрудник"}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Отметка на сайте не является электронной цифровой подписью.</p>
      </section>
    </div>
  );
}
