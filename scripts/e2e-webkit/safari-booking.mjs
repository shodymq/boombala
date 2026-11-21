/**
 * WebKit (Safari engine) scenario for the birthday booking form on the integration stand.
 * Localhost only. Leads go to the mock Telegram on :4010 (named "ТЕСТ"). No real manager is contacted.
 *   BASE_URL=http://localhost:3000 node scripts/e2e-webkit/safari-booking.mjs
 */
import { webkit, devices } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";

const BASE = process.env.BASE_URL || "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing non-local base: " + BASE);
const OUT = process.env.OUT_DIR || "/tmp/safari-webkit";
mkdirSync(OUT, { recursive: true });

const sent = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try { sent.push(JSON.parse(body).text ?? ""); } catch {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
});
await new Promise((r) => mock.listen(4010, "127.0.0.1", r));

const results = [];
const RUN = String(Math.floor(Math.random() * 90000) + 10000);
const PHONE = `7071${RUN}`;
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"], locale: "ru-RU" });
const page = await ctx.newPage();
const consoleErrors = [];
const serverErrors = [];
let expectInjectedError = false;
page.on("response", (r) => r.status() >= 500 && !expectInjectedError && serverErrors.push(`${r.status()} ${r.url()}`));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

try {
  // 1. RU page and comparison
  await page.goto(`${BASE}/birthdays`, { waitUntil: "networkidle" });
  const body = await page.textContent("body");
  check("RU page renders packages", /HAPPY PARTY/i.test(body) && /STAR PARTY/i.test(body) && /BOOM BALA PARTY/i.test(body));
  check("RU prices shown (weekend)", /54\D?900/.test(body) && /79\D?900/.test(body) && /114\D?900/.test(body));
  check("RU comparison table exists", (await page.locator("table").count()) > 0);
  check("cake note present (not included)", body.includes("Торт в стоимость ни одного пакета не входит"));
  await page.screenshot({ path: `${OUT}/01-ru-birthdays.png`, fullPage: false });

  // 2. Open the form from a package CTA
  await page.getByRole("button", { name: /свободной дате/i }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10000 });
  check("form opens", await dialog.isVisible());

  // 3. Empty submit shows validation
  await dialog.getByRole("button", { name: "Отправить заявку" }).click();
  const errs = await dialog.textContent();
  check("empty submit shows name/phone/date errors", /Укажите имя/.test(errs) && /Укажите телефон/.test(errs) && /Выберите дату/.test(errs));

  // 4. Fill with Cyrillic (Playwright sends text, no keyboard layout involved)
  await dialog.locator('input[name="name"]').fill("Айгуль Тестова");
  await dialog.locator('input[name="phone"]').fill(PHONE);
  await dialog.locator('input[name="date"]').fill("2099-03-04");
  await dialog.locator('input[name="children"]').fill("7");
  // Package listbox: open the trigger (shows the current choice), then pick STAR PARTY. A failed pick must fail the run.
  await dialog.getByRole("combobox").filter({ hasText: /Ещё не определились|STAR|BOOM|HAPPY/i }).first().click();
  await dialog.getByRole("option", { name: /STAR PARTY/i }).click();
  check("package picked in listbox", /STAR PARTY/i.test(await dialog.textContent()));
  await dialog.locator('input[name="consent"]').check();
  // Wished start time: a native select with one-hour steps (not a booking slot).
  const timeSelect = dialog.locator('select[name="preferredStartTime"]');
  check("wished start select offers 10:00–22:00 hourly (13 values)", (await timeSelect.locator("option").count()) === 14, "13 times + placeholder");
  await timeSelect.selectOption("15:00");
  check("wished start 15:00 is selected", (await timeSelect.inputValue()) === "15:00");
  check("fields filled", (await dialog.locator('input[name="name"]').inputValue()) === "Айгуль Тестова");
  await page.screenshot({ path: `${OUT}/02-ru-form-filled.png` });

  // 5. Submit -> success state
  await dialog.getByRole("button", { name: "Отправить заявку" }).click();
  await page.getByText("Заявка отправлена", { exact: false }).first().waitFor({ timeout: 20000 });
  check("success state shown", true);
  await page.screenshot({ path: `${OUT}/03-ru-success.png` });
  await page.waitForTimeout(3000);
  const header = sent.length ? sent.at(-1).split("\n")[0] : "";
  check("Telegram title names the chosen package (STAR PARTY), not the CTA", /НОВАЯ ЗАЯВКА — STAR PARTY$/.test(header), header);
  check("Telegram carries the exact wish 'Желаемое начало: 15:00'", sent.some((t) => t.includes("Желаемое начало: 15:00")), sent.length ? "" : "no message");
  check("Telegram does not show a legacy slot for a wish-only enquiry", !sent.some((t) => t.includes("Желаемое начало: 15:00") && t.includes("Предпочитаемый слот")));
  check("mock Telegram received the lead (package and name)", sent.some((t) => /STAR PARTY/i.test(t) && /Айгуль/.test(t)), sent.length ? sent[0].slice(0, 400).replace(/\n/g, " | ") : "no message");

  // 6. Error state: the lead API answers 502 (delivery failed)
  await page.reload({ waitUntil: "networkidle" });
  expectInjectedError = true;
  await page.route("**/api/lead", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "delivery_failed" }) }));
  await page.getByRole("button", { name: /свободной дате/i }).filter({ visible: true }).first().click();
  const d2 = page.getByRole("dialog");
  await d2.waitFor({ timeout: 10000 });
  await d2.locator('input[name="name"]').fill("Тест Ошибка");
  await d2.locator('input[name="phone"]').fill(`7072${RUN}`);
  await d2.locator('input[name="date"]').fill("2099-03-05");
  await d2.locator('input[name="consent"]').check();
  await d2.getByRole("button", { name: "Отправить заявку" }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 15000 });
  const alertText = await page.getByRole("alert").first().textContent();
  check("error state shown (not a false success)", !/Заявка отправлена/.test(alertText) && alertText.trim().length > 0, alertText.trim().slice(0, 120));
  await page.unroute("**/api/lead");
  expectInjectedError = false;
  await page.screenshot({ path: `${OUT}/04-ru-error.png` });

  // 7. KZ page
  await page.goto(`${BASE}/kk/birthdays`, { waitUntil: "networkidle" });
  const kz = await page.textContent("body");
  check("KZ page renders and uses KZ copy", kz.includes("Торт ешбір пакеттің құнына кірмейді") && /STAR PARTY/i.test(kz));
  await page.screenshot({ path: `${OUT}/05-kk-birthdays.png` });
} catch (e) {
  check("scenario completed without exception", false, String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT}/99-failure.png` }).catch(() => {});
} finally {
  check("no unexpected 5xx responses (the injected 502 in step 6 is expected)", serverErrors.length === 0, serverErrors.slice(0, 3).join(" | "));
  check("no uncaught console errors", consoleErrors.filter((e) => !/favicon|GA|gtag|analytics/i.test(e)).length === 0, consoleErrors.slice(0, 3).join(" | "));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, engine: "webkit", device: "iPhone 15 Pro", results, sent: sent.length }, null, 2));
  await browser.close();
  mock.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSUMMARY ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
