import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { listImages } from "@/core/news";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { bridgeRpc, legacyBridgeEnabled } from "@/server/bridge-client";
import { SESSION_COOKIE } from "@/server/env";
import { createPostAction } from "../actions";
import { PostFields, btn } from "../PostForm";

export const metadata: Metadata = { title: "Новая запись" };
const ERRORS: Record<string, string> = { slug_taken: "Такой адрес уже занят.", forbidden: "Недостаточно прав." };

export default async function NewPostPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { user } = await requirePermission("news.manage");
  const { error } = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const imagesRaw = legacyBridgeEnabled() ? await bridgeRpc<Awaited<ReturnType<typeof listImages>>>("news.images", {}, token) : await listImages(getPool(), { id: user.id, role: user.role });
  const images = imagesRaw.map((i) => ({ ...i, createdAt: new Date(i.createdAt) }));
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
