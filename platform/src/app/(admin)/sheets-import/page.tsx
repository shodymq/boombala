import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/dal";
import { runBookingSheetsBlockImport } from "./actions";
import { runSheetsSyncNow } from "./actions";
import { getLatestSheetSyncStatus } from "@/server/sheets-live-sync";

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
  const sync = await getLatestSheetSyncStatus();
  const syncMessage = single(query.sync) === "1";

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

      {syncMessage ? <p role="status" className="rounded-xl border border-line bg-white p-3 text-sm">Проверка источника завершена. Подробные данные и контакты не включаются в журналы.</p> : null}

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-6" aria-labelledby="sheets-sync-title">
        <h2 id="sheets-sync-title" className="font-black text-grape-800">Односторонняя синхронизация Google Sheets</h2>
        <p className="mt-2 text-sm leading-6">Источник: «Банкеты» → «Лист1». Сервис читает таблицу через Google Sheets API и пишет только блокировки через штатный booking writer. Предоплаты из таблицы не становятся финансовыми фактами. Удаление строки только создаёт отметку для ручной сверки.</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-muted">Последний запуск</dt><dd className="font-bold">{sync.lastUpdated ? new Date(sync.lastUpdated).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "нет"}</dd></div>
          <div><dt className="text-muted">Результат</dt><dd className="font-bold">{sync.outcome ?? "нет данных"}{sync.safeErrorCode ? ` · ${sync.safeErrorCode}` : ""}</dd></div>
          <div><dt className="text-muted">Режим</dt><dd className="font-bold">{sync.enabled ? "запись включена" : "выключено / dry-run"}</dd></div>
          <div><dt className="text-muted">Конфликты</dt><dd className="font-bold">{sync.counts?.conflicts ?? 0}</dd></div>
          <div><dt className="text-muted">Ошибки</dt><dd className="font-bold">{sync.counts?.errors ?? 0}</dd></div>
          <div><dt className="text-muted">Новые записи</dt><dd className="font-bold">{sync.counts?.created ?? 0}</dd></div>
          <div><dt className="text-muted">Изменения</dt><dd className="font-bold">{sync.counts?.updated ?? 0}</dd></div>
          <div><dt className="text-muted">Ручная сверка</dt><dd className="font-bold">{sync.manualReview}</dd></div>
          <div><dt className="text-muted">Строки отсутствуют в источнике</dt><dd className="font-bold">{sync.sourceMissing}</dd></div>
        </dl>
        {sync.reviewItems.length ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-line">
            <div className="border-b border-line bg-paper px-3 py-2 text-xs text-muted">Сводка последнего запуска без имён и телефонов. Номер строки — только указатель для сверки, он меняется при сортировке.</div>
            <div className="max-h-80 overflow-auto">
              <table className="w-full min-w-[42rem] text-left text-xs">
                <thead className="sticky top-0 bg-white text-muted"><tr><th className="p-2">Строка</th><th className="p-2">Результат</th><th className="p-2">Код</th><th className="p-2">ID CRM</th><th className="p-2">Ключ</th></tr></thead>
                <tbody>{sync.reviewItems.map((item, index) => (
                  <tr key={`${item.sourceKey ?? "none"}-${item.rowNumber}-${index}`} className="border-t border-line">
                    <td className="p-2">{item.rowNumber || "—"}</td><td className="p-2">{item.status}</td><td className="p-2">{item.safeCode ?? "—"}</td><td className="p-2 font-mono">{item.reservationId ?? "—"}</td><td className="p-2 font-mono">{item.sourceKey ?? "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        ) : null}
        <form action={runSheetsSyncNow} className="mt-4">
          <button type="submit" className="min-h-11 rounded-full bg-grape-700 px-5 font-extrabold text-white hover:bg-grape-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-800">Синхронизировать сейчас</button>
          <p className="mt-2 text-xs text-muted">Пока SHEETS_SYNC_ENABLED не включён, кнопка выполняет dry-run без изменений календаря.</p>
        </form>
      </section>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-6">
        <p className="text-sm leading-6">
          Вставьте скопированный из актуальной Google Sheets прямоугольный диапазон A1:N300. Импортёр принимает только таблицу «Банкеты», лист «Лист1» с заголовками на строке 2 и проверяет ID/колонки на сервере.
          Система пропускает прошедшие события, неизвестные комнаты, выход за часы работы, дубли и занятые интервалы.
        </p>
        <p className="mt-3 text-sm leading-6">
          Записываются только блокировки комнаты через существующую CRM-операцию. Заявки, брони, подтверждения и финансовые факты не создаются.
          Исходные ячейки строки сохраняются в заметке блока; указанная в таблице предоплата помечается как неподтверждённая.
        </p>
        <form action={runBookingSheetsBlockImport} className="mt-5 grid gap-3">
          <label htmlFor="plan" className="font-bold text-grape-800">Данные из Google Sheets (табличный диапазон A1:N300)</label>
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
          <p id="plan-help" className="text-xs text-muted">В Firefox выделите диапазон A1:N300 на листе «Лист1», скопируйте и вставьте сюда. Также поддерживается JSON-план. До 100 000 символов; данные не попадают в URL или журналы приложения.</p>
          <button type="submit" className="h-12 rounded-full bg-grape-700 px-5 font-extrabold text-white hover:bg-grape-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-800">
            Проверить конфликты и записать блокировки
          </button>
        </form>
      </section>

      <Link href="/bookings" className="w-fit font-bold text-grape-700 underline">Вернуться в календарь</Link>
    </div>
  );
}
