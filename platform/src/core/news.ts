import type { Pool, Queryable } from "./db.ts";
import { withTx } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { almatyToday, isValidDate } from "./dates.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { processImage } from "./images.ts";
import { imageIdsIn, parseBody, plainText, type Block } from "./markup.ts";
import { assertCan, type Actor } from "./rbac.ts";
import type { RequestMeta } from "./users.ts";

export type PostStatus = "draft" | "published" | "archived";
export type PostKind = "news" | "promo";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ә: "a", ғ: "g", қ: "k", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

/** "Новая комната: Roblox!" -> "novaya-komnata-roblox" */
export function slugify(text: string): string {
  const latin = [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  return latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
}

export interface PostInput {
  title: string;
  slug?: string;
  kind: PostKind;
  excerpt?: string;
  body?: string;
  coverImageId?: string | null;
  seoTitle?: string;
  seoDescription?: string;
  validUntil?: string;
}

interface Clean {
  title: string;
  slug: string;
  kind: PostKind;
  excerpt: string;
  body: string;
  coverImageId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  validUntil: string | null;
}

function clean(input: PostInput): Clean {
  const errors: Record<string, string> = {};
  const title = (input.title ?? "").trim().replace(/\s+/g, " ");
  if (!title || title.length > 160) errors.title = "Заголовок: от 1 до 160 символов";
  const slug = (input.slug?.trim() || slugify(title)).toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) errors.slug = "Адрес: латиница, цифры и дефисы, до 80 символов";
  if (input.kind !== "news" && input.kind !== "promo") errors.kind = "Выберите: новость или акция";
  const excerpt = (input.excerpt ?? "").trim();
  if (excerpt.length > 300) errors.excerpt = "Краткое описание: до 300 символов";
  const body = (input.body ?? "").replace(/\r\n?/g, "\n");
  if (body.length > 30000) errors.body = "Текст: до 30 000 символов";
  const seoTitle = input.seoTitle?.trim() || null;
  if (seoTitle && seoTitle.length > 70) errors.seoTitle = "SEO-заголовок: до 70 символов";
  const seoDescription = input.seoDescription?.trim() || null;
  if (seoDescription && seoDescription.length > 200) errors.seoDescription = "SEO-описание: до 200 символов";
  let validUntil = input.validUntil?.trim() || null;
  if (validUntil && !isValidDate(validUntil)) errors.validUntil = "Некорректная дата";
  if (validUntil && input.kind !== "promo") validUntil = null;
  const cover = input.coverImageId?.trim() || null;
  if (cover && !/^[0-9a-f-]{36}$/i.test(cover)) errors.coverImageId = "Некорректное изображение";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { title, slug, kind: input.kind, excerpt, body, coverImageId: cover, seoTitle, seoDescription, validUntil };
}

function mapDbError(error: unknown): never {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23505" && e.constraint?.includes("slug")) throw new ConflictError("slug_taken");
  if (e?.code === "23503") throw new ValidationError({ coverImageId: "Изображение не найдено" });
  if (typeof e?.message === "string" && e.message.includes("cannot change")) throw new ConflictError("slug_frozen");
  if (typeof e?.message === "string" && e.message.includes("cannot be deleted")) throw new ConflictError("post_published");
  throw error;
}

export interface PostRow {
  id: string;
  slug: string;
  kind: PostKind;
  title: string;
  excerpt: string;
  body: string;
  coverImageId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  validUntil: string | null;
  status: PostStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  authorName: string | null;
  /** Published, but its publication time is still in the future. */
  scheduled: boolean;
}

const COLS = `p.id, p.slug, p.kind, p.title, p.excerpt, p.body, p.cover_image_id, p.seo_title, p.seo_description,
  to_char(p.valid_until, 'YYYY-MM-DD') AS valid_until, p.status, p.published_at, p.created_at, p.updated_at, u.name AS author_name, (p.status = 'published' AND p.published_at > now()) AS scheduled`;
const FROM = "FROM bb.news_posts p LEFT JOIN bb.users u ON u.id = p.updated_by";
const map = (r: Record<string, unknown>): PostRow => ({
  id: r.id as string, slug: r.slug as string, kind: r.kind as PostKind, title: r.title as string, excerpt: r.excerpt as string, body: r.body as string,
  coverImageId: r.cover_image_id as string | null, seoTitle: r.seo_title as string | null, seoDescription: r.seo_description as string | null,
  validUntil: r.valid_until as string | null, status: r.status as PostStatus, publishedAt: r.published_at as Date | null, createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date, authorName: r.author_name as string | null, scheduled: r.scheduled as boolean,
});

