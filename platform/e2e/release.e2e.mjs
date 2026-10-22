// End-to-end release check on the FULL local stack: public site + platform + database + a Telegram stand-in started by this script.
//   SITE_URL=http://localhost:3000 PLATFORM_URL=http://localhost:3100 DATABASE_URL=... E2E_PASSWORD=... PLATFORM_INTAKE_TOKEN=... CRON_SECRET=... npm run e2e:release
// Stack requirements (see docs/RELEASE-READINESS.md, "Запуск"): platform with PII_INTAKE_ENABLED=1, TELEGRAM_API_BASE=http://127.0.0.1:3199,
// SITE_REVALIDATE_URL; site with LEAD_PIPELINE=dual, NEXT_PUBLIC_BOOKING_CALENDAR=1, NEXT_PUBLIC_NEWS=1, CONSENT_FORM_ENABLED=1,
// PLATFORM_URL, PLATFORM_INTAKE_TOKEN, TELEGRAM_API_BASE=http://127.0.0.1:3199 (the site's own fallback also lands in the stand-in).
// Everything is synthetic; nothing leaves localhost.
import http from "node:http";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { chromium } from "playwright-core";

const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const ADMIN = process.env.PLATFORM_URL ?? "http://localhost:3100";
const PW = process.env.E2E_PASSWORD;
const DB = process.env.DATABASE_URL;
const TOKEN = process.env.PLATFORM_INTAKE_TOKEN;
const CRON = process.env.CRON_SECRET;
const OUT = process.env.E2E_SCREENSHOTS ?? "";
if (!PW || !DB || !TOKEN || !CRON) throw new Error("E2E_PASSWORD, DATABASE_URL, PLATFORM_INTAKE_TOKEN and CRON_SECRET are required");
for (const u of [SITE, ADMIN]) if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) throw new Error("refusing to run against a non-local server: " + u);
if (OUT) mkdirSync(OUT, { recursive: true });

// ── Telegram stand-in (can be switched "down" to prove retries) ──────────────────────────────────────────────
const messages = [];
let telegramDown = false;
const mock = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (telegramDown) return res.writeHead(500).end('{"ok":false}');
    try { messages.push(JSON.parse(b).text ?? ""); } catch { /* ignore */ }
    res.end('{"ok":true}');
  });
});
await new Promise((r, j) => mock.once("error", j).listen(3199, "127.0.0.1", r));

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const q = (sql, p = []) => pool.query(sql, p);
const scalar = async (sql, p = []) => String((await q(sql, p)).rows[0]?.v ?? "");
const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; };
const shot = (page, name) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }) : Promise.resolve());

const run = String(Date.now()).slice(-6);
const base = 300 + Math.floor(Math.random() * 300);
const day = (n) => new Date(Date.now() + (base + n) * 864e5).toISOString().slice(0, 10);
const D = day(0);
const ROOM = "ice-room";
const SLOT = 2;
const phone = (n) => `7070${run.slice(-4)}${n}`.slice(0, 10).padEnd(10, "0");
const avail = async (date) => (await fetch(`${SITE}/api/availability?date=${date}`)).json();
const login = async (page, email) => {
  await page.goto(ADMIN + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Пароль").fill(PW);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 20000 });
};
const newCtx = async (w = 1280, h = 900, mobile = false) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 120)));
  return { ctx, page };
};
const intakeLead = async (name, ph, date) => {
  const r = await fetch(`${ADMIN}/api/intake/lead`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), name, phone: `+7${ph}`, date, consent: true, packageId: "wow-party", slotId: SLOT, roomId: ROOM }),
  });
  return { status: r.status, ...(await r.json()) };
};

