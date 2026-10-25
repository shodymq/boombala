import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { attendanceSeries, CORRECTION_REASONS, dayFigures, listEntries, searchRegistrations, rangeEndingAt, MAX_CHILDREN, REGISTRATION_FILTERS, SEARCH_MAX, SEARCH_PAGE, type CorrectionReason, type RegistrationFilter } from "@/core/attendance";
import { BUSINESS_TIME_ZONE } from "@/core/catalog";
import { almatyToday, isValidDate } from "@/core/dates";
import { attendanceSchemaReady } from "@/core/preflight";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { AttendanceChart } from "./chart";
import { confirmEntryAction, correctEntryAction, manualEntryAction, searchAction } from "./actions";

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
const FILTER_LABEL: Record<RegistrationFilter, string> = { waiting: "Ожидают входа", confirmed: "Подтверждены", all: "Все" };
/** The cashier's saved search (a cookie of this section, not the address: names must not reach access logs). */
function savedSearch(raw: string | undefined): { q: string; f: RegistrationFilter; n: number } {
  try {
    const v = JSON.parse(decodeURIComponent(raw ?? "")) as { q?: unknown; f?: unknown; n?: unknown };
    const f = REGISTRATION_FILTERS.includes(v.f as RegistrationFilter) ? (v.f as RegistrationFilter) : "waiting";
    const n = Number(v.n);
    return { q: typeof v.q === "string" ? v.q.slice(0, 60) : "", f, n: Number.isFinite(n) ? Math.min(SEARCH_MAX, Math.max(SEARCH_PAGE, Math.trunc(n))) : SEARCH_PAGE };
  } catch {
    return { q: "", f: "waiting", n: SEARCH_PAGE };
  }
}
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
    <div className="rounded-2xl border border-line bg-white p-3" data-testid={testId}>
      <p className="text-xs font-bold text-muted sm:text-sm">{label}</p>
      <p className="mt-0.5 text-3xl font-black tabular-nums text-grape-800">{value}</p>
      <p className="mt-1 hidden text-xs text-muted lg:block">{hint}</p>
    </div>
  );
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ date?: string; days?: string; notice?: string; error?: string; reg?: string; cnt?: string }> }) {
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
  const saved = savedSearch((await cookies()).get("bb_att")?.value);
  const [figures, found, entries, series] = await Promise.all([
    dayFigures(pool, actor, date),
    searchRegistrations(pool, actor, date, { q: saved.q, filter: saved.f, limit: saved.n }),
    listEntries(pool, actor, date),
    attendanceSeries(pool, actor, range.from, range.to),
  ]);
  const manualKey = randomUUID();
  const registrations = found.rows;
  const regNo = /^\d{1,9}$/.test(sp.reg ?? "") ? sp.reg : "";
  const cntNo = /^\d{1,3}$/.test(sp.cnt ?? "") ? Number(sp.cnt) : null;
  const notice =
    sp.notice === "confirmed" && regNo && cntNo !== null
      ? `Вход подтверждён: № ${regNo}, вошло ${cntNo} ${plural(cntNo, "ребёнок", "ребёнка", "детей")}.`
      : sp.notice === "duplicate" && regNo
        ? `Вход уже записан: № ${regNo}${cntNo !== null ? `, вошло ${cntNo} ${plural(cntNo, "ребёнок", "ребёнка", "детей")}` : ""}. Повторно не добавлено.`
        : sp.notice && NOTICES[sp.notice]
          ? NOTICES[sp.notice]
          : "";

  return (
    <div className="grid min-w-0 gap-6">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Посещаемость</h1>
      {notice ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-base font-extrabold text-grape-900" data-testid="notice">{notice}</p> : null}
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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Card testId="card-entered" label="Детей фактически вошло" value={figures.childrenEntered} hint="Сумма подтверждённых входов за день" />
          <Card testId="card-adults" label="Взрослых прошло QR-регистрацию" value={figures.adultsRegistered} hint="Регистрация — не посещение" />
          <Card testId="card-expected" label="Детей ожидается" value={figures.childrenExpected} hint={`Регистраций без решения: ${figures.registrationsWaiting}. Отменённые входы (${figures.registrationsCancelled}) не ожидаются`} />
          <Card testId="card-entries" label="Записей о входе" value={figures.entries} hint="Подтверждения и вход без QR" />
        </div>
      </section>

      <section aria-labelledby="regs" className="grid gap-3 rounded-3xl border border-line bg-white p-3 sm:p-5">
        <h2 id="regs" className="text-lg font-black text-grape-800">QR-регистрации за день</h2>
        <form action={searchAction} role="search" className="grid gap-2" data-testid="reg-search">
          <input type="hidden" name="date" value={date} />
          <div className="flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={saved.q}
              maxLength={60}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Имя или № регистрации"
              aria-label="Поиск по имени взрослого или номеру регистрации"
              className="h-12 min-w-0 flex-1 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base font-bold text-ink focus:border-grape-600 focus:outline-none"
            />
            <button type="submit" name="f" value={saved.f} className="h-12 shrink-0 rounded-full bg-grape-700 px-6 text-base font-extrabold text-white hover:bg-grape-600">Найти</button>
          </div>
          <div role="group" aria-label="Фильтр по статусу" className="flex flex-wrap gap-2" data-testid="reg-filters">
            {REGISTRATION_FILTERS.map((f) => (
              <button
                key={f}
                type="submit"
                name="f"
                value={f}
                aria-pressed={saved.f === f}
                className={`h-11 rounded-full border-2 px-4 text-sm font-extrabold ${saved.f === f ? "border-grape-700 bg-grape-700 text-white" : "border-grape-200 text-grape-800 hover:bg-grape-50"}`}
              >
                {FILTER_LABEL[f]} <span className="tabular-nums opacity-80">{f === "waiting" ? found.counts.waiting : f === "confirmed" ? found.counts.confirmed : found.counts.all}</span>
              </button>
            ))}
            {saved.q || saved.f !== "waiting" || saved.n > SEARCH_PAGE ? (
              <button type="submit" name="clear" value="1" className="h-11 px-3 text-sm font-extrabold text-grape-700 underline">Сбросить</button>
            ) : null}
          </div>
        </form>
        {registrations.length === 0 ? (
          <p className="rounded-2xl bg-paper p-4 text-base text-grape-900" data-testid="reg-empty">
            {saved.q
              ? `Ничего не найдено по «${saved.q}»${saved.f === "all" ? "" : ` среди «${FILTER_LABEL[saved.f]}»`}. Проверьте написание или номер, или нажмите «Все».`
              : found.counts.all === 0
                ? "В этот день регистраций не было."
                : saved.f === "waiting"
                  ? "Все регистрации за день подтверждены."
                  : "Подтверждённых регистраций пока нет."}
          </p>
        ) : null}
        <ul className="grid gap-2" data-testid="registrations">
          {registrations.map((r) => (
            <li key={r.id} className="grid gap-3 rounded-2xl border border-line p-3 sm:p-4" data-registration={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 flex-1 text-xl font-black leading-tight text-grape-900 [overflow-wrap:anywhere]">{r.name}</p>
                <span className={`inline-block shrink-0 rounded-full px-3 py-1 text-xs font-extrabold ${STATUS_STYLE[r.status]}`} data-status={r.status}>{STATUS_LABEL[r.status]}</span>
              </div>
              <p className="text-sm text-muted">
                <b className="text-grape-900">№ {r.seq}</b> · зарегистрирован в {time(r.createdAt)} · Заявлено детей: <b className="text-grape-900">{r.declaredChildren ?? "не указано"}</b>
                {r.status === "confirmed" && r.enteredChildren !== null && r.enteredAt ? <span className="block font-bold text-grape-800">вошло {r.enteredChildren} в {time(r.enteredAt)}</span> : null}
              </p>
              {r.status === "waiting" && !isToday ? (
                <p className="text-sm text-muted">Вход подтверждается только в день регистрации.</p>
              ) : r.status === "waiting" ? (
                <form action={confirmEntryAction} className="flex items-end gap-3">
                  <input type="hidden" name="date" value={date} />
                  <input type="hidden" name="registrationId" value={r.id} />
                  <label className="grid gap-1 text-xs font-bold text-muted">
                    Вошло детей
                    <input name="childrenCount" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} required defaultValue={r.declaredChildren ?? 1} className="h-14 w-24 rounded-2xl border-2 border-grape-200 bg-white px-3 text-center text-2xl font-black text-ink focus:border-grape-600 focus:outline-none" aria-label={`Сколько детей вошло: ${r.name}`} />
                  </label>
                  <button type="submit" className="h-14 min-w-0 flex-1 rounded-full bg-grape-700 px-5 text-base font-extrabold text-white hover:bg-grape-600">Подтвердить вход</button>
                </form>
              ) : (
                <p className="text-sm text-muted">{r.status === "cancelled" ? "Исправьте запись ниже, если вход всё же был." : "Исправление — в списке записей ниже."}</p>
              )}
            </li>
          ))}
        </ul>
        {found.matched > registrations.length ? (
          <form action={searchAction} className="flex flex-wrap items-center gap-3" data-testid="reg-more">
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="q" value={saved.q} />
            <input type="hidden" name="f" value={saved.f} />
            <p className="text-sm text-muted">Показано {registrations.length} из {found.matched}. Уточните поиск или покажите больше.</p>
            <button type="submit" name="n" value={Math.min(SEARCH_MAX, saved.n + SEARCH_PAGE)} className={btnGhost}>Показать ещё</button>
          </form>
        ) : null}
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
