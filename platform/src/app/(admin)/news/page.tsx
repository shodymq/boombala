import type { Metadata } from "next";
import Link from "next/link";
import { listPosts, type PostStatus } from "@/core/news";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { btnGhost } from "./PostForm";

export const metadata: Metadata = { title: "Новости" };

const STATUS: Record<string, string> = { draft: "Черновик", published: "Опубликовано", archived: "Снято с публикации" };
const KIND: Record<string, string> = { news: "Новость", promo: "Акция" };
const NOTICES: Record<string, string> = { deleted: "Запись удалена." };
const ERRORS: Record<string, string> = { forbidden: "Недостаточно прав.", post_published: "Опубликованную запись сначала нужно снять с публикации." };

export default async function NewsAdminPage({ searchParams }: { searchParams: Promise<{ status?: string; notice?: string; error?: string }> }) {
  const { user } = await requirePermission("news.manage");
  const sp = await searchParams;
  const status = sp.status && STATUS[sp.status] ? (sp.status as PostStatus) : undefined;
  const posts = await listPosts(getPool(), { id: user.id, role: user.role }, { status });
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  return (
    <div className="grid min-w-0 gap-5">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Новости и акции</h1>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Link href="/news/new" className="inline-flex h-11 items-center rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white">Создать</Link>
        <Link href="/news/media" className={btnGhost}>Изображения</Link>
        <Link href="/news" className={btnGhost}>Все</Link>
        {Object.entries(STATUS).map(([k, v]) => <Link key={k} href={`/news?status=${k}`} className={btnGhost}>{v}</Link>)}
      </div>
      <ul className="grid gap-3">
        {posts.map((p) => (
          <li key={p.id}>
            <Link href={`/news/${p.id}`} className="block min-w-0 rounded-3xl border border-line bg-white p-5 hover:border-grape-400">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="break-words text-base font-black text-grape-800">{p.title}</span>
                <span className="text-xs font-bold text-muted">{KIND[p.kind]} · {STATUS[p.status]}</span>
              </div>
              <p className="mt-1 break-all text-xs text-muted">/news/{p.slug} · изменено {fmt.format(p.updatedAt)}{p.publishedAt ? ` · публикация ${fmt.format(p.publishedAt)}` : ""}</p>
            </Link>
          </li>
        ))}
        {posts.length === 0 ? <li className="rounded-3xl border border-line bg-white p-5 text-sm text-muted">Записей нет.</li> : null}
      </ul>
    </div>
  );
}