// Preconditions: published consent + rules documents (created through the UI of the owner if missing).
async function ensureDocuments() {
  const have = (await q("SELECT kind::text k FROM bb.legal_documents WHERE status = 'published'")).rows.map((r) => r.k);
  if (have.includes("personal_data_consent") && have.includes("visit_rules")) return;
  const { ctx, page } = await newCtx();
  await login(page, "owner@qa.test");
  for (const [kind, title] of [["personal_data_consent", "Согласие (тест)"], ["visit_rules", "Правила (тест)"]]) {
    if (have.includes(kind)) continue;
    await page.goto(ADMIN + "/legal", { waitUntil: "networkidle" });
    await page.locator("form:has(textarea[name=body]) select[name=kind]").first().selectOption(kind);
    await page.locator("form:has(textarea[name=body]) input[name=title]").first().fill(title);
    await page.locator("form:has(textarea[name=body]) textarea[name=body]").first().fill("Синтетический текст для проверки.");
    await page.getByRole("button", { name: "Создать черновик" }).click();
    await page.waitForTimeout(700);
    const v = await scalar("SELECT max(version) v FROM bb.legal_documents WHERE kind = $1", [kind]);
    const card = page.locator("article", { hasText: `редакция ${v}` }).first();
    await card.getByRole("button", { name: "Утвердить" }).click();
    await page.waitForTimeout(700);
    await card.getByRole("button", { name: "Опубликовать" }).click();
    await page.waitForTimeout(700);
  }
  await ctx.close();
}
await ensureDocuments();
const docs = (await q("SELECT kind::text k, version v FROM bb.legal_documents WHERE status = 'published'")).rows;

// ══ 1. Parent sends an enquiry on the site ═════════════════════════════════════════════════════════════════════
console.log("## 1. parent's enquiry: site -> CRM -> Telegram");
const NAME = `ТЕСТ Родитель ${run}`;
const PH = phone(1);
{
  const { ctx, page } = await newCtx(390, 844, true);
  await page.goto(SITE + "/birthdays", { waitUntil: "networkidle" });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Узнать о свободной дате/.test(b.textContent || ""))?.click());
  await page.waitForSelector("dialog.sheet[open] form");
  await page.locator('input[name="name"]').fill(NAME);
  await page.locator('input[name="phone"]').fill(PH);
  await page.locator('input[type="date"]').fill(D);
  await page.locator('[data-testid=availability] [data-slot="2"]').waitFor({ timeout: 10000 });
  await page.locator('[data-testid=availability] [data-slot="2"]').click();
  await page.locator("dialog button[aria-haspopup=listbox]").nth(0).click();
  await page.locator('dialog [role=option][data-value="wow-party"]').click();
  await page.locator("[data-testid=price]").waitFor({ timeout: 8000 }).catch(() => {});
  const price = (await page.locator("[data-testid=price]").innerText().catch(() => "")).replace(/\D/g, "");
  await page.locator("dialog button[aria-haspopup=listbox]").nth(1).click();
  await page.locator(`dialog [role=option][data-value="${ROOM}"]`).click();
  await page.locator('input[name="children"]').fill("7");
  await page.locator('input[name="consent"]').check();
  await shot(page, "1-parent-form");
  await page.getByRole("button", { name: "Отправить заявку" }).click();
  await page.getByText("Заявка отправлена").waitFor({ timeout: 12000 });
  ok(true, "the site accepted the enquiry (no payment)");
  await ctx.close();
  const lead = (await q(
    `SELECT l.id, l.seq, l.slot_id, l.room_id, l.package_id, to_char(l.requested_date,'YYYY-MM-DD') d, l.status, c.phone_e164 p, c.name
       FROM bb.lead_requests l JOIN bb.contacts c ON c.id = l.contact_id WHERE c.name = $1 ORDER BY l.seq DESC LIMIT 1`, [NAME])).rows[0];
  ok(!!lead && lead.slot_id === SLOT && lead.room_id === ROOM && lead.package_id === "wow-party" && lead.d === D && lead.status === "new" && lead.p === `+7${PH}`, "the enquiry is in the CRM with date, slot, room, package and a normalised phone");
  ok((await scalar("SELECT count(*) v FROM bb.consent_events WHERE lead_request_id = $1", [lead.id])) === "1", "one consent event is stored with the enquiry");
  ok(await until(async () => (await scalar("SELECT status v FROM bb.outbox WHERE ref_id = $1", [lead.id])) === "sent"), "the Telegram notification task was created and delivered (outbox: sent)");
  ok(messages.some((t) => t.includes(`CRM №${lead.seq}`) && t.includes(NAME)), "the Telegram message carries the CRM number and the enquiry");
  ok(price.length > 0, "the price for the chosen date was shown next to the calendar");
  globalThis.__lead = lead;
}
const lead = globalThis.__lead;
{
  const { ctx, page } = await newCtx();
  await login(page, "manager@qa.test");
  await page.goto(`${ADMIN}/contacts?q=${encodeURIComponent(NAME)}`, { waitUntil: "networkidle" });
  ok((await page.locator("main").innerText()).includes(NAME), "the contact is visible to the manager in the CRM");
  await ctx.close();
}

