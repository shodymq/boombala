import type { ImageRow, PostRow } from "@/core/news";

export const input = "h-11 w-full rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
export const textarea = "w-full rounded-xl border-2 border-grape-200 bg-white px-3 py-2 text-base text-ink focus:border-grape-600 focus:outline-none";
export const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
export const btnGhost = "inline-flex h-11 items-center rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

/** Fields shared by "new" and "edit". The address is editable only until the first publication. */
export function PostFields({ post, images }: { post?: PostRow; images: ImageRow[] }) {
  const locked = !!post?.publishedAt;
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Тип
        <select name="kind" defaultValue={post?.kind ?? "news"} className={input}>
          <option value="news">Новость</option>
          <option value="promo">Акция</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Заголовок
        <input name="title" defaultValue={post?.title} required maxLength={160} className={input} />
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Адрес страницы (латиницей; если пусто, создаётся из заголовка)
        <input name="slug" defaultValue={post?.slug ?? ""} maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" readOnly={locked} aria-describedby="slug-hint" className={`${input} ${locked ? "bg-paper text-muted" : ""}`} />
        <span id="slug-hint" className="text-xs font-medium text-muted">{locked ? "Адрес опубликованной страницы изменить нельзя: ссылки на неё уже могли разойтись." : "После первой публикации адрес менять нельзя."}</span>
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Краткое описание (до 300 символов, видно в списке)
        <textarea name="excerpt" defaultValue={post?.excerpt} maxLength={300} rows={2} className={textarea} />
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Текст
        <textarea name="body" defaultValue={post?.body} maxLength={30000} rows={14} className={`${textarea} font-mono text-sm`} />
        <span className="text-xs font-medium text-muted">## Заголовок · ### Подзаголовок · пустая строка между абзацами · «- » список · **жирный** · [текст](https://…) · картинка отдельной строкой: ![](img:КОД) (код в разделе «Изображения»). HTML не поддерживается.</span>
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Обложка
        <select name="coverImageId" defaultValue={post?.coverImageId ?? ""} className={input}>
          <option value="">Без обложки</option>
          {images.map((i) => <option key={i.id} value={i.id}>{i.alt} ({i.width}×{i.height})</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-extrabold text-grape-800">Для акции: действует до (включительно)
        <input type="date" name="validUntil" defaultValue={post?.validUntil ?? ""} className={input} />
      </label>
      <details className="rounded-2xl border border-line p-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-extrabold text-grape-700">Для поисковых систем (по желанию)</summary>
        <div className="mt-2 grid gap-3">
          <label className="grid gap-1 text-sm font-extrabold text-grape-800">SEO-заголовок (до 70 символов)
            <input name="seoTitle" defaultValue={post?.seoTitle ?? ""} maxLength={70} className={input} />
          </label>
          <label className="grid gap-1 text-sm font-extrabold text-grape-800">SEO-описание (до 200 символов)
            <textarea name="seoDescription" defaultValue={post?.seoDescription ?? ""} maxLength={200} rows={2} className={textarea} />
          </label>
        </div>
      </details>
    </div>
  );
}
