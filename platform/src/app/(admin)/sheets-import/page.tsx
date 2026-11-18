import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/dal";
import { runBookingSheetsBlockImport } from "./actions";

export const metadata: Metadata = { title: "Импорт праздников из таблицы" };

type Search = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function count(value: string | string[] | undefined): number {
  const parsed = Number(single(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export default async function SheetsImportPage({ searchParams }: { searchParams: Search }) {
  const session = await requirePermission("bookings.manage");
  if (session.user.role !== "owner") redirect("/bookings?error=forbidden");
  const query = await searchParams;
  const hasRun = single(query.run) === "1";
  const error = single(query.error);

  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <h1 className="text-3xl font-black tracking-tight text-grape-800">Импорт мероприятий</h1>
        <p className="text-sm text-muted">Пакетное создание блокировок комнат из утверждённой таблицы «Банкеты».</p>
      </header>

      {hasRun ? (
        <section aria-live="polite" className="rounded-2xl border border-line bg-white p-4" data-testid="sheets-import-result">
          <h2 className="font-black text-grape-800">Результат записи и сверки календаря</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-muted">Создано</dt><dd className="font-bold">{count(query.created)}</dd></div>
            <div><dt className="text-muted">Уже было</dt><dd className="font-bold">{count(query.alreadyPresent)}</dd></div>
            <div><dt className="text-muted">Конфликты</dt><dd className="font-bold">{count(query.conflicts)}</dd></div>
            <div><dt className="text-muted">Проверено чтением</dt><dd className="font-bold">{count(query.verified)}</dd></div>
            <div><dt className="text-muted">Пропущено</dt><dd className="font-bold">{count(query.skipped)}</dd></div>
            <div><dt className="text-muted">Ошибки проверки</dt><dd className="font-bold">{count(query.failed)}</dd></div>
            <div><dt className="text-muted">Будущие кандидаты</dt><dd className="font-bold">{count(query.futureRows)}</dd></div>
            <div><dt className="text-muted">Исторические строки</dt><dd className="font-bold">{count(query.historical)}</dd></div>
          </dl>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-800">
          Импорт остановлен: {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-6">
        <p className="text-sm leading-6">
          Принимается JSON-план, сформированный из свежих значений Google Sheets: ID таблицы, ID листа, заголовки и строки A:N.
          Система пропускает прошедшие события, неизвестные комнаты, выход за часы работы, дубли и занятые интервалы.
        </p>
        <p className="mt-3 text-sm leading-6">
          Записываются только блокировки комнаты через существующую CRM-операцию. Заявки, брони, подтверждения и финансовые факты не создаются.
          Исходные ячейки строки сохраняются в заметке блока; указанная в таблице предоплата помечается как неподтверждённая.
        </p>
        <form action={runBookingSheetsBlockImport} className="mt-5 grid gap-3">
          <label htmlFor="plan" className="font-bold text-grape-800">План импорта JSON</label>
          <textarea
            id="plan"
            name="plan"
            required
            maxLength={100_000}
            spellCheck={false}
            autoComplete="off"
            rows={18}
            className="w-full rounded-xl border border-line bg-paper p-3 font-mono text-xs leading-5"
            aria-describedby="plan-help"
          />
          <p id="plan-help" className="text-xs text-muted">Максимальный размер — 100 000 символов. Данные остаются в защищённой сессии CRM и не попадают в URL или журналы приложения.</p>
          <button type="submit" className="h-12 rounded-full bg-grape-700 px-5 font-extrabold text-white hover:bg-grape-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-800">
            Проверить конфликты и записать блокировки
          </button>
        </form>
      </section>

      <Link href="/bookings" className="w-fit font-bold text-grape-700 underline">Вернуться в календарь</Link>
    </div>
  );
}
