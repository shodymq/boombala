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
  const on = r.settings.autoEnabled && r.settings.legalConfirmedAt;

  return (
    <div className="grid gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Хранение данных QR-регистраций</h1>
      <section className="rounded-3xl border border-line bg-white p-5 text-sm">
        <p><b>Срок:</b> {r.settings.qrMonths} мес. с последней регистрации (согласован владельцем; правовая достаточность проверяется юристом)</p>
        <p><b>Автоматическая обработка:</b> {on ? "включена" : "выключена"}</p>
        <p><b>Юридическое подтверждение срока:</b> {r.settings.legalConfirmedAt ? fmt.format(r.settings.legalConfirmedAt) : "не записано"}</p>
        <p className="mt-2 text-xs text-muted">Это отчёт без изменений данных («dry-run»). Реальная обработка не запускается по расписанию и недоступна, пока не записано юридическое подтверждение.</p>
      </section>
      <section className="rounded-3xl border border-line bg-white p-5 text-sm">
        <h2 className="text-lg font-black text-grape-800">Итоги на {fmt.format(r.asOf)}</h2>
        <ul className="mt-2 grid gap-1">
          <li>Контактов с QR-регистрацией: <b>{r.totals.qrContacts}</b></li>
          <li>Срок ещё не истёк: <b>{r.totals.notExpired}</b></li>
          <li>Срок истёк, можно обезличить: <b>{r.totals.eligible}</b></li>
          <li>Срок истёк, но трогать нельзя (есть заявка или бронь): <b>{r.totals.blocked}</b></li>
          <li>Уже обезличены: <b>{r.totals.alreadyAnonymized}</b></li>
          <li>Вне правила QR (только заявка или бронь): <b>{r.totals.outsideQrRule}</b></li>
        </ul>
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
