import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { attendanceSeries, CORRECTION_REASONS, dayFigures, listEntries, listRegistrations, rangeEndingAt, MAX_CHILDREN, type CorrectionReason } from "@/core/attendance";
import { BUSINESS_TIME_ZONE } from "@/core/catalog";
import { almatyToday, isValidDate } from "@/core/dates";
import { attendanceSchemaReady } from "@/core/preflight";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { AttendanceChart } from "./chart";
import { confirmEntryAction, correctEntryAction, manualEntryAction } from "./actions";

export const metadata: Metadata = { title: "Посещаемость" };
export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  confirmed: "Вход подтверждён.",
  manual: "Вход без QR записан.",
  corrected: "Количество исправлено, исправление записано в журнал.",
  nochange: "Количество не изменилось.",
  duplicate: "Эта запись уже была сделана раньше: цифры не изменились.",
};
const ERRORS: Record<string, string> = {
  past: "Новый вход можно записать только за сегодня. Прошлые дни доступны для просмотра и исправления существующих записей.",
  invalid: `Проверьте количество (целое число, для нового входа от 1 до ${MAX_CHILDREN}) и причину исправления.`,
  changed: "Кто-то уже изменил эту запись. Данные обновлены: проверьте цифру и повторите исправление.",
  notfound: "Запись не найдена.",
  forbidden: "Недостаточно прав.",
};
const REASON_LABEL: Record<CorrectionReason, string> = {
  miscount: "Ошибся при подсчёте",
  late_arrivals: "Дети пришли позже",
  wrong_registration: "Не та регистрация",
  duplicate: "Дубль записи",
  other: "Другое",
};
const STATUS_LABEL = { waiting: "Ожидает входа", confirmed: "Вход подтверждён", cancelled: "Вход отменён" } as const;
const STATUS_STYLE = { waiting: "bg-sun-100 text-grape-900", confirmed: "bg-grape-100 text-grape-800", cancelled: "bg-paper text-muted line-through" } as const;

