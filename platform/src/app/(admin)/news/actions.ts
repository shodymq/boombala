"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { createPost, deleteImage, deletePost, publishPost, unpublishPost, updatePost, type PostInput } from "../../../core/news.ts";
import { notifySite } from "../../../server/api.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

const uuid = z.string().uuid();
const str = (f: FormData, k: string) => String(f.get(k) ?? "");

function failure(error: unknown, back = "/news"): never {
  let code = "failed";
  if (error instanceof ValidationError) code = `invalid_${Object.keys(error.fields)[0] ?? "form"}`.replace(/[^a-zA-Z_]/g, "");
  else if (error instanceof ConflictError) code = error.message.replace(/[^a-z_]/g, "") || "conflict";
  else if (error instanceof ForbiddenError) code = "forbidden";
  redirect(`${back}${back.includes("?") ? "&" : "?"}error=${code}`);
}

function input(f: FormData): PostInput {
  return {
    title: str(f, "title"),
    slug: str(f, "slug"),
    kind: str(f, "kind") as PostInput["kind"],
    excerpt: str(f, "excerpt"),
    body: str(f, "body"),
    coverImageId: str(f, "coverImageId") || null,
    seoTitle: str(f, "seoTitle"),
    seoDescription: str(f, "seoDescription"),
    validUntil: str(f, "validUntil"),
  };
}

export async function createPostAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  let id = "";
  try {
    id = (await createPost(getPool(), { id: user.id, role: user.role }, input(formData), await requestMeta())).id;
  } catch (error) {
    return failure(error, "/news/new");
  }
  redirect(`/news/${id}?notice=created`);
}

export async function savePostAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  let slug = "";
  try {
    await updatePost(getPool(), { id: user.id, role: user.role }, id.data, input(formData), await requestMeta());
    slug = (await getPool().query<{ slug: string }>("SELECT slug FROM bb.news_posts WHERE id = $1", [id.data])).rows[0]?.slug ?? "";
  } catch (error) {
    return failure(error, `/news/${id.data}`);
  }
  after(() => notifySite([slug]));
  redirect(`/news/${id.data}?notice=saved`);
}

export async function publishPostAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  const at = str(formData, "publishAt").trim();
  let slug = "";
  try {
    // The field is a local Almaty time (UTC+5, no daylight saving).
    const when = at ? new Date(`${at}:00+05:00`) : null;
    slug = await publishPost(getPool(), { id: user.id, role: user.role }, id.data, when, await requestMeta());
  } catch (error) {
    return failure(error, `/news/${id.data}`);
  }
  after(() => notifySite([slug]));
  redirect(`/news/${id.data}?notice=published`);
}

export async function unpublishPostAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  let slug = "";
  try {
    slug = await unpublishPost(getPool(), { id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error, `/news/${id.data}`);
  }
  after(() => notifySite([slug]));
  redirect(`/news/${id.data}?notice=unpublished`);
}

export async function deletePostAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  let slug = "";
  try {
    slug = await deletePost(getPool(), { id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error, `/news/${id.data}`);
  }
  after(() => notifySite([slug]));
  redirect("/news?notice=deleted");
}

export async function deleteImageAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("news.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }), "/news/media");
  try {
    await deleteImage(getPool(), { id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error, "/news/media");
  }
  redirect("/news/media?notice=deleted");
}
