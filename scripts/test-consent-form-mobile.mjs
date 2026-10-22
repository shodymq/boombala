/**
 * Browser check of the QR registration page /consent with PUBLISHED documents (the working form, not the preview).
 * Real Chromium with phone/desktop emulation. It is NOT Safari and NOT a real phone.
 *
 * Needs a local stack with synthetic data only: the platform on :3100 (local database, published visit_rules and
 * personal_data_consent documents) and the site on :3000 with CONSENT_FORM_ENABLED=1, PLATFORM_URL, PLATFORM_INTAKE_TOKEN
 * (see platform/README.md; the release e2e prepares the documents). Registrations are named "ТЕСТ QR форма …".
 *
 *   npm run test:consent-form        # E2E_CHROME=/path/to/chrome if not at the default macOS location
 *
 * Safety: localhost only; nothing here talks to a real server or sends a real message.
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Refusing to run against a non-local server: " + BASE);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const PROFILES = [
  { name: "iPhone 375x812", w: 375, h: 812, mobile: true },
  { name: "iPhone 390x844", w: 390, h: 844, mobile: true },
  { name: "Android 360x800", w: 360, h: 800, mobile: true },
  { name: "Small 320x568", w: 320, h: 568, mobile: true },
  { name: "Desktop 1440x900", w: 1440, h: 900, mobile: false },
];

const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (cond, msg) => {
  console.log(cond ? "  ok  " : "  FAIL", msg);
  if (!cond) fails++;
};
const run = Date.now().toString(36);
const phone10 = () => String(7000000000 + Math.floor(Math.random() * 99999999)).slice(0, 10);

for (const prof of PROFILES) {
  console.log(`## ${prof.name}`);
  const ctx = await browser.newContext({ viewport: { width: prof.w, height: prof.h }, isMobile: prof.mobile, hasTouch: prof.mobile, locale: "en-US" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const posts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/consent")) posts.push(JSON.parse(r.postData() || "{}"));
  });

  await page.goto(BASE + "/consent", { waitUntil: "networkidle" });
  const main = await page.locator("main").innerText();
  ok(/ИП Аманов/.test(main), "the operator (ИП Аманов) is named on the page");
  ok(/не означает посещение/.test(main) && !/Количество детей/.test(main), "the page says registration is not a visit and asks no children count");
  ok((await page.locator("form").count()) === 1 && (await page.locator('input[name="name"]').count()) === 1, "the working form is shown (not the non-collecting preview)");
  const cards = await page.locator("details[data-doc-kind]").evaluateAll((ds) => ds.map((d) => ({ kind: d.dataset.docKind, head: d.querySelector("summary")?.textContent ?? "" })));
  ok(cards.length >= 2 && cards.every((c) => /редакция \d+/.test(c.head)), `every document card shows its title and edition (${cards.map((c) => c.kind).join(", ")})`);
  const versions = Object.fromEntries(cards.map((c) => [c.kind, Number(/редакция (\d+)/.exec(c.head)[1])]));
  const sectionTitles = await page.locator("form h2").allInnerTexts();
  ok(sectionTitles.length === 3 && /Ваши данные/.test(sectionTitles[0]) && /Документы/.test(sectionTitles[1]) && /Подтверждения/.test(sectionTitles[2]), "three sections: data, documents, confirmations");
  ok((await page.locator('form input[type="checkbox"]').count()) === 2, "two SEPARATE confirmations: rules and personal-data consent");
  ok(/необязательно/i.test(await page.locator("form").innerText()) && !(await page.locator('input[type="tel"]').evaluate((e) => e.required)), "the phone is optional");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");
  const kids = page.locator('input[name="childrenCount"]');
  const plus = page.getByRole("button", { name: "Увеличить количество детей" });
  const minus = page.getByRole("button", { name: "Уменьшить количество детей" });
  ok((await kids.inputValue()) === "1" && (await minus.isDisabled()), "the children counter starts at 1 and − is disabled");
  const stepBoxes = [await minus.boundingBox(), await plus.boundingBox()];
  ok(stepBoxes.every((b) => b && b.width >= 44 && b.height >= 44), "− and + are at least 44px");
  await plus.click();
  await plus.click();
  ok((await kids.inputValue()) === "3", "+ twice gives 3");
  await minus.click();
  await minus.click();
  ok((await kids.inputValue()) === "1", "− back to 1");
  ok(!/имена детей|даты рождения детей/i.test(await page.locator("form label").allInnerTexts().then((t) => t.join(" "))), "no field for the children's names or birth dates");

  // the full text of a document opens and is readable
  const first = page.locator("details[data-doc-kind]").first();
  await first.locator("summary").click();
  const region = first.locator('[role="region"]');
  ok((await region.isVisible()) && (await region.innerText()).trim().length > 0, "the full document text opens in the card");
  ok((await region.evaluate((e) => e.getBoundingClientRect().right <= innerWidth + 1)), "the opened text stays inside the screen");
  await first.locator("summary").click();

  // controls are big enough
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('form input:not([tabindex="-1"]), form button, form summary')]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => ({ t: e.tagName + (e.name ? `[${e.name}]` : ""), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((x) => (x.t.startsWith("INPUT[accept") ? x.h < 24 : x.h < 44)),
  );
  ok(small.length === 0, `inputs, buttons and summaries are tall enough${small.length ? ": " + JSON.stringify(small) : ""}`);

  // empty submit: nothing is sent, errors are shown, focus goes to the first problem
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.waitForTimeout(300);
  const formText = await page.locator("form").innerText();
  ok(posts.length === 0, "an empty form sends nothing");
  ok(/Укажите имя/.test(formText) && /Подтвердите, что ознакомились/.test(formText) && /Необходимо согласие/.test(formText), "errors for name and for each confirmation");
  ok(await page.evaluate(() => document.activeElement?.getAttribute("name") === "name"), "focus moves to the first invalid field");
  ok((await page.locator('form [aria-invalid="true"]').count()) === 3, "invalid fields are marked aria-invalid");

  // wrong phone
  const NAME = `ТЕСТ QR форма ${run} ${prof.w}`;
  await page.locator('input[name="name"]').fill(NAME);
  await page.locator('input[type="tel"]').fill("123");
  await page.locator('input[name="acceptRules"]').check();
  await page.locator('input[name="acceptPersonalData"]').check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.waitForTimeout(300);
  ok(/10 цифр/.test(await page.locator("form").innerText()) && posts.length === 0, "a wrong phone is refused in the browser and nothing is sent");
  await page.locator('input[type="tel"]').fill(phone10());

  // a failed send keeps the input; the retry is the SAME registration (same key)
  let calls = 0;
  await page.route("**/api/consent", (route) => {
    calls += 1;
    return calls === 1 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "unavailable" }) }) : route.continue();
  });
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось сохранить" }).waitFor({ timeout: 8000 });
  ok(true, "a failed send says so and promises no duplicate");
  ok((await page.locator('input[name="name"]').inputValue()) === NAME && (await page.locator('input[name="acceptRules"]').isChecked()), "the input and the confirmations are kept after a failure");
  ok(await page.getByRole("button", { name: "Попробовать снова" }).isVisible(), "the button now reads «Попробовать снова»");
  await page.getByRole("button", { name: "Попробовать снова" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  ok(true, "the retry is accepted");
  ok(posts.length === 2 && posts[0].idempotencyKey === posts[1].idempotencyKey, "the retry carries the same idempotency key (cannot create a second registration)");
  ok(posts[1].childrenCount === 1 && typeof posts[1].childrenCount === "number", "the request carries the number of children");
  ok(posts[1].documentVersions && Object.keys(versions).every((k) => posts[1].documentVersions[k] === versions[k]), "the request names the editions that were shown");
  const done = await page.locator("main").innerText();
  ok(Object.keys(versions).every((k) => cards.find((c) => c.kind === k) && done.includes(`редакция ${versions[k]}`)) && /не бронирование и не отметка о посещении/.test(done), "the confirmation lists the accepted editions and says it is not a visit");
  ok(errs.length === 0, "no JavaScript errors");
  await ctx.close();
}

console.log("## double tap, changed documents, server-side edition check");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const posts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/consent")) posts.push(JSON.parse(r.postData() || "{}"));
  });
  await page.goto(BASE + "/consent", { waitUntil: "networkidle" });
  const versions = await page.locator("details[data-doc-kind]").evaluateAll((ds) => Object.fromEntries(ds.map((d) => [d.dataset.docKind, Number(/редакция (\d+)/.exec(d.querySelector("summary").textContent)[1])])));
  await page.locator('input[name="name"]').fill(`ТЕСТ QR форма дубль ${run}`);
  await page.locator('input[name="acceptRules"]').check();
  await page.locator('input[name="acceptPersonalData"]').check();
  const btn = page.getByRole("button", { name: "Зарегистрироваться" });
  await btn.dblclick();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  ok(posts.length === 1, `a double tap sends ONE request (${posts.length})`);

  // the documents change under the visitor: the server refuses, the page says so, nothing is saved
  await page.goto(BASE + "/consent", { waitUntil: "networkidle" });
  await page.route("**/api/consent", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "documents_changed" }) }));
  await page.locator('input[name="name"]').fill(`ТЕСТ QR форма смена ${run}`);
  await page.locator('input[name="acceptRules"]').check();
  await page.locator('input[name="acceptPersonalData"]').check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Документы были обновлены").first().waitFor({ timeout: 8000 });
  ok((await page.getByText("Регистрация сохранена").count()) === 0, "documents changed: the page does not claim a saved registration");
  await ctx.close();

  const send = (documentVersions) =>
    fetch(BASE + "/api/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `ТЕСТ QR форма сервер ${run}`, childrenCount: 1, acceptRules: true, acceptPersonalData: true, idempotencyKey: crypto.randomUUID(), documentVersions }),
    });
  const stale = await send({ ...versions, personal_data_consent: 9999 });
  ok(stale.status === 409 && (await stale.json()).error === "documents_changed", "the server refuses a registration for an edition that is no longer published (409)");
  const missing = await send({ personal_data_consent: versions.personal_data_consent });
  ok(missing.status === 409, "the server refuses when a shown document is missing from the list");
  const fine = await send(versions);
  ok(fine.status === 200, "the server accepts the editions that are published");
  const garbage = await send("x");
  ok(garbage.status === 400, "a malformed edition list is a 400");
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
process.exit(fails ? 1 : 0);