// ══ 2-4. Confirm, conflict, cancel ═════════════════════════════════════════════════════════════════════════════
console.log("## 2-4. manager confirms -> second manager conflicts -> cancel frees the cell");
const mgr1 = await newCtx();
const mgr2 = await newCtx();
await login(mgr1.page, "manager@qa.test");
await login(mgr2.page, "owner@qa.test");
{
  await mgr1.page.goto(ADMIN + "/requests", { waitUntil: "networkidle" });
  const card = mgr1.page.locator(`li[data-lead="${lead.seq}"]`);
  await card.getByRole("button", { name: "Подтвердить бронь" }).click();
  await mgr1.page.waitForURL(/\/bookings\?date=/, { timeout: 8000 });
  const cell = mgr1.page.locator(`[data-cell="${ROOM}:${SLOT}"]`);
  ok((await cell.getAttribute("data-state")) === "booked", "confirmation: the grid shows the room and slot as booked");
  ok((await cell.innerText()).includes(NAME), "the booked cell names the customer");
  const a = await avail(D);
  ok(!a.slots[SLOT - 1].freeRoomIds.includes(ROOM) && a.slots[SLOT - 1].freeRoomIds.length === 3, "the public calendar now shows that room and slot as taken, the others free");
  ok((await scalar("SELECT price_kzt v FROM bb.slot_reservations WHERE lead_request_id = $1 AND released_at IS NULL", [lead.id])) === String(a.prices["wow-party"].amountKzt), "the price on that date is frozen on the booking");
  await shot(mgr1.page, "2-grid-booked");

  const second = await intakeLead(`ТЕСТ Второй ${run}`, phone(2), D);
  ok(second.status === 201, "a second enquiry for the same room and slot is accepted (an enquiry does not block)");
  const secondSeq = await scalar("SELECT seq v FROM bb.lead_requests WHERE id = $1", [second.leadId]);
  await mgr2.page.goto(ADMIN + "/requests", { waitUntil: "networkidle" });
  await mgr2.page.locator(`li[data-lead="${secondSeq}"]`).getByRole("button", { name: "Подтвердить бронь" }).click();
  await mgr2.page.waitForURL(/\/requests\?error=slot_taken/, { timeout: 8000 });
  ok((await mgr2.page.locator("[role=alert]").first().innerText()).includes("уже занят"), "the second manager gets a clear conflict message");
  ok((await scalar("SELECT status v FROM bb.lead_requests WHERE id = $1", [second.leadId])) === "new", "the refused enquiry stays open");
  ok((await scalar("SELECT count(*) v FROM bb.slot_reservations WHERE slot_date = $1 AND slot_id = $2 AND room_id = $3 AND released_at IS NULL", [D, SLOT, ROOM])) === "1", "exactly one active reservation exists for the cell");

  await mgr1.page.goto(`${ADMIN}/bookings?date=${D}`, { waitUntil: "networkidle" });
  await mgr1.page.locator(`[data-cell="${ROOM}:${SLOT}"]`).getByRole("button", { name: "Отменить бронь" }).click();
  await mgr1.page.waitForURL(/notice=released/, { timeout: 8000 });
  ok((await mgr1.page.locator(`[data-cell="${ROOM}:${SLOT}"]`).getAttribute("data-state")) === "free", "cancellation: the cell is free again in the grid");
  ok((await avail(D)).slots[SLOT - 1].freeRoomIds.includes(ROOM), "and free in the public calendar");
  ok((await scalar("SELECT status v FROM bb.lead_requests WHERE id = $1", [lead.id])) === "cancelled", "the first enquiry is marked cancelled");
  ok((await scalar("SELECT count(*) v FROM bb.slot_reservations WHERE lead_request_id = $1", [lead.id])) === "1", "the cancelled reservation stays as history");

  await mgr2.page.goto(ADMIN + "/requests", { waitUntil: "networkidle" });
  await mgr2.page.locator(`li[data-lead="${secondSeq}"]`).getByRole("button", { name: "Подтвердить бронь" }).click();
  await mgr2.page.waitForURL(/\/bookings\?date=/, { timeout: 8000 });
  ok((await mgr2.page.locator(`[data-cell="${ROOM}:${SLOT}"]`).getAttribute("data-state")) === "booked", "after the cancellation the second manager can take the cell");
}
await mgr1.ctx.close();
await mgr2.ctx.close();