const input = "h-11 w-24 rounded-xl border-2 border-grape-200 bg-white px-3 text-center text-base font-bold text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const time = (iso: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE }).format(new Date(iso));
const longDate = (date: string) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const shortDate = (date: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

function Card({ label, value, hint, testId }: { label: string; value: number; hint: string; testId: string }) {
  return (
    <div className="rounded-3xl border border-line bg-white p-4" data-testid={testId}>
      <p className="text-sm font-bold text-muted">{label}</p>
      <p className="mt-1 text-4xl font-black tabular-nums text-grape-800">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ date?: string; days?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("attendance.manage");
  const sp = await searchParams;
  const today = almatyToday();
  const date = sp.date && isValidDate(sp.date) ? sp.date : today;
  const days = sp.days === "30" ? 30 : 14;
  const actor = { id: user.id, role: user.role };
  const pool = getPool();
  if (!(await attendanceSchemaReady(pool))) {
    return (
      <div className="grid gap-4">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Посещаемость</h1>
        <p role="alert" className="rounded-2xl bg-sun-100 p-4 text-sm font-bold text-grape-900" data-testid="schema-outdated">
          Раздел недоступен: схема базы данных устарела (нет миграции 013). Порядок запуска: миграции 001–013, затем <code>npm run db:roles</code>, затем <code>npm run preflight</code>.
        </p>
      </div>
    );
  }
  const isToday = date === today;
  const range = rangeEndingAt(date, days);
  const [figures, registrations, entries, series] = await Promise.all([
    dayFigures(pool, actor, date),
    listRegistrations(pool, actor, date),
    listEntries(pool, actor, date),
    attendanceSeries(pool, actor, range.from, range.to),
  ]);
  const manualKey = randomUUID();

  return (
    <div className="grid min-w-0 gap-6">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Посещаемость</h1>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}

      <nav aria-label="Дата" className="flex flex-wrap items-center gap-2">
        <Link href={`/attendance?date=${shift(date, -1)}`} className={btnGhost + " flex items-center"} aria-label="Предыдущий день">←</Link>
        <form method="get" className="flex items-center gap-2">
          <input type="date" name="date" defaultValue={date} className={input + " w-auto"} aria-label="Дата" />
          <button type="submit" className={btn}>Показать</button>
        </form>
        <Link href={`/attendance?date=${shift(date, 1)}`} className={btnGhost + " flex items-center"} aria-label="Следующий день">→</Link>
        <Link href="/attendance" className="text-sm font-extrabold text-grape-700 underline">Сегодня</Link>
      </nav>
      <p className="text-base font-bold text-grape-900 first-letter:uppercase">{longDate(date)} (Алматы)</p>

      <section aria-labelledby="day" className="grid gap-3">
        <h2 id="day" className="text-lg font-black text-grape-800">
          {date === today ? "Сегодня" : shortDate(date)}: вошло <span data-testid="headline-children">{figures.childrenEntered}</span> {plural(figures.childrenEntered, "ребёнок", "ребёнка", "детей")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card testId="card-entered" label="Детей фактически вошло" value={figures.childrenEntered} hint="Сумма подтверждённых входов за день" />
          <Card testId="card-adults" label="Взрослых прошло QR-регистрацию" value={figures.adultsRegistered} hint="Регистрация — не посещение" />
          <Card testId="card-expected" label="Детей ожидается" value={figures.childrenExpected} hint={`Регистраций без решения: ${figures.registrationsWaiting}. Отменённые входы (${figures.registrationsCancelled}) не ожидаются`} />
          <Card testId="card-entries" label="Записей о входе" value={figures.entries} hint="Подтверждения и вход без QR" />
        </div>
      </section>

      <section aria-labelledby="regs" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:p-5">
        <h2 id="regs" className="text-lg font-black text-grape-800">QR-регистрации за день</h2>
        {registrations.length === 0 ? <p className="text-sm text-muted">В этот день регистраций не было.</p> : null}
        <ul className="grid gap-3" data-testid="registrations">
          {registrations.map((r) => (
            <li key={r.id} className="grid gap-3 rounded-2xl border border-line p-3 sm:grid-cols-[1fr_auto] sm:items-center" data-registration={r.id}>
              <div className="min-w-0">
                <p className="truncate text-base font-black text-grape-900">{r.name}</p>
                <p className="mt-0.5 text-sm text-muted">
                  Заявлено детей: <b className="text-grape-900">{r.declaredChildren ?? "не указано"}</b> · зарегистрирован в {time(r.createdAt)}
                </p>
                <p className="mt-1.5">
                  <span className={`inline-block rounded-full px-3 py-1 text-xs font-extrabold ${STATUS_STYLE[r.status]}`} data-status={r.status}>{STATUS_LABEL[r.status]}</span>
                  {r.status === "confirmed" && r.enteredChildren !== null && r.enteredAt ? <span className="ml-2 text-sm text-muted">вошло {r.enteredChildren} в {time(r.enteredAt)}</span> : null}
                </p>
              </div>
              {r.status === "waiting" && !isToday ? (
                <p className="text-sm text-muted">Вход подтверждается только в день регистрации.</p>
              ) : r.status === "waiting" ? (
                <form action={confirmEntryAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="date" value={date} />
                  <input type="hidden" name="registrationId" value={r.id} />
                  <label className="grid gap-1 text-xs font-bold text-muted">
                    Вошло детей
                    <input name="childrenCount" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} required defaultValue={r.declaredChildren ?? 1} className={input} aria-label={`Сколько детей вошло: ${r.name}`} />
                  </label>
                  <button type="submit" className={btn}>Подтвердить вход</button>
                </form>
              ) : (
                <p className="text-sm text-muted">{r.status === "cancelled" ? "Исправьте запись ниже, если вход всё же был." : "Исправление — в списке записей ниже."}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="manual" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:p-5">
        <h2 id="manual" className="text-lg font-black text-grape-800">Вход без QR</h2>
        <p className="text-sm text-muted">Для посетителей, которые не проходили регистрацию. Записывается только количество детей.</p>
        {!isToday ? <p className="text-sm font-bold text-grape-900" data-testid="manual-closed">Новый вход записывается только за сегодня. Этот день открыт для просмотра и исправления записей.</p> : null}
        {isToday ? <form action={manualEntryAction} className="flex flex-wrap items-end gap-2" data-testid="manual-form">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="idempotencyKey" value={manualKey} />
          <label className="grid gap-1 text-xs font-bold text-muted">
            Вошло детей
            <input name="childrenCount" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} required defaultValue="1" className={input} />
          </label>
          <button type="submit" className={btn}>Записать вход</button>
        </form> : null}
      </section>

      <section aria-labelledby="entries" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:p-5">
        <h2 id="entries" className="text-lg font-black text-grape-800">Записи о входе за день</h2>
        {entries.length === 0 ? <p className="text-sm text-muted">Подтверждённых входов пока нет.</p> : null}
        <ul className="grid gap-3" data-testid="entries">
          {entries.map((e) => (
            <li key={e.id} className="grid gap-2 rounded-2xl border border-line p-3" data-entry={e.id}>
              <p className="text-sm">
                <b className="text-lg text-grape-900">{e.childrenCount}</b> {plural(e.childrenCount, "ребёнок", "ребёнка", "детей")} · {time(e.enteredAt)} ·{" "}
                {e.method === "qr" ? `QR (${e.adultName})` : "вручную, без QR"} · подтвердил(а): {e.confirmedBy}
              </p>
              {e.corrections.length ? (
                <ul className="grid gap-0.5 text-xs text-muted" aria-label="Журнал исправлений">
                  {e.corrections.map((k, i) => (
                    <li key={i}>
                      {time(k.at)}: {k.oldCount} → {k.newCount} ({REASON_LABEL[k.reason]}), {k.by}
                    </li>
                  ))}
                </ul>
              ) : null}
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700 underline">Исправить количество</summary>
                <form action={correctEntryAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="date" value={date} />
                  <input type="hidden" name="entryId" value={e.id} />
                  <input type="hidden" name="expectedCount" value={e.childrenCount} />
                  <label className="grid gap-1 text-xs font-bold text-muted">
                    Стало детей (0 — отменить вход)
                    <input name="newCount" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} required defaultValue={e.childrenCount} className={input} />
                  </label>
                  <label className="grid gap-1 text-xs font-bold text-muted">
                    Причина
                    <select name="reason" required defaultValue="miscount" className={input + " w-auto min-w-44 px-2 text-left"}>
                      {CORRECTION_REASONS.map((c) => <option key={c} value={c}>{REASON_LABEL[c]}</option>)}
                    </select>
                  </label>
                  <button type="submit" className={btnGhost}>Сохранить исправление</button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="chart" className="grid gap-3 rounded-3xl border border-line bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="chart" className="text-lg font-black text-grape-800">Посещаемость по дням</h2>
          <p className="flex gap-2 text-sm font-extrabold">
            <Link href={`/attendance?date=${date}&days=14`} aria-current={days === 14 ? "true" : undefined} className={days === 14 ? "text-grape-800 underline" : "text-grape-600"}>14 дней</Link>
            <Link href={`/attendance?date=${date}&days=30`} aria-current={days === 30 ? "true" : undefined} className={days === 30 ? "text-grape-800 underline" : "text-grape-600"}>30 дней</Link>
          </p>
        </div>
        <div className="text-grape-900"><AttendanceChart series={series} selected={date} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-sm" data-testid="series">
            <caption className="sr-only">Посещаемость по дням</caption>
            <thead className="text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">Дата</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Детей вошло</th>
                <th className="py-1.5 pr-3 text-right font-semibold">Записей</th>
                <th className="py-1.5 pr-3 text-right font-semibold">по QR</th>
                <th className="py-1.5 pr-3 text-right font-semibold">без QR</th>
                <th className="py-1.5 text-right font-semibold">Взрослых по QR</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((d) => (
                <tr key={d.date} className={`border-t border-line ${d.date === date ? "bg-grape-50 font-bold" : ""}`}>
                  <td className="py-2 pr-3"><Link href={`/attendance?date=${d.date}&days=${days}`} className="underline">{shortDate(d.date)}</Link></td>
                  <td className="py-2 pr-3 text-right tabular-nums">{d.childrenEntered}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{d.entries}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{d.qrChildren}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{d.manualChildren}</td>
                  <td className="py-2 text-right tabular-nums">{d.adultsRegistered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">День считается по времени Алматы (UTC+5). Регистрация без подтверждения входа в «Детей вошло» не попадает.</p>
      </section>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
