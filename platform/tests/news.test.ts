import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { almatyToday } from "../src/core/dates.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../src/core/errors.ts";
import { processImage } from "../src/core/images.ts";
import { imageIdsIn, parseBody, parseInline, safeHref } from "../src/core/markup.ts";
import {
  addImage, adminImage, createPost, deleteImage, deletePost, listImages, listPosts, publicImage, publicList, publicPost, publicSlugs, publishPost, slugify, unpublishPost, updatePost,
} from "../src/core/news.ts";
import { makeUser, startTestDb, type TestDb } from "./helpers/db.ts";

const plus = (days: number) => {
  const d = new Date(`${almatyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const jpegWithExif = async () =>
  sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 30, b: 90 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "Secret Author Name", Artist: "Ivan Ivanov" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 15/1 0/1" } })
    .toBuffer();

describe("Markup: never produces HTML, drops dangerous links", () => {
  it("links: only http(s), site-relative and tel; everything else becomes plain text", () => {
    assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(safeHref("/birthdays"), "/birthdays");
    assert.equal(safeHref("tel:+77471234567"), "tel:+77471234567");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "vbscript:x", "file:///etc/passwd", "ftp://x", " javascript:1"]) assert.equal(safeHref(bad), null, bad);
    const inl = parseInline("[click](javascript:alert(1)) and [ok](https://example.com)");
    assert.deepEqual(inl[0], { t: "text", v: "click" });
    assert.ok(inl.some((i) => i.t === "link" && i.href === "https://example.com"));
  });
  it("tags and attributes stay literal text: there is no HTML in the output model at all", () => {
    const blocks = parseBody('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n## <b>x</b>');
    const flat = JSON.stringify(blocks);
    assert.ok(flat.includes("<script>alert(1)</script>"), "kept as text for React to escape");
    assert.ok(blocks.every((b) => ["p", "h2", "h3", "ul", "img"].includes(b.type)));
  });
  it("structure: headings, paragraphs, line breaks, lists, images", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const blocks = parseBody(`## Заголовок\n\nПервая строка\nвторая **жирный**\n\n- один\n- два\n\n![](img:${id})\n\n![x](img:not-a-uuid)`);
    assert.deepEqual(blocks.map((b) => b.type), ["h2", "p", "ul", "img", "p"]);
    assert.deepEqual(imageIdsIn(`![](img:${id.toUpperCase()})\n\n![](img:${id})`), [id]);
  });
});

describe("Images: only pixels are kept", () => {
  it("strips EXIF/GPS/author metadata, converts to WebP, caps the size", async () => {
    const input = await jpegWithExif();
    assert.ok((await sharp(input).metadata()).exif, "the fixture really carries EXIF");
    const out = await processImage(input);
    const meta = await sharp(out.data).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.ok(!out.data.includes(Buffer.from("Secret Author Name")) && !out.data.includes(Buffer.from("Ivan Ivanov")), "no author text left in the bytes");
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#fff" } }).png().toBuffer();
    const r = await processImage(big);
    assert.ok(Math.max(r.width, r.height) <= 1600);
  });
  it("rejects SVG, GIF, scripts, fake extensions, empty, oversized and decompression bombs", async () => {
    const bad: Buffer[] = [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      Buffer.from("GIF89a\x01\x00\x01\x00"),
      Buffer.from("<?php echo 1;"),
      Buffer.from("MZ\x90\x00 executable"),
      Buffer.alloc(0),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 1)]), // JPEG magic, garbage body
    ];
    for (const b of bad) await assert.rejects(() => processImage(b), ValidationError);
    await assert.rejects(() => processImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)])), ValidationError);
    const bomb = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(bomb.length < 4 * 1024 * 1024, "the bomb fits the upload limit");
    await assert.rejects(() => processImage(bomb), ValidationError);
  });
});