// ══ 5. News: editor -> site -> takedown ═══════════════════════════════════════════════════════════════════════
console.log("## 5. editor publishes news, the site shows it, takedown removes it");
{
  const TITLE = `Релизная проверка ${run}`;
  const SLUG = `reliznaya-proverka-${run}`;
  const { ctx, page } = await newCtx();
  await login(page, "editor@qa.test");
  await page.goto(ADMIN + "/news/new", { waitUntil: "networkidle" });
  await page.locator("select[name=kind]").selectOption("news");
  await page.locator("input[name=title]").fill(TITLE);
  await page.locator("input[name=slug]").fill(SLUG);
  await page.locator("textarea[name=excerpt]").fill("Проверка публикации.");
  await page.locator("textarea[name=body]").fill("## Заголовок\n\nТекст новости для проверки.");
  await page.getByRole("button", { name: "Сохранить как черновик" }).click();
  await page.waitForURL(/\/news\/[0-9a-f-]{36}\?notice=created/);
  ok((await fetch(`${SITE}/news/${SLUG}`)).status === 404, "a draft is not public");
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await page.waitForURL(/notice=published/);
  ok(await until(async () => (await (await fetch(`${SITE}/news/${SLUG}`)).text()).includes(TITLE), 6000), "the published news appears on the site");
  ok((await (await fetch(`${SITE}/sitemap.xml`)).text()).includes(SLUG), "and in the sitemap");
  await page.getByRole("button", { name: "Снять с публикации" }).click();
  await page.waitForURL(/notice=unpublished/);
  ok(await until(async () => (await fetch(`${SITE}/news/${SLUG}`)).status === 404, 6000), "after takedown the page is gone (404)");
  ok(!(await (await fetch(`${SITE}/sitemap.xml`)).text()).includes(SLUG), "and it leaves the sitemap");
  await ctx.close();
}

