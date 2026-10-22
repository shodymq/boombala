// Cross-app check of the birthday booking flow in a real browser: public calendar -> enquiry -> admin confirmation -> grid.
//   SITE_URL=http://localhost:3000 PLATFORM_URL=http://localhost:3100 DATABASE_URL=... E2E_PASSWORD=... PLATFORM_INTAKE_TOKEN=... npm run e2e:booking
// Needs: platform (PII_INTAKE_ENABLED=1, mock Telegram), the site with NEXT_PUBLIC_BOOKING_CALENDAR=1 LEAD_PIPELINE=dual
// PLATFORM_URL/PLATFORM_INTAKE_TOKEN, a published personal_data_consent document, QA users, migrated + seeded database.
import { mkdirSync } from "node:fs";
import pg from "pg";
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
const shot = (page, name) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png` }) : Promise.resolve());

// Far-future, per-run dates: reservations are history and can never be deleted.
const base = 200 + Math.floor(Math.random() * 400);
const dateAt = (n) => new Date(Date.now() + (base + n) * 864e5).toISOString().slice(0, 10);
const D1 = dateAt(0);
const D2 = dateAt(1);

const login = async (page, email) => {
  await page.goto(ADMIN + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Пароль").fill(PW);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 });
};
const avail = async (date) => (await fetch(`${SITE}/api/availability?date=${date}`)).json();

console.log("## public calendar and enquiry (390x844)");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(SITE + "/birthdays", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Узнать о свободной дате" }).first().click();
  await page.getByLabel("Ваше имя").fill("ТЕСТ Календарь");
  await page.getByLabel(/Телефон/).fill("7071230099");
  await page.getByLabel("Желаемая дата").fill(D1);
  // The package is a native <select> on this branch and a branded combobox once the mobile-form hotfix (PR #5) is merged: handle both.
  if (await page.locator("dialog select[name=package]").count()) await page.locator("dialog select[name=package]").selectOption("wow-party");
  else {
    await page.locator("dialog button[aria-haspopup=listbox]").first().click();
    await page.locator('dialog [role=option][data-value="wow-party"]').click();
  }
  await page.locator('[data-testid=availability]').waitFor();
  await page.locator('[data-slot="2"]').waitFor({ timeout: 8000 });
  const before = await avail(D1);
  ok(before.ok && before.slots.every((s) => s.freeRoomIds.length === 4), "a fresh date: every slot shows 4 free rooms");
  const priceText = (await page.locator("[data-testid=price]").innerText()).replace(/\s+/g, " ");
  const expected = before.prices["wow-party"];
  ok(expected && priceText.includes(String(expected.amountKzt).replace(/\B(?=(\d{3})+(?!\d))/g, " ")) || priceText.replace(/\D/g, "").includes(String(expected.amountKzt)), `price for the chosen date is shown (${priceText})`);
  await page.locator('[data-slot="2"]').click();
  await page.getByText("Посмотреть свободные даты").click();
  await page.locator(`[data-day="${D1}"]`).waitFor({ timeout: 8000 }).catch(() => {});
  await shot(page, "site-390-calendar");
  ok((await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), "the form with the calendar has no sideways scroll on a phone");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await page.getByText("Заявка отправлена").waitFor({ timeout: 10000 });
  ok(true, "the enquiry is accepted without any payment");
  const lead = (await pool.query("SELECT l.id, l.slot_id, l.status, to_char(l.requested_date,'YYYY-MM-DD') d FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = 'ТЕСТ Календарь' ORDER BY l.seq DESC LIMIT 1")).rows[0];
  ok(lead && lead.slot_id === 2 && lead.d === D1 && lead.status === "new", "the enquiry is in the CRM with the preferred slot");
  const after = await avail(D1);
  ok(after.slots.every((s) => s.freeRoomIds.length === 4), "an enquiry does not occupy the slot");
  ok(errs.length === 0, "no JavaScript errors");
  await ctx.close();
}

console.log("## calendar outage: preferred-time fallback, nothing invented, recovery keeps date and interval (390x844)");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let down = true;
  let calls = 0;
  await page.route("**/api/availability**", (route) => {
    calls += 1;
    return down ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "unavailable" }) }) : route.continue();
  });
  await page.goto(SITE + "/birthdays", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Узнать о свободной дате" }).first().click();
  await page.getByLabel("Желаемая дата").fill(D1);
  const outage = page.locator("[data-testid=availability-outage]");
  await outage.waitFor({ timeout: 8000 });
  const text = await outage.innerText();
  ok(text.includes("Предпочитаемое время") && text.includes("Желаемое время. Менеджер подтвердит доступность."), "API down: the preferred-time block is shown with the note");
  ok(!/свободно комнат|занято|₸|\d[\s\u00a0]?\d{3}/i.test(text) && (await page.locator("[data-testid=price]").count()) === 0, "API down: no invented free rooms, busy cells or prices");
  ok((await outage.locator("[role=radio]").allInnerTexts()).map((t) => t.trim()).join("|") === "10:00–14:00|14:00–18:00|18:00–22:00", "API down: three intervals are offered");
  await outage.locator('[data-preferred-slot="2"]').click();
  ok((await outage.locator('[data-preferred-slot="2"]').getAttribute("aria-checked")) === "true", "API down: an interval can be chosen");
  ok((await page.locator('[data-slot]').count()) === 0, "API down: the calendar's own slot buttons are not shown");
  down = false;
  await outage.getByRole("button", { name: "Проверить ещё раз" }).click();
  await page.locator('[data-testid=availability] [data-slot="2"]').waitFor({ timeout: 8000 });
  ok((await page.locator("[data-testid=availability-outage]").count()) === 0, "API back: the full calendar replaces the fallback");
  ok((await page.locator('[data-slot="2"]').getAttribute("aria-checked")) === "true", "API back: the interval chosen during the outage is still selected");
  ok((await page.getByLabel("Желаемая дата").inputValue()) === D1, "API back: the chosen date is kept");
  ok(/свободно комнат: 4/.test(await page.locator('[data-slot="2"]').innerText()), "API back: real availability (4 free rooms) is shown");
  ok(calls >= 2, `the calendar asked the API again after the retry (${calls} calls)`);
  await ctx.close();
}

console.log("## admin: requests, confirmation, grid");
let leadId;
{
  leadId = (await pool.query("SELECT l.id FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = 'ТЕСТ Календарь' ORDER BY l.seq DESC LIMIT 1")).rows[0].id;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, "owner@qa.test");
  await page.goto(ADMIN + "/requests", { waitUntil: "networkidle" });
  const card = page.locator("li", { hasText: "ТЕСТ Календарь" }).first();
  await card.locator('select[name="roomId"]').selectOption({ index: 1 });
  await card.getByRole("button", { name: "Подтвердить бронь" }).click();
  await page.waitForURL(/\/bookings\?date=/, { timeout: 8000 });
  const room = await scalar("SELECT room_id AS v FROM bb.slot_reservations WHERE lead_request_id = $1 AND released_at IS NULL", [leadId]);
  ok(!!room, "the manager's confirmation created the booking");
  const cell = page.locator(`[data-cell="${room}:2"]`);
  ok((await cell.getAttribute("data-state")) === "booked", "the grid shows the cell as booked");
  ok((await cell.innerText()).includes("ТЕСТ Календарь"), "the booked cell names the customer");
  const priceSnap = await scalar("SELECT price_kzt AS v FROM bb.slot_reservations WHERE lead_request_id = $1", [leadId]);
  ok(Number(priceSnap) === (await avail(D1)).prices["wow-party"].amountKzt, "the price is frozen at the price valid for that date");
  const a = await avail(D1);
  ok(a.slots[1].freeRoomIds.length === 3 && a.slots[0].freeRoomIds.length === 4 && a.slots[2].freeRoomIds.length === 4, "public availability now shows exactly that cell as taken (slots touch, no pause)");
  ok((await page.locator("[data-cell]").count()) === 12, "the grid is 4 rooms x 3 slots");
  await shot(page, "admin-1280-grid");
  await ctx.close();
}

console.log("## admin on a phone (390x844)");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, "manager@qa.test");
  await page.goto(`${ADMIN}/bookings?date=${D1}`, { waitUntil: "networkidle" });
  ok(await page.evaluate(() => scrollX === 0 && innerWidth === 390 && document.documentElement.scrollWidth <= 390), "the calendar grid fits a phone without sideways scroll");
  ok((await page.locator("[data-cell]").count()) === 12, "all 12 cells are reachable on a phone");
  const tap = await page.evaluate(() => [...document.querySelectorAll("summary,button,select,input:not([type=hidden])")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).length);
  ok(tap === 0, `every control is at least 40px high (small ones: ${tap})`);
  await shot(page, "admin-390-grid");
  await page.goto(`${ADMIN}/requests`, { waitUntil: "networkidle" });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "the requests list fits a phone");
  await shot(page, "admin-390-requests");
  await ctx.close();
}

console.log("## two managers confirm the same room at the same moment (real browsers)");
{
  const mk = async (d, n) => {
    const r = await fetch(`${ADMIN}/api/intake/lead`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PLATFORM_INTAKE_TOKEN}` },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), name: `ТЕСТ Гонка ${n}`, phone: `+7707000${n}${n}${n}${n}`, date: d, consent: true, packageId: "wow-party", slotId: 3, roomId: "ice-room" }),
    });
    return (await r.json()).leadId;
  };
  const [l1, l2] = [await mk(D2, 1), await mk(D2, 2)];
  const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const b = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [pa, pb] = [await a.newPage(), await b.newPage()];
  await Promise.all([login(pa, "owner@qa.test"), login(pb, "manager@qa.test")]);
  for (const p of [pa, pb]) await p.goto(ADMIN + "/requests", { waitUntil: "networkidle" });
  const confirm = (p, name) => p.locator("li", { hasText: name }).first().getByRole("button", { name: "Подтвердить бронь" });
  await Promise.all([confirm(pa, "ТЕСТ Гонка 1").click(), confirm(pb, "ТЕСТ Гонка 2").click()]);
  await Promise.all([pa.waitForURL(/\/bookings|\/requests/), pb.waitForURL(/\/bookings|\/requests/)]);
  await pa.waitForTimeout(800);
  const rows = await scalar("SELECT count(*) AS v FROM bb.slot_reservations WHERE slot_date = $1 AND slot_id = 3 AND room_id = 'ice-room' AND released_at IS NULL", [D2]);
  ok(rows === "1", "exactly one booking exists for the contested cell");
  const statuses = (await pool.query("SELECT status FROM bb.lead_requests WHERE id = ANY($1) ORDER BY status", [[l1, l2]])).rows.map((r) => r.status).join(",");
  ok(statuses === "confirmed,new", "one enquiry is confirmed, the other stays open");
  const texts = [await pa.locator("body").innerText(), await pb.locator("body").innerText()];
  ok(texts.some((t) => t.includes("уже занят")), "the loser sees a clear 'already taken' message");
  await a.close();
  await b.close();
}

console.log("## the editor cannot reach bookings");
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "editor@qa.test");
  for (const path of ["/bookings", "/requests"]) {
    await page.goto(ADMIN + path, { waitUntil: "networkidle" });
    ok(new URL(page.url()).pathname === "/", `editor is sent away from ${path}`);
  }
  await ctx.close();
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
process.exit(fails ? 1 : 0);