describe("News and promotions: lifecycle and public visibility", () => {
  let db: TestDb;
  let editor: Awaited<ReturnType<typeof makeUser>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  before(async () => {
    db = await startTestDb();
    owner = await makeUser(db.pool, "owner");
    editor = await makeUser(db.pool, "editor");
    manager = await makeUser(db.pool, "manager");
  });
  after(async () => {
    await db.stop();
  });

  it("slugify handles Russian and Kazakh letters", () => {
    assert.equal(slugify("Новая комната: Roblox!"), "novaya-komnata-roblox");
    assert.equal(slugify("Қош келдіңіз, мерекесі!"), "kosh-keldiniz-merekesi");
    assert.equal(slugify("  --  "), "");
  });

  it("a draft is invisible to the public; publishing makes it public; unpublishing removes it at once", async () => {
    const p = await createPost(db.pool, editor, { title: "Открытие нового зала", kind: "news", excerpt: "Коротко", body: "## Привет\n\nТекст новости" });
    assert.equal(p.status, "draft");
    assert.equal(p.slug, "otkrytie-novogo-zala");
    assert.equal(await publicPost(db.pool, p.slug), null);
    assert.deepEqual(await publicList(db.pool), []);
    const slug = await publishPost(db.pool, editor, p.id);
    assert.equal(slug, p.slug);
    const pub = await publicPost(db.pool, p.slug);
    assert.ok(pub && pub.title === "Открытие нового зала" && pub.blocks[0].type === "h2");
    assert.ok(!JSON.stringify(pub).includes("Test editor"), "no author name is published");
    assert.equal((await publicList(db.pool)).length, 1);
    assert.ok((await publicSlugs(db.pool)).some((s) => s.slug === p.slug));
    await unpublishPost(db.pool, editor, p.id);
    assert.equal(await publicPost(db.pool, p.slug), null);
    assert.deepEqual(await publicList(db.pool), []);
    assert.equal((await listPosts(db.pool, editor, { status: "archived" })).length, 1, "still in the admin as archived");
    await assert.rejects(() => unpublishPost(db.pool, editor, p.id), (e) => e instanceof ConflictError && e.message === "not_published");
  });

  it("editing a published post updates it; the published address cannot change (even by a crafted form or raw SQL)", async () => {
    const p = await createPost(db.pool, owner, { title: "Акция недели", kind: "news", body: "Текст" });
    await publishPost(db.pool, owner, p.id);
    await updatePost(db.pool, owner, p.id, { title: "Акция недели (обновлено)", slug: "another-address", kind: "news", body: "Новый текст" });
    const after = (await listPosts(db.pool, owner)).find((x) => x.id === p.id)!;
    assert.equal(after.slug, p.slug, "the slug field of the form is ignored after publication");
    assert.equal((await publicPost(db.pool, p.slug))?.title, "Акция недели (обновлено)");
    await assert.rejects(() => db.pool.query("UPDATE bb.news_posts SET slug = 'hacked' WHERE id = $1", [p.id]));
    // a draft may still change its address
    const d = await createPost(db.pool, owner, { title: "Черновик", kind: "news" });
    await updatePost(db.pool, owner, d.id, { title: "Черновик", slug: "my-own-address", kind: "news" });
    assert.equal((await listPosts(db.pool, owner)).find((x) => x.id === d.id)!.slug, "my-own-address");
  });

  it("delete: drafts and archived posts yes, a published post never", async () => {
    const p = await createPost(db.pool, owner, { title: "Удаляемая", kind: "news", body: "x" });
    await publishPost(db.pool, owner, p.id);
    await assert.rejects(() => deletePost(db.pool, owner, p.id), (e) => e instanceof ConflictError && e.message === "post_published");
    await assert.rejects(() => db.pool.query("DELETE FROM bb.news_posts WHERE id = $1", [p.id]));
    await unpublishPost(db.pool, owner, p.id);
    await deletePost(db.pool, owner, p.id);
    assert.equal((await listPosts(db.pool, owner)).some((x) => x.id === p.id), false);
    const audit = (await db.pool.query("SELECT action FROM bb.audit_log WHERE entity_id = $1 ORDER BY id", [p.id])).rows.map((r) => r.action);
    assert.deepEqual(audit, ["news.created", "news.published", "news.unpublished", "news.deleted"]);
  });

  it("scheduled posts appear only when their time comes; empty posts cannot be published", async () => {
    const p = await createPost(db.pool, owner, { title: "Запланированная", kind: "news", body: "x" });
    await publishPost(db.pool, owner, p.id, new Date(Date.now() + 3600_000));
    assert.equal(await publicPost(db.pool, p.slug), null, "future publication time: not public yet");
    await db.pool.query("UPDATE bb.news_posts SET published_at = now() - interval '1 minute' WHERE id = $1", [p.id]);
    assert.ok(await publicPost(db.pool, p.slug));
    const empty = await createPost(db.pool, owner, { title: "Пустая", kind: "news", body: "   " });
    await assert.rejects(() => publishPost(db.pool, owner, empty.id), ValidationError);
  });

  it("promotions: listed until valid_until, then hidden from the list but reachable and marked", async () => {
    const live = await createPost(db.pool, owner, { title: "Скидка живая", kind: "promo", body: "x", validUntil: plus(5) });
    const done = await createPost(db.pool, owner, { title: "Скидка прошла", kind: "promo", body: "x", validUntil: plus(-1) });
    await publishPost(db.pool, owner, live.id);
    await publishPost(db.pool, owner, done.id);
    const titles = (await publicList(db.pool, { kind: "promo" })).map((x) => x.title);
    assert.ok(titles.includes("Скидка живая") && !titles.includes("Скидка прошла"));
    assert.equal((await publicPost(db.pool, done.slug))?.expired, true);
    assert.equal((await publicPost(db.pool, live.slug))?.expired, false);
    const news = await createPost(db.pool, owner, { title: "Новость с датой", kind: "news", body: "x", validUntil: plus(3) });
    assert.equal((await listPosts(db.pool, owner)).find((x) => x.id === news.id)!.validUntil, null, "valid_until only belongs to promotions");
  });

  it("unique and well-formed addresses", async () => {
    await createPost(db.pool, owner, { title: "Дубль", kind: "news" });
    await assert.rejects(() => createPost(db.pool, owner, { title: "Дубль", kind: "news" }), (e) => e instanceof ConflictError && e.message === "slug_taken");
    await assert.rejects(() => createPost(db.pool, owner, { title: "Плохой", slug: "Bad Slug!", kind: "news" }), ValidationError);
    await assert.rejects(() => createPost(db.pool, owner, { title: "x".repeat(161), kind: "news" }), ValidationError);
    await assert.rejects(() => createPost(db.pool, owner, { title: "Нет", kind: "other" as never }), ValidationError);
  });

  it("images: stored once, public only through a published post, deletable only when unused", async () => {
    const file = await jpegWithExif();
    const { id } = await addImage(db.pool, editor, file, "Красный фон");
    assert.equal((await addImage(db.pool, editor, file, "Красный фон")).id, id, "the same picture is stored once");
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM bb.news_images")).rows[0].n, 1);
    const stored = (await adminImage(db.pool, editor, id))!;
    assert.equal(stored.mime, "image/webp");
    assert.equal((await sharp(stored.data).metadata()).exif, undefined, "what is stored has no metadata");
    assert.equal(await publicImage(db.pool, id), null, "not used by a published post: not public");
    const post = await createPost(db.pool, editor, { title: "С картинкой", kind: "news", body: `Текст\n\n![](img:${id})`, coverImageId: id });
    assert.equal(await publicImage(db.pool, id), null, "a DRAFT does not make its picture public");
    await assert.rejects(() => deleteImage(db.pool, editor, id), (e) => e instanceof ConflictError && e.message === "image_in_use");
    await publishPost(db.pool, editor, post.id);
    const pub = await publicPost(db.pool, post.slug);
    assert.equal(pub?.cover?.id, id);
    assert.ok(pub?.blocks.some((b) => b.type === "img" && b.alt === "Красный фон"));
    assert.ok(await publicImage(db.pool, id));
    await unpublishPost(db.pool, editor, post.id);
    assert.equal(await publicImage(db.pool, id), null, "taken down: the picture is no longer public");
    assert.equal((await listImages(db.pool, editor))[0].usedBy, 1);
    await updatePost(db.pool, editor, post.id, { title: "С картинкой", kind: "news", body: "без картинки", coverImageId: null });
    await deleteImage(db.pool, editor, id);
    await assert.rejects(() => addImage(db.pool, editor, file, " "), ValidationError, "alt text is required");
    const broken = await createPost(db.pool, editor, { title: "Битая ссылка", kind: "news", body: "![](img:123e4567-e89b-42d3-a456-426614174111)" });
    await assert.rejects(() => publishPost(db.pool, editor, broken.id), ValidationError);
  });

  it("permissions: owner and editor manage news; the manager and anyone else are refused", async () => {
    await assert.rejects(() => createPost(db.pool, manager, { title: "Нельзя", kind: "news" }), ForbiddenError);
    await assert.rejects(() => listPosts(db.pool, manager), ForbiddenError);
    await assert.rejects(() => addImage(db.pool, manager, Buffer.alloc(10), "x"), ForbiddenError);
    assert.ok(await createPost(db.pool, editor, { title: "Редактор может", kind: "news" }));
    assert.ok(await createPost(db.pool, owner, { title: "Владелец может", kind: "news" }));
  });
});
