import type { Metadata } from "next";
import { LEGAL_KINDS, listDocuments } from "@/core/legal";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { approveAction, createDraftAction, publishAction, retireAction, updateDraftAction } from "./actions";

export const metadata: Metadata = { title: "Документы" };

const KIND: Record<string, string> = {
  privacy_policy: "Политика обработки данных", visit_rules: "Правила посещения", companion_duties: "Обязанности сопровождающего",
  personal_data_consent: "Согласие на обработку данных", third_party_escort: "Сопровождение третьим лицом", group_visits: "Групповые посещения",
};
const STATUS: Record<string, string> = { draft: "черновик", approved: "утверждён", published: "опубликован", retired: "снят с публикации" };
const NOTICES: Record<string, string> = { created: "Черновик создан.", saved: "Черновик сохранён.", approved: "Документ утверждён.", published: "Документ опубликован.", retired: "Документ снят с публикации." };
const ERRORS: Record<string, string> = {
  placeholders: "В тексте остались пометки [ТРЕБУЕТСЯ …]: заполните их перед утверждением.",
  conflict: "Это действие сейчас недоступно для документа.", forbidden: "Недостаточно прав.", invalid: "Проверьте введённые данные.",
};
const input = "rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

export default async function LegalPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("legal.manage");
  const { notice, error } = await searchParams;
  const docs = await listDocuments(getPool(), { id: user.id, role: user.role });
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });

  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Юридические документы</h1>
      <p className="text-sm text-muted">Тексты утверждаются отдельно от программы (владелец и юрист). Документ с пометками «[ТРЕБУЕТСЯ …]» утвердить и опубликовать нельзя. Отметка на сайте не является электронной цифровой подписью.</p>
      {notice && NOTICES[notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[notice]}</p> : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[error] ?? "Не удалось выполнить действие."}</p> : null}

      <section className="rounded-3xl border border-line bg-white p-5">
        <h2 className="text-lg font-black text-grape-800">Новый черновик (следующая версия)</h2>
        <form action={createDraftAction} className="mt-3 grid gap-3">
          <select name="kind" className={`${input} h-11`} aria-label="Тип документа">{LEGAL_KINDS.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select>
          <input name="title" placeholder="Название" required maxLength={200} className={`${input} h-11`} aria-label="Название" />
          <textarea name="body" placeholder="Текст документа" required rows={8} maxLength={100000} className={`${input} py-2`} aria-label="Текст" />
          <button type="submit" className={`${btn} w-fit`}>Создать черновик</button>
        </form>
      </section>

      <section className="grid gap-3" aria-label="Документы">
        {docs.map((d) => (
          <article key={d.id} className="rounded-3xl border border-line bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-black text-grape-800">{KIND[d.kind]} · редакция {d.version}</h3>
              <span className="text-xs font-bold text-muted">{STATUS[d.status]}</span>
            </div>
            <p className="text-xs text-muted">Создан {fmt.format(d.createdAt)}{d.approvedAt ? ` · утверждён ${fmt.format(d.approvedAt)}` : ""}{d.publishedAt ? ` · опубликован ${fmt.format(d.publishedAt)}` : ""}</p>
            {d.status === "draft" ? (
              <form action={updateDraftAction} className="mt-3 grid gap-2">
                <input type="hidden" name="id" value={d.id} />
                <input name="title" defaultValue={d.title} required maxLength={200} className={`${input} h-11`} aria-label="Название" />
                <textarea name="body" defaultValue={d.body} required rows={8} maxLength={100000} className={`${input} py-2`} aria-label="Текст" />
                <div className="flex flex-wrap gap-2"><button type="submit" className={btnGhost}>Сохранить</button></div>
              </form>
            ) : (
              <details className="mt-2"><summary className="cursor-pointer text-sm font-extrabold text-grape-700">Показать текст</summary><pre className="mt-2 whitespace-pre-wrap text-sm">{d.body}</pre></details>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {d.status === "draft" ? <form action={approveAction}><input type="hidden" name="id" value={d.id} /><button type="submit" className={btn}>Утвердить</button></form> : null}
              {d.status === "approved" ? <form action={publishAction}><input type="hidden" name="id" value={d.id} /><button type="submit" className={btn}>Опубликовать</button></form> : null}
              {d.status === "published" ? <form action={retireAction}><input type="hidden" name="id" value={d.id} /><button type="submit" className={btnGhost}>Снять с публикации</button></form> : null}
            </div>
          </article>
        ))}
        {docs.length === 0 ? <p className="rounded-3xl border border-line bg-white p-5 text-sm text-muted">Документов пока нет. Пока не опубликовано согласие на обработку данных, форма не принимает заявки.</p> : null}
      </section>
    </div>
  );
}
