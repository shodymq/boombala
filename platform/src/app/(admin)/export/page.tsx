import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EXPORT_COLUMNS, DEFAULT_EXPORT_COLUMNS } from "@/core/export";
import { canExport } from "@/core/rbac";
import { requireUser } from "@/server/dal";

export const metadata: Metadata = { title: "Выгрузка" };
const input = "h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";

export default async function ExportPage() {
  const { user } = await requireUser();
  if (!canExport(user)) redirect("/");
  return (
    <div className="grid gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Выгрузка клиентов</h1>
      <p className="text-sm text-muted">Файл содержит персональные данные. Каждая выгрузка записывается в журнал. Используйте только для служебных целей, не рассылайте и не храните на личных устройствах.</p>
      <form method="post" action="/api/export" className="grid gap-4 rounded-3xl border border-line bg-white p-5">
        <fieldset className="grid gap-2">
          <legend className="text-sm font-extrabold text-grape-800">Формат</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="format" value="csv" defaultChecked /> CSV (UTF-8)</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="format" value="xlsx" /> XLSX (Excel)</label>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-bold text-muted">С даты первой регистрации<input type="date" name="from" className={input} /></label>
          <label className="grid gap-1 text-xs font-bold text-muted">По дату<input type="date" name="to" className={input} /></label>
          <select name="source" className={input} aria-label="Источник"><option value="">Любой источник</option><option value="qr">QR-регистрация</option><option value="birthday_form">Заявка на праздник</option></select>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-extrabold text-grape-800">Столбцы</legend>
          {Object.entries(EXPORT_COLUMNS).map(([key, def]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="columns" value={key} defaultChecked={(DEFAULT_EXPORT_COLUMNS as string[]).includes(key)} /> {def.header}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="h-11 w-fit rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600">Скачать</button>
      </form>
    </div>
  );
}
