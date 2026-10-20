import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { parseBody } from "@/core/markup";
import { getPost, listImages, type PostStatus, type PublicBlock } from "@/core/news";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { deletePostAction, publishPostAction, savePostAction, unpublishPostAction } from "../actions";
import { PostBlocks } from "../PostBlocks";
import { PostFields, btn, btnGhost, input } from "../PostForm";

export const metadata: Metadata = { title: "Запись" };

const STATUS: Record<PostStatus, string> = { draft: "Черновик", published: "Опубликовано", archived: "Снято с публикации" };
const NOTICES: Record<string, string> = { created: "Черновик создан.", saved: "Сохранено.", published: "Опубликовано.", unpublished: "Снято с публикации: страница больше не доступна посетителям." };
const ERRORS: Record<string, string> = {
  slug_taken: "Такой адрес уже занят.", forbidden: "Недостаточно прав.", post_published: "Опубликованную запись сначала нужно снять с публикации.",
  not_published: "Запись уже не опубликована.", invalid_body: "Проверьте текст: он не должен быть пустым, ссылки на изображения должны существовать.",
};

export default async function EditPostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("news.manage");
  const { id } = await params;
  const sp = await searchParams;
  const actor = { id: user.id, role: user.role };
  const post = await getPost(getPool(), actor, id);
  if (!post) notFound();
  const images = await listImages(getPool(), actor);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  const blocks: PublicBlock[] = [];
  for (const b of parseBody(post.body)) {
    if (b.type !== "img") blocks.push(b);
    else {
      const m = images.find((i) => i.id === b.imageId);
      if (m) blocks.push({ type: "img", imageId: m.id, alt: m.alt, width: m.width, height: m.height });
    }
  }

  return (
    <div className="grid min-w-0 gap-5">
      <Link href="/news" className="text-sm font-extrabold text-grape-700">← Новости и акции</Link>
      <h1 className="break-words text-3xl font-black tracking-tight text-grape-800">{post.title}</h1>
      <p className="text-sm text-muted">
        {STATUS[post.status]}{post.scheduled ? ` (будет опубликовано ${fmt.format(post.publishedAt!)})` : post.publishedAt && post.status === "published" ? ` с ${fmt.format(post.publishedAt)}` : ""} · изменено {fmt.format(post.updatedAt)}{post.authorName ? ` (${post.authorName})` : ""}
      </p>
      {sp.notice && NOTICES[sp.notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[sp.notice]}</p> : null}
      {sp.error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[sp.error] ?? "Проверьте поля формы."}</p> : null}

      <section aria-label="Публикация" className="grid gap-3 rounded-3xl border border-line bg-white p-5">
        {post.status === "published" ? (
          <form action={unpublishPostAction} className="grid gap-2">
            <input type="hidden" name="id" value={post.id} />
            <p className="text-sm">Страница доступна по адресу <code className="break-all">/news/{post.slug}</code>.</p>
            <button type="submit" className={`${btnGhost} w-fit`}>Снять с публикации</button>
          </form>
        ) : (
          <form action={publishPostAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <input type="hidden" name="id" value={post.id} />
            <label className="grid gap-1 text-sm font-extrabold text-grape-800">Опубликовать в (по Алматы; пусто = сейчас)
              <input type="datetime-local" name="publishAt" className={input} />
            </label>
            <button type="submit" className={btn}>Опубликовать</button>
          </form>
        )}
        {post.status !== "published" ? (
          <form action={deletePostAction}>
            <input type="hidden" name="id" value={post.id} />
            <button type="submit" className={btnGhost}>Удалить навсегда</button>
          </form>
        ) : null}
      </section>

      <form action={savePostAction} className="grid gap-4 rounded-3xl border border-line bg-white p-5">
        <input type="hidden" name="id" value={post.id} />
        <PostFields post={post} images={images} />
        <button type="submit" className={`${btn} w-fit`}>Сохранить</button>
      </form>

      <section aria-label="Предпросмотр" className="rounded-3xl border border-line bg-white p-5">
        <h2 className="text-lg font-black text-grape-800">Предпросмотр текста</h2>
        <div className="mt-3"><PostBlocks blocks={blocks} /></div>
      </section>
    </div>
  );
}