// ══ 6. QR registration ════════════════════════════════════════════════════════════════════════════════════════
console.log("## 6. QR form stores a synthetic consent tied to the document versions");
{
  const { ctx, page } = await newCtx(390, 844, true);
  const QR = `ТЕСТ QR ${run}`;
  await page.goto(SITE + "/consent", { waitUntil: "networkidle" });
  const body = await page.locator("main").innerText();
  ok(body.includes("не означает посещение") && !/Количество детей/.test(body), "the QR page says registration is not a visit and asks no children count");
  await page.locator('input[name="name"], form input[autocomplete=name]').first().fill(QR);
  await page.locator('input[type="tel"]').fill(phone(3));
  const boxes = page.locator('form input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  ok(true, "the synthetic registration is accepted");
  await ctx.close();
  const events = (await q(
    `SELECT d.kind::text k, d.version v FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id
       JOIN bb.consent_registrations r ON r.id = e.registration_id JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1`, [QR])).rows;
  ok(events.length >= 2 && events.every((e) => docs.some((d) => d.k === e.k && d.v === e.v)), `consent events name the exact published versions (${events.map((e) => `${e.k} v${e.v}`).join(", ")})`);
  ok((await scalar("SELECT phone_verification v FROM bb.contacts WHERE name = $1", [QR])) === "unverified", "the phone is marked unverified, the contact is not merged with anyone");
}

// ══ 6b. QR registration: the phone is optional ═══════════════════════════════════════════════════════════════
console.log("## 6b. QR form without a phone, with a wrong phone, and repeated");
{
  const { ctx, page } = await newCtx(390, 844, true);
  const NOPHONE = `ТЕСТ QR без номера ${run}`;
  const regs = async (name) => Number(await scalar("SELECT count(*) v FROM bb.consent_registrations r JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1", [name]));
  await page.goto(SITE + "/consent", { waitUntil: "networkidle" });
  const tel = page.locator('input[type="tel"]');
  ok(!(await tel.evaluate((e) => e.required)), "the phone field is not required");
  ok(/необязательно/i.test(await page.locator("form").innerText()), "the form says the phone is optional");
  const fillBasics = async (name) => {
    await page.locator('input[name="name"], form input[autocomplete=name]').first().fill(name);
    const boxes = page.locator('form input[type="checkbox"]');
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  };
  // a wrong number is refused in the browser and nothing is saved
  await fillBasics(NOPHONE);
  await tel.fill("123");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.waitForTimeout(600);
  ok((await page.locator("form").innerText()).includes("10 цифр"), "a wrong phone shows an error");
  ok((await regs(NOPHONE)) === 0, "a wrong phone saves nothing");
  // an empty phone is accepted
  await tel.fill("");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  ok(true, "a registration without a phone is accepted");
  await ctx.close();
  ok((await regs(NOPHONE)) === 1, "exactly one registration was stored");
  ok((await scalar("SELECT coalesce(c.phone_e164,'<none>') v FROM bb.contacts c WHERE c.name = $1", [NOPHONE])) === "<none>", "no phone and no placeholder number was stored");
  const ev = (await q(`SELECT d.kind::text k, d.version v FROM bb.consent_events e JOIN bb.legal_documents d ON d.id = e.document_id JOIN bb.consent_registrations r ON r.id = e.registration_id JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1`, [NOPHONE])).rows;
  ok(ev.length >= 2 && ev.every((e) => docs.some((d) => d.k === e.k && d.v === e.v)), "consent history names the exact document versions without a phone");

  // repeated and parallel sends of the same key through the real site API create one registration; a second visitor with the same name stays separate
  const key = crypto.randomUUID();
  const REP = `ТЕСТ QR повтор ${run}`;
  const send = (k, name = REP) => fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, acceptRules: true, acceptPersonalData: true, idempotencyKey: k }) });
  const results = await Promise.all([send(key), send(key), send(key)]);
  ok(results.every((r) => r.status === 200), "repeated sends of the same key are all answered OK");
  ok((await regs(REP)) === 1, "three parallel sends of one key create one registration");
  ok((await send(crypto.randomUUID())).status === 200 && (await regs(REP)) === 2, "another visitor with the same name and no phone is a separate registration");
  ok(Number(await scalar("SELECT count(DISTINCT c.id) v FROM bb.contacts c WHERE c.name = $1", [REP])) === 2, "they are not merged into one contact");
  const bad = await fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: REP, phone: "12345", acceptRules: true, acceptPersonalData: true, idempotencyKey: crypto.randomUUID() }) });
  ok(bad.status === 400 && (await bad.json()).fieldErrors?.phone, "the API refuses a wrong phone with a field error");
  const noConsent = await fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: REP, acceptRules: true, acceptPersonalData: false, idempotencyKey: crypto.randomUUID() }) });
  ok(noConsent.status === 400, "the personal-data consent is still required without a phone");
  // the enquiry form keeps its phone requirement
  const leadNoPhone = await fetch(SITE + "/api/lead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ТЕСТ", date: "2099-01-01", consent: true }) });
  ok(leadNoPhone.status === 400, "the birthday enquiry still refuses a missing phone");
}

