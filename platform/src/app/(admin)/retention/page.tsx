import type { Metadata } from "next";
import Link from "next/link";
import { retentionReport, type Blocker } from "@/core/privacy";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";

export const metadata: Metadata = { title: "Хранение данных" };
export const dynamic = "force-dynamic";

const BLOCKER: Record<Blocker, string> = {
  active_booking: "активная бронь",
  open_enquiry: "незакрытая заявка",
  booking_record: "запись о бронировании",
  enquiry_record: "заявка",
};

/** Read-only dry-run report. Nothing is changed here, and nothing runs on a schedule. */
export default async function RetentionPage() {
  const { user } = await requirePermission("privacy.manage");
  const r = await retentionReport(getPool(), { id: user.id, role: user.role });
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeZone: "Asia/Almaty" });

  return (
    <div className="crm-page">
      <header>
        <p className="crm-eyebrow">Приватность</p>
        <h1 className="crm-page-title">Хранение данных QR-регистраций</h1>
        <p className="crm-page-subtitle">Проверка только читает записи и ничего не меняет.</p>
      </header>
      <section className="crm-panel" aria-label="Текущие правила хранения">
        <h2 className="text-lg font-black text-grape-800">Текущие правила</h2>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <p><b>Срок:</b> {r.settings.qrMonths} мес. с последней регистрации</p>
          <p><b>Автоматизация разрешена:</b> {r.settings.autoEnabled ? "да" : "нет"}</p>
          <p><b>Юридическое подтверждение:</b> {r.settings.legalConfirmedAt ? fmt.format(r.settings.legalConfirmedAt) : "не записано"}</p>
          <p><b>Проверено:</b> {fmt.format(r.asOf)}</p>
        </div>
        <p className="mt-3 text-xs text-muted">Срок должен проверить юрист. Автоматический запуск по расписанию не подключён; на этой странице доступен только сухой расчёт.</p>
      </section>
      <section className="crm-retention-steps" aria-label="Этапы сухой проверки">
        <article>
          <h2>1. Кого проверяем</h2>
          <p>{r.totals.qrContacts} контактов с QR-регистрацией. Заявки без QR в это правило не входят: {r.totals.outsideQrRule}.</p>
        </article>
        <article>
          <h2>2. Что может остановить</h2>
          <p>{r.totals.blocked} записей имеют бронь или незакрытую заявку. Такие контакты остаются без изменений.</p>
        </article>
        <article>
          <h2>3. Результат dry-run</h2>
          <p>Срок истёк: {r.totals.eligible} можно рассмотреть для обезличивания; срок не истёк: {r.totals.notExpired}. Уже обезличены: {r.totals.alreadyAnonymized}.</p>
        </article>
      </section>
      {r.blocked.length ? (
        <section className="rounded-3xl border border-line bg-white p-5 text-sm">
          <h2 className="text-lg font-black text-grape-800">Нельзя трогать</h2>
          <ul className="mt-2 grid gap-1">
            {r.blocked.map((b) => (
              <li key={b.contactId}><Link href={`/contacts/${b.contactId}`} className="underline">{b.contactId.slice(0, 8)}</Link> · последняя регистрация {fmt.format(b.lastRegistrationAt)} · {b.blockers.map((x) => BLOCKER[x]).join(", ")}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.eligible.length ? (
        <section className="rounded-3xl border border-line bg-white p-5 text-sm">
          <h2 className="text-lg font-black text-grape-800">Подлежат обработке</h2>
          <ul className="mt-2 grid gap-1">
            {r.eligible.map((e) => <li key={e.contactId}><Link href={`/contacts/${e.contactId}`} className="underline">{e.contactId.slice(0, 8)}</Link> · последняя регистрация {fmt.format(e.lastRegistrationAt)}</li>)}
          </ul>
        </section>
      ) : null}
      {r.truncated ? <p className="text-xs text-muted">Списки показаны не полностью (первые 500).</p> : null}
    </div>
  );
}