export async function createPost(pool: Pool, actor: Actor, input: PostInput, meta: RequestMeta = {}): Promise<PostRow> {
  assertCan(actor, "news.manage");
  const c = clean(input);
  try {
    return await withTx(pool, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO bb.news_posts (slug, kind, title, excerpt, body, cover_image_id, seo_title, seo_description, valid_until, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
        [c.slug, c.kind, c.title, c.excerpt, c.body, c.coverImageId, c.seoTitle, c.seoDescription, c.validUntil, actor.id],
      );
      await writeAudit(tx, { actorUserId: actor.id, action: "news.created", entityType: "news_post", entityId: rows[0].id, after: { slug: c.slug, kind: c.kind }, ...meta });
      return (await getPost(tx, actor, rows[0].id))!;
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export async function updatePost(pool: Pool, actor: Actor, id: string, input: PostInput, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "news.manage");
  const c = clean(input);
  try {
    await withTx(pool, async (tx) => {
      const cur = await tx.query<{ status: string; published_at: Date | null; slug: string }>("SELECT status, published_at, slug FROM bb.news_posts WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw new ValidationError({ id: "Запись не найдена" });
      // A published address is frozen: keep it even if the form carried a different one.
      const slug = cur.rows[0].published_at ? cur.rows[0].slug : c.slug;
      await tx.query(
        `UPDATE bb.news_posts SET slug = $2, kind = $3, title = $4, excerpt = $5, body = $6, cover_image_id = $7, seo_title = $8, seo_description = $9,
                valid_until = $10, updated_by = $11 WHERE id = $1`,
        [id, slug, c.kind, c.title, c.excerpt, c.body, c.coverImageId, c.seoTitle, c.seoDescription, c.validUntil, actor.id],
      );
      await writeAudit(tx, { actorUserId: actor.id, action: "news.updated", entityType: "news_post", entityId: id, after: { slug, status: cur.rows[0].status }, ...meta });
    });
  } catch (error) {
    return mapDbError(error);
  }
}

/** Makes the post public from `publishAt` (default: now; a future time = scheduled). Returns the slug for cache refresh. */
export async function publishPost(pool: Pool, actor: Actor, id: string, publishAt?: Date | null, meta: RequestMeta = {}): Promise<string> {
  assertCan(actor, "news.manage");
  if (publishAt && Number.isNaN(publishAt.getTime())) throw new ValidationError({ publishAt: "Некорректная дата публикации" });
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ slug: string; title: string; body: string; published_at: Date | null }>("SELECT slug, title, body, published_at FROM bb.news_posts WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw new ValidationError({ id: "Запись не найдена" });
    const r = rows[0];
    const errors: Record<string, string> = {};
    if (!r.title.trim()) errors.title = "Нужен заголовок";
    if (!r.body.trim()) errors.body = "Нельзя опубликовать пустой текст";
    if (Object.keys(errors).length) throw new ValidationError(errors);
    // Pictures used in the text must exist (a typo in an image id would otherwise publish a broken page).
    const ids = imageIdsIn(r.body);
    if (ids.length) {
      const found = await tx.query("SELECT 1 FROM bb.news_images WHERE id = ANY($1::uuid[])", [ids]);
      if (found.rowCount !== ids.length) throw new ValidationError({ body: "В тексте есть ссылка на несуществующее изображение" });
    }
    await tx.query("UPDATE bb.news_posts SET status = 'published', published_at = COALESCE($2::timestamptz, published_at, now()), updated_by = $3 WHERE id = $1", [id, publishAt ?? null, actor.id]);
    await writeAudit(tx, { actorUserId: actor.id, action: "news.published", entityType: "news_post", entityId: id, after: { slug: r.slug, publishAt: publishAt?.toISOString() ?? "now" }, ...meta });
    return r.slug;
  });
}

/** Removes the post from public access at once (it stays in the admin as "archived"). */
export async function unpublishPost(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<string> {
  assertCan(actor, "news.manage");
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ slug: string; status: string }>("UPDATE bb.news_posts SET status = 'archived', updated_by = $2 WHERE id = $1 AND status = 'published' RETURNING slug, status", [id, actor.id]);
    if (!rows[0]) throw new ConflictError("not_published");
    await writeAudit(tx, { actorUserId: actor.id, action: "news.unpublished", entityType: "news_post", entityId: id, after: { slug: rows[0].slug }, ...meta });
    return rows[0].slug;
  });
}

