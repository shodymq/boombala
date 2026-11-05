/**
 * Browser smoke test for the public legal pages. Localhost only: it must use a local
 * site connected to a synthetic/local platform database, never Production.
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server: " + BASE);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (condition, message) => {
  console.log(condition ? "  ok  " : "  FAIL", message);
  if (!condition) fails++;
};

async function checkPage(path, checks) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const response = await page.goto(BASE + path, { waitUntil: "networkidle" });
  ok(response?.status() === 200, `${path}: HTTP 200`);
  await checks(page);
  ok(errors.length === 0, `${path}: no browser JavaScript errors`);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path}: no horizontal overflow at 390px`);
  await context.close();
}

console.log("## /rules");
await checkPage("/rules", async (page) => {
  ok(/Правила посещения Boom Bala/.test(await page.locator("h1").innerText()), "/rules: descriptive heading");
  ok(await page.getByRole("tab", { name: "Русский" }).getAttribute("aria-selected") === "true", "/rules: Russian tab is selected initially");
  ok(await page.locator('article[lang="ru"] h2').count() === 9, "/rules: all 9 Russian sections are rendered as headings");
  ok(!(await page.locator("article").innerText()).match(/(^|\n)#{2,3}\s/m), "/rules: no raw Markdown heading syntax is visible");
  ok(await page.locator('a[href="/legal/boom-bala-rules-v1.3-ru-kk.pdf"]').count() === 2, "/rules: official PDF can be opened and downloaded");
  await page.getByRole("tab", { name: "Қазақша" }).click();
  ok(await page.locator('article[lang="kk"] h2').count() === 9, "/rules: all 9 Kazakh sections are rendered as headings");
  ok((await page.locator('article[lang="kk"]').innerText()).includes("Boom Bala"), "/rules: Kazakh text is displayed");
});

console.log("## /personal-data-consent");
await checkPage("/personal-data-consent", async (page) => {
  ok(/Согласие на обработку персональных данных/.test(await page.locator("h1").innerText()), "/personal-data-consent: descriptive heading");
  ok(await page.locator("text=Опубликованная редакция").count() === 1, "/personal-data-consent: published edition is shown");
  ok(await page.locator('article[lang="ru"]').count() === 1 && (await page.locator('article[lang="ru"]').innerText()).trim().length > 0, "/personal-data-consent: Russian text is rendered");
  ok(!(await page.locator("article").innerText()).match(/(^|\n)#{2,3}\s/m), "/personal-data-consent: no raw Markdown syntax is visible");
  ok(await page.getByRole("tab", { name: "Қазақша" }).count() === 1, "/personal-data-consent: Kazakh tab is available");
  await page.getByRole("tab", { name: "Қазақша" }).click();
  ok(await page.locator('article[lang="kk"]').count() === 1 && (await page.locator('article[lang="kk"]').innerText()).trim().length > 0, "/personal-data-consent: Kazakh text is rendered");
  const legalNav = page.locator('main nav[aria-label="Юридические документы"]');
  ok(await legalNav.locator('a[href="/rules"]').count() === 1 && await legalNav.locator('a[href="/privacy"]').count() === 1, "/personal-data-consent: links to Rules and Privacy are present");
});

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
process.exit(fails ? 1 : 0);