// ══ 7. Export permissions ═════════════════════════════════════════════════════════════════════════════════════
console.log("## 7. export is available only to permitted roles");
{
  const form = () => { const f = new FormData(); f.append("format", "csv"); f.append("columns", "name"); f.append("columns", "phone"); return f; };
  const post = (ctx) => ctx.request.post(ADMIN + "/api/export", { headers: { origin: ADMIN }, multipart: form() });
  const owner = await newCtx(); await login(owner.page, "owner@qa.test");
  const editor = await newCtx(); await login(editor.page, "editor@qa.test");
  let manager = await newCtx(); await login(manager.page, "manager@qa.test");
  const before = Number(await scalar("SELECT count(*) v FROM bb.export_log"));
  ok((await post(owner.ctx)).status() === 200, "the owner can export");
  ok((await post(manager.ctx)).status() === 403, "a manager without the permission cannot");
  ok((await post(editor.ctx)).status() === 403, "an editor cannot");
  ok((await fetch(ADMIN + "/api/export", { method: "POST", redirect: "manual", headers: { origin: ADMIN } })).status !== 200, "an anonymous request is refused");
  ok(Number(await scalar("SELECT count(*) v FROM bb.export_log")) === before + 1, "only the allowed export was logged");
  await owner.page.goto(ADMIN + "/users", { waitUntil: "networkidle" });
  await owner.page.locator("article", { hasText: "manager@qa.test" }).getByRole("button", { name: "Разрешить" }).click();
  await owner.page.waitForURL(/notice=export/);
  await manager.ctx.close(); manager = await newCtx(); await login(manager.page, "manager@qa.test");
  ok((await post(manager.ctx)).status() === 200, "after the owner grants it, the manager can export");
  await owner.page.goto(ADMIN + "/users", { waitUntil: "networkidle" });
  await owner.page.locator("article", { hasText: "manager@qa.test" }).getByRole("button", { name: "Запретить" }).click();
  await owner.page.waitForURL(/notice=export/);
  ok((await scalar("SELECT can_export v FROM bb.users WHERE email = 'manager@qa.test'")) === "false", "the permission is withdrawn again (test user restored)");
  for (const c of [owner, editor, manager]) await c.ctx.close();
}

// ══ 8. Telegram outbox: down, retry, recover, exactly once ═══════════════════════════════════════════════════
console.log("## 8. Telegram outage: the enquiry is kept, retried, and delivered exactly once");
{
  const N = `ТЕСТ Отказ ${run}`;
  messages.length = 0;
  telegramDown = true;
  const r = await intakeLead(N, phone(4), day(2));
  ok(r.status === 201, "while Telegram is down the enquiry is still accepted and saved");
  await sleep(1500);
  let ob = (await q("SELECT status, attempts, last_error_code FROM bb.outbox WHERE ref_id = $1", [r.leadId])).rows[0];
  ok(ob.status === "pending" && ob.attempts >= 1 && !!ob.last_error_code && messages.length === 0, `the task waits for a retry (attempts ${ob.attempts}, code ${ob.last_error_code})`);
  ok(!JSON.stringify(ob).includes("ТЕСТ"), "the error record holds a code only, no personal data");
  telegramDown = false;
  await q("UPDATE bb.outbox SET next_attempt_at = now() WHERE ref_id = $1", [r.leadId]);
  const c1 = await fetch(`${ADMIN}/api/cron/outbox`, { headers: { authorization: `Bearer ${CRON}` } });
  ok(c1.status === 200 && (await scalar("SELECT status v FROM bb.outbox WHERE ref_id = $1", [r.leadId])) === "sent", "after recovery the scheduled worker delivers it");
  await fetch(`${ADMIN}/api/cron/outbox`, { headers: { authorization: `Bearer ${CRON}` } });
  ok(messages.filter((t) => t.includes(N)).length === 1, "the message was sent exactly once");
  ok((await fetch(`${ADMIN}/api/cron/outbox`)).status === 401, "the worker refuses calls without its secret");
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
mock.close();
process.exit(fails ? 1 : 0);