/** Permanently deletes a draft or archived post. A published post must be taken down first. */
export async function deletePost(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<string> {
  assertCan(actor, "news.manage");
  try {
    return await withTx(pool, async (tx) => {
      const { rows } = await tx.query<{ slug: string; title: string }>("DELETE FROM bb.news_posts WHERE id = $1 RETURNING slug, title", [id]);
      if (!rows[0]) throw new ValidationError({ id: "Запись не найдена" });
      await writeAudit(tx, { actorUserId: actor.id, action: "news.deleted", entityType: "news_post", entityId: id, before: { slug: rows[0].slug, title: rows[0].title }, ...meta });
      return rows[0].slug;
    });
  } catch (error) {
    return mapDbError(error);
  }
}

export async function listPosts(pool: Pool, actor: Actor, filter: { status?: PostStatus; kind?: PostKind } = {}, limit = 200): Promise<PostRow[]> {
  assertCan(actor, "news.manage");
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.status) where.push(`p.status = $${params.push(filter.status)}`);
  if (filter.kind) where.push(`p.kind = $${params.push(filter.kind)}`);
  const { rows } = await pool.query(`SELECT ${COLS} ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.updated_at DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`, params);
  return rows.map(map);
}

export async function getPost(db: Queryable, actor: Actor, id: string): Promise<PostRow | null> {
  assertCan(actor, "news.manage");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

// ── Images ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImageRow {
  id: string;
  alt: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: Date;
  usedBy: number;
}

/** Re-encodes the upload (metadata removed) and stores it once; the same picture uploaded twice returns the first row. */
export async function addImage(pool: Pool, actor: Actor, file: Buffer, alt: string, meta: RequestMeta = {}): Promise<{ id: string }> {
  assertCan(actor, "news.manage");
  const text = alt.trim().replace(/\s+/g, " ");
  if (!text || text.length > 200) throw new ValidationError({ alt: "Опишите изображение (до 200 символов): это нужно для доступности" });
  const img = await processImage(file);
  return withTx(pool, async (tx) => {
    const existing = await tx.query<{ id: string }>("SELECT id FROM bb.news_images WHERE sha256 = $1", [img.sha256]);
    if (existing.rows[0]) return { id: existing.rows[0].id };
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO bb.news_images (mime, data, width, height, sha256, alt, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [img.mime, img.data, img.width, img.height, img.sha256, text, actor.id],
    );
    await writeAudit(tx, { actorUserId: actor.id, action: "news.image_added", entityType: "news_image", entityId: rows[0].id, after: { width: img.width, height: img.height, bytes: img.data.length }, ...meta });
    return { id: rows[0].id };
  });
}

