// Cross-app check of news and promotions: admin (editor) -> publish -> public site -> takedown, in a real browser.
//   SITE_URL=http://localhost:3000 PLATFORM_URL=http://localhost:3100 DATABASE_URL=... E2E_PASSWORD=... npm run e2e:news
// Needs: platform with SITE_REVALIDATE_URL + PLATFORM_INTAKE_TOKEN, the site with NEXT_PUBLIC_NEWS=1 PLATFORM_URL PLATFORM_INTAKE_TOKEN, QA users.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import sharp from "sharp";
import { chromium } from "playwright-core";

const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const ADMIN = process.env.PLATFORM_URL ?? "http://localhost:3100";
const PW = process.env.E2E_PASSWORD;
const DB = process.env.DATABASE_URL;
const OUT = process.env.E2E_SCREENSHOTS ?? "";
if (!PW || !DB) throw new Error("E2E_PASSWORD and DATABASE_URL are required");
for (const u of [SITE, ADMIN]) if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) throw new Error("refusing to run against a non-local server: " + u);
if (OUT) mkdirSync(OUT, { recursive: true });
const pool = new pg.Pool({ connectionString: DB, max: 2 });
const scalar = async (q, p = []) => String((await pool.query(q, p)).rows[0].v);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
const shot = (page, name) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }) : Promise.resolve());
const run = String(Date.now()).slice(-7);
const TITLE = `Тестовая новость ${run}`;
const SLUG = `testovaya-novost-${run}`;

