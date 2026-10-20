import type { Metadata } from "next";
import Link from "next/link";
import { listImages } from "@/core/news";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { createPostAction } from "../actions";
import { PostFields, btn } from "../PostForm";

export const metadata: Metadata = { title: "Новая запись" };
const ERRORS: Record<string, string> = { slug_taken: "Такой адрес уже занят.", forbidden: "Недостаточно прав." };

export default async function NewPostPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { user } = await requirePermission("news.manage");
  const { error } = await searchParams;
  const images = await listImages(getPool(), { id: user.id, role: user.role });
  return (
    <div className="grid min-w-0 gap-5">
      <Link href="/news" className="text-sm font-extrabold text-grape-700">← Новости и акции</Link>
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Новая запись</h1>
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{ERRORS[error] ?? "Проверьте поля формы (заголовок, адрес, длины)."}</p> : null}
      <form action={createPostAction} className="grid gap-4 rounded-3xl border border-line bg-white p-5">
        <PostFields images={images} />
        <button type="submit" className={`${btn} w-fit`}>Сохранить как черновик</button>
      </form>
    </div>
  );
}
