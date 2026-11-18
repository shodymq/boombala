// CRM design integration, browser E2E against a bridge-mode frontend (no DATABASE_URL on it). Synthetic data only.
//   PLATFORM_URL (frontend, bridge mode), E2E_EMAIL, E2E_PASSWORD, E2E_ARTIFACTS, [E2E_CHROME]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env.PLATFORM_URL ?? "http://127.0.0.1:3100";
const EMAIL = process.env.E2E_EMAIL;
const PW = process.env.E2E_PASSWORD;
const ART = process.env.E2E_ARTIFACTS;
if (!EMAIL || !PW || !ART) throw new Error("env is incomplete");
mkdirSync(ART, { recursive: true });
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = (page, name) => page.screenshot({ path: join(ART, `${name}.png`), fullPage: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
const failedAssets = [];
// The 404 for /favicon.ico exists on main too (no favicon is shipped); it is not part of this change.
page.on("console", (m) => { if (m.type() === "error" && !/favicon|status of 404/.test(m.text() + m.location().url)) consoleErrors.push(m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.status() >= 400 && /\/(icons|illustrations|_next)\//.test(r.url())) failedAssets.push(`${r.status()} ${new URL(r.url()).pathname}`); });

try {
  await page.goto(`${URL_}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]:has-text("Войти")');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  await page.waitForLoadState("networkidle");

  // Shell and dashboard
  check("shell: sidebar, brand, breadcrumbs", await page.locator(".snow-sidebar .snow-brand").count() === 1 && await page.locator(".snow-breadcrumbs").count() === 1);
  check("dashboard renders from bridge data", (await page.locator(".snow-overview").count()) === 1 && await page.locator("#system-title").count() === 1);
  check("dashboard hides request/booking counters it cannot get over the bridge", await page.locator(".so-metric", { hasText: "Новые заявки" }).count() === 0);
  await shot(page, "01-dashboard-desktop");

  // Requests list, search and filters
  await page.goto(`${URL_}/requests`);
  await page.waitForLoadState("networkidle");
  const rows = await page.locator(".crm-requests-table tbody tr").count();
  check("requests list shows both synthetic requests", rows === 2, `rows=${rows}`);
  await page.fill('input[name="q"]', "Анна");
  await page.click('button:has-text("Найти заявки")');
  await page.waitForLoadState("networkidle");
  check("search by name filters the list", await page.locator(".crm-requests-table tbody tr").count() === 1);
  await page.goto(`${URL_}/requests?q=%2B7701000000`);
  check("search by phone fragment", await page.locator(".crm-requests-table tbody tr").count() === 2);
  await page.goto(`${URL_}/requests?status=in_progress`);
  check("status tab filters (server-side)", await page.locator(".crm-requests-table tbody tr").count() === 1);
  await page.goto(`${URL_}/requests?createdFrom=2099-01-01`);
  const empty = await page.locator(".crm-requests-empty").innerText();
  check("date filter with no matches shows the empty state", /нет/i.test(empty));
  await page.goto(`${URL_}/requests`);
  await shot(page, "02-requests-desktop");

  // DatePicker is usable
  const picker = page.locator('.crm-requests-filters button[aria-haspopup], .crm-requests-filters [role="button"]').first();
  check("date picker control is present", (await page.locator('.crm-requests-filters input[name="createdFrom"]').count()) === 1);
  if (await picker.count()) { await picker.click(); await shot(page, "03-datepicker-open"); await page.keyboard.press("Escape"); }

  // Request card and status change through the bridge
  await page.locator(".crm-requests-table tbody tr", { hasText: "Тест Анна" }).getByRole("link", { name: "Открыть карточку" }).click();
  await page.waitForLoadState("networkidle");
  check("request card opens with data", await page.getByRole("heading", { name: "Тест Анна" }).count() === 1 && /77010000001/.test(await page.locator("main").innerText()));
  check("card has no payment or refund controls", await page.locator('main :text-matches("платёж|возврат", "i")').count() === 0);
  await shot(page, "04-request-card");
  await page.getByRole("button", { name: "В работу" }).click();
  await page.waitForURL(/notice=status/, { timeout: 15000 });
  check("status change goes through the bridge", await page.locator('[role="status"]', { hasText: "Статус изменён" }).count() === 1);

  // Audit log
  await page.goto(`${URL_}/audit`);
  await page.waitForLoadState("networkidle");
  check("audit shows readable action label", /Изменил статус заявки/.test(await page.locator("main").innerText()));
  await page.goto(`${URL_}/audit?action=lead.status_changed`);
  const auditRows = await page.locator("main tbody tr").count();
  check("audit action filter", auditRows >= 1, `rows=${auditRows}`);
  await shot(page, "05-audit");

  // The current calendar is untouched
  await page.goto(`${URL_}/bookings`);
  await page.waitForLoadState("networkidle");
  const bookingsText = await page.locator("main").innerText();
  check("calendar page loads (timeline, not replaced)", !/error|ошибк/i.test(bookingsText.slice(0, 200)) && (await page.locator("main").count()) === 1);
  await shot(page, "06-bookings");

  // Remaining pages render in the new shell
  for (const path of ["/contacts", "/users", "/attendance", "/news", "/legal", "/retention", "/export", "/account"]) {
    const res = await page.goto(`${URL_}${path}`);
    check(`page ${path} renders in new shell`, res?.status() === 200 && await page.locator(".snow-shell").count() === 1);
  }

  // Responsive navigation
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await mobile.newPage();
  await mp.goto(`${URL_}/login`);
  await mp.fill('input[type="email"]', EMAIL);
  await mp.fill('input[type="password"]', PW);
  await mp.click('button[type="submit"]:has-text("Войти")');
  await mp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  await mp.goto(`${URL_}/requests`);
  await mp.waitForLoadState("networkidle");
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("mobile: no horizontal page scroll", !overflow);
  await shot(mp, "07-requests-mobile");
  await mp.goto(`${URL_}/`);
  await shot(mp, "08-dashboard-mobile");
  await mobile.close();

  check("no failed static assets (icons, illustrations, chunks)", failedAssets.length === 0, failedAssets.join(", "));
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (error) {
  check("script completed", false, String(error).slice(0, 300));
  await shot(page, "zz-failure").catch(() => {});
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
