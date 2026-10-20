import type { Metadata } from "next";
import Link from "next/link";
import { listImages } from "@/core/news";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { deleteImageAction } from "../actions";
import { btn, btnGhost, input } from "../PostForm";

export const metadata: Metadata = { title: "Изображения" };
const NOTICES: Record<string, string> = { uploaded: "Изображение загружено.", deleted: "Изображение удалено." };
const ERRORS: Record<string, string> = {
  file: "Нужен файл JPEG, PNG или WebP до 4 МБ.", alt: "Опишите изображение (нужно для доступности).", too_big: "Файл больше 4 МБ.",
  image_in_use: "Изображение используется в записи, сначала уберите его оттуда.", forbidden: "Недостаточно прав.",
};

export default async function MediaPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("news.manage");
  const sp = await searchParams;
  const images = await listImages(getPool(), { id: user.id, role: user.role });
  return (
    <div className="grid min-w-0 gap-5">
      <Link href="/news" className="text-sm font-extrabold text-grape-700">← Новости и акции</Link>
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Изображения</h1>
      <p className="text-sm text-muted">Загрузка очищает файл от метаданных (место съёмки, автор, камера), переводит в WebP и уменьшает до 1600 пикселей. Не загружайте фото, на которых можно узнать конкретных детей, без согласия родителей. Никогда не публикуйте документы и скриншоты с данными клиентов.</p>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось загрузить."}</p> : null}
      <form method="post" action="/api/media" encType="multipart/form-data" className="grid gap-3 rounded-3xl border border-line bg-white p-5">
        <label className="grid gap-1 text-sm font-extrabold text-grape-800">Файл (JPEG, PNG, WebP; до 4 МБ)
          <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required className={input + " py-2"} />
        </label>
        <label className="grid gap-1 text-sm font-extrabold text-grape-800">Описание изображения (для незрячих посетителей и поисковиков)
          <input name="alt" required maxLength={200} className={input} />
        </label>
        <button type="submit" className={`${btn} w-fit`}>Загрузить</button>
      </form>
      <ul className="grid gap-3 sm:grid-cols-2">
        {images.map((i) => (
          <li key={i.id} className="min-w-0 rounded-3xl border border-line bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/media/${i.id}`} alt={i.alt} width={i.width} height={i.height} className="h-40 w-full rounded-2xl bg-paper object-contain" />
            <p className="mt-2 break-words text-sm font-bold text-grape-900">{i.alt}</p>
            <p className="text-xs text-muted">{i.width}×{i.height} · {Math.round(i.bytes / 1024)} КБ · используется в записях: {i.usedBy}</p>
            <p className="mt-1 break-all text-xs">Для текста: <code className="select-all">![](img:{i.id})</code></p>
            {i.usedBy === 0 ? (
              <form action={deleteImageAction} className="mt-2"><input type="hidden" name="id" value={i.id} /><button type="submit" className={btnGhost}>Удалить</button></form>
            ) : null}
          </li>
        ))}
        {images.length === 0 ? <li className="rounded-3xl border border-line bg-white p-5 text-sm text-muted sm:col-span-2">Изображений нет.</li> : null}
      </ul>
    </div>
  );
}