export async function listImages(pool: Pool, actor: Actor): Promise<ImageRow[]> {
  assertCan(actor, "news.manage");
  const { rows } = await pool.query(
    `SELECT i.id, i.alt, i.width, i.height, octet_length(i.data) AS bytes, i.created_at,
            (SELECT count(*) FROM bb.news_posts p WHERE p.cover_image_id = i.id OR position('img:' || i.id::text in lower(p.body)) > 0)::int AS used_by
       FROM bb.news_images i ORDER BY i.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ id: r.id, alt: r.alt, width: r.width, height: r.height, bytes: Number(r.bytes), createdAt: r.created_at, usedBy: r.used_by }));
}

/** Unused pictures only: a picture that a post (draft or published) refers to cannot be deleted. */
export async function deleteImage(pool: Pool, actor: Actor, id: string, meta: RequestMeta = {}): Promise<void> {
  assertCan(actor, "news.manage");
  await withTx(pool, async (tx) => {
    const used = await tx.query("SELECT 1 FROM bb.news_posts p WHERE p.cover_image_id = $1 OR position('img:' || $1::text in lower(p.body)) > 0 LIMIT 1", [id]);
    if (used.rowCount) throw new ConflictError("image_in_use");
    const { rowCount } = await tx.query("DELETE FROM bb.news_images WHERE id = $1", [id]);
    if (!rowCount) throw new ValidationError({ id: "Изображение не найдено" });
    await writeAudit(tx, { actorUserId: actor.id, action: "news.image_deleted", entityType: "news_image", entityId: id, ...meta });
  });
}

/** Bytes for the ADMIN preview (any picture; the caller has checked the session and permission). */
export async function adminImage(db: Queryable, actor: Actor, id: string): Promise<{ mime: string; data: Buffer } | null> {
  assertCan(actor, "news.manage");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query<{ mime: string; data: Buffer }>("SELECT mime, data FROM bb.news_images WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// ── Public reading (what the site may show; no author names, no drafts, no unused pictures) ──────────────────────

export interface PublicPostSummary {
  slug: string;
  kind: PostKind;
  title: string;
  excerpt: string;
  publishedAt: string;
  validUntil: string | null;
  cover: { id: string; alt: string; width: number; height: number } | null;
}

export type PublicBlock = Exclude<Block, { type: "img" }> | { type: "img"; imageId: string; alt: string; width: number; height: number };

export interface PublicPost extends PublicPostSummary {
  blocks: PublicBlock[];
  updatedAt: string;
  seoTitle: string | null;
  seoDescription: string;
  /** A finished promotion stays reachable by its address but is marked and not listed. */
  expired: boolean;
}

const PUBLIC_WHERE = "p.status = 'published' AND p.published_at <= now()";
const coverOf = (r: Record<string, unknown>) =>
  r.cover_image_id ? { id: r.cover_image_id as string, alt: r.cover_alt as string, width: r.cover_w as number, height: r.cover_h as number } : null;

export async function publicList(db: Queryable, opts: { kind?: PostKind; limit?: number; offset?: number } = {}): Promise<PublicPostSummary[]> {
  const params: unknown[] = [almatyToday()];
  const kind = opts.kind ? `AND p.kind = $${params.push(opts.kind)}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { rows } = await db.query(
    `SELECT p.slug, p.kind, p.title, p.excerpt, p.published_at, to_char(p.valid_until, 'YYYY-MM-DD') AS valid_until,
            p.cover_image_id, i.alt AS cover_alt, i.width AS cover_w, i.height AS cover_h
       FROM bb.news_posts p LEFT JOIN bb.news_images i ON i.id = p.cover_image_id
      WHERE ${PUBLIC_WHERE} AND (p.valid_until IS NULL OR p.valid_until >= $1::date) ${kind}
      ORDER BY p.published_at DESC, p.slug LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows.map((r) => ({ slug: r.slug, kind: r.kind, title: r.title, excerpt: r.excerpt, publishedAt: (r.published_at as Date).toISOString(), validUntil: r.valid_until, cover: coverOf(r) }));
}

export async function publicPost(db: Queryable, slug: string): Promise<PublicPost | null> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  const { rows } = await db.query(
    `SELECT p.slug, p.kind, p.title, p.excerpt, p.body, p.published_at, p.updated_at, p.seo_title, p.seo_description, to_char(p.valid_until, 'YYYY-MM-DD') AS valid_until,
            p.cover_image_id, i.alt AS cover_alt, i.width AS cover_w, i.height AS cover_h
       FROM bb.news_posts p LEFT JOIN bb.news_images i ON i.id = p.cover_image_id
      WHERE ${PUBLIC_WHERE} AND p.slug = $1`,
    [slug],
  );
  const r = rows[0];
  if (!r) return null;
  const blocks = parseBody(r.body);
  const ids = blocks.flatMap((b) => (b.type === "img" ? [b.imageId] : []));
  const imgs = ids.length ? (await db.query<{ id: string; alt: string; width: number; height: number }>("SELECT id, alt, width, height FROM bb.news_images WHERE id = ANY($1::uuid[])", [ids])).rows : [];
  const resolved: PublicBlock[] = [];
  for (const b of blocks) {
    if (b.type !== "img") resolved.push(b);
    else {
      const m = imgs.find((x) => x.id === b.imageId);
      if (m) resolved.push({ type: "img", imageId: m.id, alt: m.alt, width: m.width, height: m.height }); // an unknown id renders nothing
    }
  }
  return {
    slug: r.slug, kind: r.kind, title: r.title, excerpt: r.excerpt, publishedAt: (r.published_at as Date).toISOString(), validUntil: r.valid_until, cover: coverOf(r),
    blocks: resolved, updatedAt: (r.updated_at as Date).toISOString(), seoTitle: r.seo_title,
    seoDescription: r.seo_description || r.excerpt || plainText(r.body, 160),
    expired: !!r.valid_until && r.valid_until < almatyToday(),
  };
}

/** A picture is public only while a published post uses it as the cover or inside its text. */
export async function publicImage(db: Queryable, id: string): Promise<{ mime: string; data: Buffer } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await db.query<{ mime: string; data: Buffer }>(
    `SELECT i.mime, i.data FROM bb.news_images i
      WHERE i.id = $1 AND EXISTS (
        SELECT 1 FROM bb.news_posts p WHERE ${PUBLIC_WHERE} AND (p.cover_image_id = i.id OR position('img:' || i.id::text in lower(p.body)) > 0))`,
    [id],
  );
  return rows[0] ?? null;
}

/** For the sitemap: slug + last change of every public post. */
export async function publicSlugs(db: Queryable): Promise<Array<{ slug: string; updatedAt: string }>> {
  const { rows } = await db.query(`SELECT p.slug, p.updated_at FROM bb.news_posts p WHERE ${PUBLIC_WHERE} ORDER BY p.published_at DESC LIMIT 1000`);
  return rows.map((r) => ({ slug: r.slug, updatedAt: (r.updated_at as Date).toISOString() }));
}