const login = async (page, email) => {
  await page.goto(ADMIN + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Пароль").fill(PW);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 });
};
const pub = (path) => fetch(SITE + path, { redirect: "manual" });

// A JPEG that carries an author name and GPS in EXIF.
const dir = join(tmpdir(), `bbnews-${run}`);
mkdirSync(dir, { recursive: true });
const jpg = join(dir, "photo.jpg");
writeFileSync(jpg, await sharp({ create: { width: 900, height: 500, channels: 3, background: { r: 20 + (Number(run) % 200), g: 80, b: 120 } } }).jpeg().withExif({ IFD0: { Artist: "Ivan Ivanov Private" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 15/1 0/1" } }).toBuffer());

console.log("## editor creates, uploads, publishes");
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await login(page, "editor@qa.test");
const nav = (await page.locator("nav[aria-label=Разделы]").innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
ok(JSON.stringify(nav) === JSON.stringify(["Обзор", "Новости", "Мой пароль"]), `the editor sees only: ${nav.join(", ")}`);

await page.goto(ADMIN + "/news/media", { waitUntil: "networkidle" });
await page.locator('input[type=file]').setInputFiles(jpg);
await page.locator('input[name=alt]').fill("Розовый фон для теста");
await page.getByRole("button", { name: "Загрузить" }).click();
await page.waitForURL(/notice=uploaded/);
const imgId = await scalar("SELECT id AS v FROM bb.news_images WHERE alt = 'Розовый фон для теста' ORDER BY created_at DESC LIMIT 1");
const stored = (await pool.query("SELECT data, mime FROM bb.news_images WHERE id = $1", [imgId])).rows[0];
ok(stored.mime === "image/webp" && !stored.data.includes(Buffer.from("Ivan Ivanov Private")) && !stored.data.includes(Buffer.from("EXIF")), "the stored picture is WebP with no EXIF / author text");
await page.locator('input[type=file]').setInputFiles({ name: "evil.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') });
await page.locator('input[name=alt]').fill("svg");
await page.getByRole("button", { name: "Загрузить" }).click();
await page.waitForURL(/error=file/);
ok(true, "an SVG upload is refused");

await page.goto(ADMIN + "/news/new", { waitUntil: "networkidle" });
await page.locator("select[name=kind]").selectOption("news");
await page.locator("input[name=title]").fill(TITLE);
await page.locator("input[name=slug]").fill(SLUG);
await page.locator("textarea[name=excerpt]").fill("Краткое описание <b>без</b> разметки");
await page.locator("textarea[name=body]").fill(`## Подзаголовок\n\nТекст с <script>window.__xss=1</script> и [плохая](javascript:window.__xss=2) и [хорошая](https://example.com).\n\n- пункт один\n- пункт **два**\n\n![](img:${imgId})`);
await page.locator("select[name=coverImageId]").selectOption(imgId);
await page.getByRole("button", { name: "Сохранить как черновик" }).click();
await page.waitForURL(/\/news\/[0-9a-f-]{36}\?notice=created/);
const postId = page.url().match(/news\/([0-9a-f-]{36})/)[1];
ok((await page.locator("section[aria-label=Предпросмотр]").innerText()).includes("пункт один"), "the admin preview renders the text");
const draft = await pub(`/news/${SLUG}`);
ok(draft.status === 404, "a DRAFT is not reachable on the public site (404)");
ok((await pub(`/news/img/${imgId}`)).status === 404, "a picture used only by a draft is not public");
ok(!(await (await pub("/news")).text()).includes(TITLE), "the draft is not in the public list");
ok(!(await (await pub("/sitemap.xml")).text()).includes(SLUG), "the draft is not in the sitemap");

await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
await page.waitForURL(/notice=published/);
await page.waitForTimeout(1200); // the platform tells the site to refresh

console.log("## public site (390x844)");
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pp = await mctx.newPage();
const perrs = [];
pp.on("pageerror", (e) => perrs.push(String(e)));
await pp.goto(SITE + "/news", { waitUntil: "networkidle" });
ok((await pp.locator("main, body").first().innerText()).includes(TITLE), "the published post is in the public list");
ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the list fits a phone without sideways scroll");
await shot(pp, "news-390-list");
await pp.goto(`${SITE}/news/${SLUG}`, { waitUntil: "networkidle" });
const html = await pp.content();
ok((await pp.locator("h1").innerText()) === TITLE, "the post page shows the title");
ok(await pp.evaluate(() => window.__xss === undefined), "no script from the text was executed");
ok((await pp.locator("article").innerText()).includes("<script>window.__xss=1</script>"), "tags in the text are shown as plain text");
const hrefs = await pp.locator("article a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
ok(!hrefs.some((h) => /javascript:/i.test(h ?? "")) && hrefs.includes("https://example.com"), "the javascript: link is dropped, the https link stays");
ok(await pp.locator('article img[src^="/news/img/"]').evaluateAll((is) => is.length >= 2 && is.every((i) => i.complete && i.naturalWidth > 0)), "cover and inline picture load through the site");
const meta = await pp.evaluate(() => ({
  canonical: document.querySelector('link[rel=canonical]')?.href,
  ogTitle: document.querySelector('meta[property="og:title"]')?.content,
  ogImage: document.querySelector('meta[property="og:image"]')?.content,
  ogType: document.querySelector('meta[property="og:type"]')?.content,
  desc: document.querySelector('meta[name=description]')?.content,
  ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent).find((t) => t.includes('NewsArticle')),
}));
ok(meta.canonical?.endsWith(`/news/${SLUG}`) && meta.ogType === "article" && meta.ogTitle?.includes(TITLE) && meta.ogImage?.includes("/news/img/"), "canonical, Open Graph (article, cover) are set");
ok(meta.desc === "Краткое описание <b>без</b> разметки", "the description is the excerpt as plain text (escaped by React)");
const ld = JSON.parse(meta.ld);
if (process.env.E2E_DEBUG) console.log(JSON.stringify(ld));
ok(ld["@type"] === "NewsArticle" && ld.headline === TITLE && ld.datePublished && ld.mainEntityOfPage.endsWith(`/news/${SLUG}`), "valid NewsArticle JSON-LD");
void html;
ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the post fits a phone without sideways scroll");
await shot(pp, "news-390-post");
ok((await (await pub("/sitemap.xml")).text()).includes(`/news/${SLUG}`), "the published post is in the sitemap");
const imgBytes = Buffer.from(await (await pub(`/news/img/${imgId}`)).arrayBuffer());
ok(imgBytes.length > 100 && !imgBytes.includes(Buffer.from("Ivan Ivanov Private")), "the public picture carries no author data");
ok(perrs.length === 0, "no JavaScript errors on the public pages");

console.log("## edit and takedown");
await page.locator("input[name=title]").fill(TITLE + " (обновлено)");
await page.getByRole("button", { name: "Сохранить", exact: true }).click();
await page.waitForURL(/notice=saved/);
await page.waitForTimeout(1200);
await pp.goto(`${SITE}/news/${SLUG}`, { waitUntil: "networkidle" });
ok((await pp.locator("h1").innerText()).endsWith("(обновлено)"), "an edit shows on the public page (cache refreshed by the platform)");
ok((await page.locator("input[name=slug]").getAttribute("readonly")) !== null, "the address of a published page is read-only");

await page.getByRole("button", { name: "Снять с публикации" }).click();
await page.waitForURL(/notice=unpublished/);
await page.waitForTimeout(1200);
ok((await pub(`/news/${SLUG}`)).status === 404, "after takedown the page is gone at once (404)");
ok((await pub(`/news/img/${imgId}`)).status === 404, "and its picture is no longer public");
ok(!(await (await pub("/news")).text()).includes(TITLE), "and it left the public list");
ok(!(await (await pub("/sitemap.xml")).text()).includes(SLUG), "and the sitemap");
ok((await scalar("SELECT status AS v FROM bb.news_posts WHERE id = $1", [postId])) === "archived", "the post stays in the admin as archived");

await page.getByRole("button", { name: "Удалить навсегда" }).click();
await page.waitForURL(/\/news\?notice=deleted/);
ok((await scalar("SELECT count(*) AS v FROM bb.news_posts WHERE id = $1", [postId])) === "0", "an unpublished post can be deleted");
ok(errs.length === 0, "no JavaScript errors in the admin");

console.log("## the admin on a phone and other roles");
const actx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const ap = await actx.newPage();
await login(ap, "editor@qa.test");
await ap.goto(ADMIN + "/news/new", { waitUntil: "networkidle" });
ok(await ap.evaluate(() => scrollX === 0 && innerWidth === 390 && document.documentElement.scrollWidth <= 390), "the editor form fits a phone");
await shot(ap, "news-admin-390-new");
await ap.goto(ADMIN + "/news/media", { waitUntil: "networkidle" });
ok(await ap.evaluate(() => document.documentElement.scrollWidth <= 390), "the media page fits a phone");
await actx.close();
{
  const c = await browser.newContext();
  const p = await c.newPage();
  await login(p, "manager@qa.test");
  await p.goto(ADMIN + "/news", { waitUntil: "networkidle" });
  ok(new URL(p.url()).pathname === "/", "the manager is sent away from the news admin");
  const r = await c.request.post(ADMIN + "/api/media", { headers: { origin: ADMIN }, multipart: { alt: "x", file: { name: "a.jpg", mimeType: "image/jpeg", buffer: await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer() } } });
  ok(r.status() === 403, "the manager cannot upload (403)");
  const r2 = await c.request.get(ADMIN + `/api/media/${imgId}`);
  ok(r2.status() === 401, "the manager cannot read admin pictures (401)");
  await c.close();
}
{
  const r = await fetch(ADMIN + "/api/media", { method: "POST", redirect: "manual" });
  ok(r.status !== 200 && r.status !== 303 || r.headers.get("location")?.includes("/login") === true, "anonymous upload is refused");
}
await mctx.close();
await ctx.close();
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
process.exit(fails ? 1 : 0);
