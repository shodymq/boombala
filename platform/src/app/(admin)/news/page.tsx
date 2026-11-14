import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { listImages, listPosts, type PostStatus } from "@/core/news";
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
  const actor = { id: user.id, role: user.role };
  const pool = getPool();
  const [posts, images] = await Promise.all([listPosts(pool, actor, { status }), listImages(pool, actor)]);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  return (
    <div className="crm-page">
      <header>
        <p className="crm-eyebrow">Публикации</p>
        <h1 className="crm-page-title">Новости и акции</h1>
        <p className="crm-page-subtitle">Черновики, публикации и запланированные материалы.</p>
      </header>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Не удалось выполнить действие."}</p> : null}
      <nav aria-label="Действия с публикациями" className="crm-news-filters flex flex-wrap gap-2">
        <Link href="/news/new" className="inline-flex h-11 items-center rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white">Создать</Link>
        <Link href="/news/media" className={btnGhost}>Изображения</Link>
        <Link href="/news" className={btnGhost} aria-current={!status ? "page" : undefined}>Все</Link>
        {Object.entries(STATUS).map(([key, label]) => <Link key={key} href={`/news?status=${key}`} className={btnGhost} aria-current={status === key ? "page" : undefined}>{label}</Link>)}
      </nav>
      <ul className="grid gap-3">
        {posts.map((post) => {
          const cover = images.find((image) => image.id === post.coverImageId);
          return (
            <li key={post.id}>
              <Link href={`/news/${post.id}`} className="crm-post-card flex min-w-0 gap-4 rounded-3xl border border-line bg-white p-4 hover:border-grape-400">
                {cover ? <Image src={`/api/public/news/image/${cover.id}`} alt={cover.alt} width={cover.width} height={cover.height} className="crm-post-cover" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="break-words text-base font-black text-grape-800">{post.title}</span>
                    <span className="text-xs font-bold text-muted">{KIND[post.kind]}</span>
                    <span className="crm-status-badge" data-status={post.scheduled ? "draft" : post.status}>{post.scheduled ? "Запланировано" : STATUS[post.status]}</span>
                  </div>
                  {post.excerpt ? <p className="mt-1 text-sm text-muted">{post.excerpt}</p> : null}
                  <p className="mt-1 break-all text-xs text-muted">/news/{post.slug} · изменено {fmt.format(post.updatedAt)}{post.publishedAt ? ` · публикация ${fmt.format(post.publishedAt)}` : ""}{post.validUntil ? ` · акция до ${post.validUntil}` : ""}</p>
                </div>
              </Link>
            </li>
          );
        })}
        {posts.length === 0 ? (
          <li className="crm-empty-state rounded-3xl border border-line bg-white p-5 text-sm text-muted">
            <p>{status ? `Публикаций со статусом «${STATUS[status]}» нет.` : "Пока нет публикаций. Создайте первый черновик."}</p>
            <Link href="/news/new" className="mt-3 inline-flex h-10 items-center rounded-full bg-grape-700 px-4 text-sm font-extrabold text-white">Создать публикацию</Link>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
