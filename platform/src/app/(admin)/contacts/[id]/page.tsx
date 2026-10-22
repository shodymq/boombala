import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContact } from "@/core/crm";
import { assessContact, type Blocker } from "@/core/privacy";
import { can } from "@/core/rbac";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { anonymizeContactAction, revokeConsentAction } from "./actions";

export const metadata: Metadata = { title: "Клиент" };

const KIND: Record<string, string> = {
  privacy_policy: "Политика обработки данных", visit_rules: "Правила посещения", companion_duties: "Обязанности сопровождающего",
  personal_data_consent: "Согласие на обработку данных", third_party_escort: "Сопровождение третьим лицом", group_visits: "Групповые посещения",
};
const BLOCKER: Record<Blocker, string> = {
  active_booking: "есть активная бронь",
  open_enquiry: "есть незакрытая заявка",
  booking_record: "есть запись о бронировании (срок хранения определяет юрист)",
  enquiry_record: "есть заявка (срок хранения определяет юрист)",
};
const NOTICES: Record<string, string> = { revoked: "Отзыв согласия записан в историю.", anonymized: "Контакт обезличен: имя и телефон удалены." };
const ERRORS: Record<string, string> = { blocked: "Действие недоступно: данные нужно сохранить.", forbidden: "Недостаточно прав.", failed: "Не удалось выполнить действие." };
const STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", confirmed: "Подтверждена", cancelled: "Отменена", completed: "Завершена" };

export default async function ContactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("contacts.view");
  const { id } = await params;
  const { notice, error } = await searchParams;
  const card = await getContact(getPool(), { id: user.id, role: user.role }, id);
  if (!card) notFound();
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const { contact: c } = card;
  const actor = { id: user.id, role: user.role };
  const privacy = can(user.role, "privacy.manage") ? await assessContact(getPool(), actor, id) : null;

  return (
    <div className="grid gap-5">
      <Link href="/contacts" className="text-sm font-extrabold text-grape-700">← Все клиенты</Link>
      <h1 className="text-3xl font-black tracking-tight text-grape-800">{c.name}</h1>
      {notice && NOTICES[notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[notice]}</p> : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[error] ?? ERRORS.failed}</p> : null}
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
            <li key={e.id}>{fmt.format(e.occurredAt)} · {e.event === "given" ? "дано" : "отозвано"} · {KIND[e.kind] ?? e.kind}, редакция {e.version} · {e.origin === "qr" ? "QR-регистрация" : e.origin === "enquiry" ? `заявка №${e.enquirySeq}` : "сотрудник"}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Отметка на сайте не является электронной цифровой подписью.</p>
      </section>
      {privacy ? (
        <section className="rounded-3xl border border-line bg-white p-5 text-sm" aria-labelledby="privacy-h">
          <h2 id="privacy-h" className="text-lg font-black text-grape-800">Согласие и хранение данных</h2>
          {privacy.anonymized ? (
            <p className="mt-2">Контакт обезличен: имя и телефон удалены, история согласий сохранена без косвенных идентификаторов.</p>
          ) : (
            <>
              <p className="mt-2">Согласие на обработку данных: <b>{privacy.consentActive ? "действует" : "отозвано или не давалось"}</b></p>
              {card.leads.length ? (
                <p className="mt-1 rounded-2xl bg-grape-50 p-3 text-grape-900">
                  У контакта есть заявки. Отзыв действует на <b>всё</b> согласие на обработку данных этого контакта: и данное при QR-регистрации, и данное при заявке. Данные по заявкам и броням при этом сохраняются, пока они нужны (см. причины ниже), а в истории появится запись об отзыве.
                </p>
              ) : null}
              {privacy.blockers.length ? (
                <div className="mt-2 rounded-2xl bg-sun-100 p-3 text-grape-900">
                  <p className="font-bold">Контакт нельзя обезличить сейчас:</p>
                  <ul className="list-disc pl-5">{privacy.blockers.map((b) => <li key={b}>{BLOCKER[b]}</li>)}</ul>
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {privacy.consentActive ? (
                  <form action={revokeConsentAction}>
                    <input type="hidden" name="id" value={id} />
                    <button type="submit" className="h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50">{card.leads.length ? "Отозвать согласие (QR и заявки)" : "Отозвать согласие"}</button>
                  </form>
                ) : null}
                {!privacy.consentActive && privacy.blockers.length === 0 ? (
                  <form action={anonymizeContactAction}>
                    <input type="hidden" name="id" value={id} />
                    <button type="submit" className="h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600">Обезличить контакт</button>
                  </form>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-muted">Обезличивание необратимо: имя и телефон удаляются, история согласий, заявки и брони остаются.</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
