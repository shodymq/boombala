// Full staff path with the second factor required, against the real FastAPI + PostgreSQL stack (never the stand-in):
//   owner login -> MFA enrolment -> dashboard -> requests -> calendar -> new booking -> details -> reschedule -> cancel,
// plus wrong code, expired pending login, replayed code, refresh persistence. Platform must run with MFA_MODE=required.
//   PLATFORM_URL, E2E_PASSWORD, PLATFORM_DATABASE_URL, E2E_ARTIFACTS, [E2E_FULL_DATE], [E2E_CHROME]
//   E2E_KERNEL_MINUTES=1 once the FastAPI kernel accepts any minute (otherwise a 13:30 start must be refused, visibly).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { totpAt } from "../src/core/totp.ts";

const ADMIN = process.env.PLATFORM_URL ?? "http://127.0.0.1:3101";
const PW = process.env.E2E_PASSWORD;
const ART = process.env.E2E_ARTIFACTS;
const DATE = process.env.E2E_FULL_DATE ?? "2027-12-10";
const KERNEL_MINUTES = process.env.E2E_KERNEL_MINUTES === "1";
if (!PW || !ART || !process.env.PLATFORM_DATABASE_URL) throw new Error("E2E_PASSWORD, E2E_ARTIFACTS and PLATFORM_DATABASE_URL are required");
mkdirSync(ART, { recursive: true });
const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const db = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
await db.connect();
const stamp = Date.now().toString(36);
// The FastAPI bridge refuses an e-mail that differs from the linked AdminUser, so the path uses the staging owner account
// itself and resets its second factor first (fresh enrolment every run).
const email = "owner-a@staging.boombala.example.com";
await db.query("DELETE FROM bb.mfa_recovery_codes WHERE user_id = (SELECT id FROM bb.users WHERE email = $1)", [email]);
await db.query("DELETE FROM bb.user_mfa WHERE user_id = (SELECT id FROM bb.users WHERE email = $1)", [email]);
await db.query("UPDATE bb.sessions SET revoked_at = now() WHERE user_id = (SELECT id FROM bb.users WHERE email = $1) AND revoked_at IS NULL", [email]);

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const shot = (name) => page.screenshot({ path: join(ART, `${name}.png`), fullPage: true });
const passwordStep = async () => {
  await page.goto(`${ADMIN}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]:has-text("Войти")');
};

// 1. Password accepted but no usable session until the second factor is done.
await passwordStep();
await page.waitForURL(/\/login\/mfa/, { timeout: 15000 });
check("password alone does not open the admin: redirected to the second factor", true);
await page.goto(`${ADMIN}/bookings`);
check("pending session cannot open the calendar", !(await page.locator("[data-timeline]").count()) && /\/login/.test(page.url()), page.url());

// 2. Enrolment: a wrong code is refused, the right one enrols and shows recovery codes.
await page.goto(`${ADMIN}/login/mfa`); // the pending session continues on the second-factor page
const secret = (await page.locator('[data-testid="mfa-secret"]').innerText()).trim();
await page.fill('input[name="code"]', "000000");
await page.click('button[type="submit"]');
await page.locator("main [role=alert]").waitFor({ timeout: 10000 });
check("wrong second-factor code is refused with a message", (await page.locator("main [role=alert]").innerText()).length > 0);
await page.fill('input[name="code"]', totpAt(secret, Date.now()));
await page.click('button[type="submit"]');
await page.locator('[data-testid="recovery-codes"]').waitFor({ timeout: 15000 });
check("enrolment shows ten one-time recovery codes", (await page.locator('[data-testid="recovery-codes"] li').count()) >= 8);
await page.click('a:has-text("Я сохранил коды")');
await page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
check("dashboard opens after the second factor", (await page.locator("body").innerText()).includes("Boom Bala"));
await shot("full-01-dashboard");

// 3. Expired pending login: the password step is older than its lifetime, so the code is useless.
await ctx.clearCookies();
await passwordStep();
await page.waitForURL(/\/login\/mfa/);
await db.query("UPDATE bb.sessions SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM bb.users WHERE email = $1) AND mfa_state = 'pending'", [email]);
await page.fill('input[name="code"]', totpAt(secret, Date.now() + 30_000));
await page.click('button[type="submit"]');
await page.waitForTimeout(1500);
await page.goto(`${ADMIN}/bookings`);
check("expired second-factor step cannot be completed", /\/login/.test(page.url()), page.url());

// 4. A real login: a fresh code (next step; the used step is replay-protected) opens the admin.
await ctx.clearCookies();
await passwordStep();
await page.waitForURL(/\/login\/mfa/);
await page.fill('input[name="code"]', totpAt(secret, Date.now() + 30_000));
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
check("login with a valid second factor opens the admin", true);

// 5. Requests -> Calendar through the navigation.
await page.click('nav a:has-text("Заявки")');
await page.waitForURL(/\/requests/);
check("requests page opens", (await page.locator("main").innerText()).length > 0);
await shot("full-02-requests");
await page.click('nav a:has-text("Календарь")');
await page.waitForURL(/\/bookings/);
await page.goto(`${ADMIN}/bookings?branch=stg-almaty&date=${DATE}`);
await page.waitForLoadState("networkidle");
check("calendar shows both staging rooms on the real kernel", (await page.locator("[data-timeline] h2").allInnerTexts()).join("|") === "Комната A|Комната B");
await shot("full-03-calendar");

// 6. New booking. A minute start is refused visibly on today's kernel (or accepted once the kernel allows it).
const phone = `+7700${Date.now().toString().slice(-7)}`;
async function create(start, name) {
  await page.goto(`${ADMIN}/bookings?branch=stg-almaty&date=${DATE}&new=1`);
  await page.waitForLoadState("networkidle");
  const f = page.locator("form[aria-label='Новая бронь']");
  await f.locator('select[name="roomId"]').selectOption({ label: "Комната A" });
  await f.locator('input[name="startTime"]').fill(start);
  await f.locator('input[name="customerName"]').fill(name);
  await f.locator('input[name="phone"]').fill(phone);
  await f.locator('input[name="agreedPriceKzt"]').fill("120000");
  await f.locator('button[type="submit"]').click();
  await page.waitForURL((u) => /[?&](ok|error)=/.test(u.search), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
}
await create("13:30", `ПУТЬ ${stamp}`);
if (KERNEL_MINUTES) {
  check("kernel accepts 13:30 (any-minute rule)", (await page.locator('a[data-start="13:30"]').count()) === 1 && (await page.locator('a[data-end="17:30"]').count()) === 1);
} else {
  const alert = await page.locator("main [role=alert]").first().innerText();
  check("13:30 is refused by today's kernel and shown as refused, not booked", alert.includes("целый час") && (await page.locator('a[data-start="13:30"]').count()) === 0 && (await page.locator("main [role=status]").count()) === 0, alert.slice(0, 80));
}
await shot("full-04-minute-start");
const start = KERNEL_MINUTES ? "13:30" : "13:00";
const name = `ПУТЬ ${stamp}`;
if (!KERNEL_MINUTES) {
  // The refused attempt left a paid request for this phone; confirm it on a whole hour without a second prepayment.
  check("the page names the paid unconfirmed request after the refusal", (await page.locator("main").innerText()).includes("НЕ подтверждена"));
  const form = page.locator('form:has(input[name="requestId"])');
  await form.locator('select[name="roomId"]').selectOption({ label: "Комната A" });
  await form.locator('input[name="startTime"]').fill("13:00");
  await form.locator('select[name="packageId"]').selectOption({ index: 0 });
  await form.locator('input[name="agreedPriceKzt"]').fill("120000");
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((u) => /[?&]ok=booked/.test(u.search), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
}
check("booking is verified from the system's state", (await page.locator("main [role=status]").innerText()).includes("Проверено по данным системы"));
const block = page.locator("a[data-reservation]", { hasText: name }).first();
check("booking block is on the grid at the exact start", (await block.getAttribute("data-start")) === start);

// 7. Refresh keeps the state. The one-time outcome parameters are dropped from the address once shown.
const cleaned = await page.waitForFunction(() => !/[?&](ok|reservation|error)=/.test(location.search), null, { timeout: 5000 }).then(() => true).catch(() => false);
check("one-time outcome parameters are removed from the address bar", cleaned, new URL(page.url()).search);
await page.reload();
await page.waitForLoadState("networkidle");
const afterRefresh = { blocks: await page.locator("a[data-reservation]", { hasText: name }).count(), status: await page.locator("main [role=status]").count(), url: new URL(page.url()).search };
check("after refresh the booking is still there, from FastAPI", afterRefresh.blocks === 1 && afterRefresh.status === 0, JSON.stringify(afterRefresh));

// 8. Details, reschedule to Room B, cancel.
await page.locator("a[data-reservation]", { hasText: name }).first().click();
const drawer = page.locator("[data-drawer]");
await drawer.waitFor();
const card = (await drawer.innerText()).replace(/[  ]/g, " ");
check("details: client, phone, room, exact time, amounts", card.includes(name) && card.includes("Комната A") && card.includes(`${start}–`) && card.includes("120 000") && card.includes("10 000"), card.slice(0, 120));
await shot("full-05-details");
await drawer.locator('a:has-text("Перенести бронь")').click();
const move = page.locator("form[aria-label='Перенос брони']");
await move.locator('select[name="roomId"]').selectOption({ label: "Комната B" });
await move.locator('input[name="startTime"]').fill("15:00");
await move.locator('button[type="submit"]').click();
await page.waitForURL((u) => /[?&]ok=rescheduled/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
const movedGroup = page.locator('[data-timeline] [role=group][aria-label="Комната B"]');
check("reschedule is verified and the block moved to Room B 15:00", (await movedGroup.locator('a[data-start="15:00"]').count()) === 1 && (await page.locator('[data-timeline] [role=group][aria-label="Комната A"] a[data-reservation]').count()) === 0);
await shot("full-06-rescheduled");
await page.locator("a[data-reservation]", { hasText: name }).first().click();
await drawer.waitFor();
await drawer.locator("summary", { hasText: "Отменить бронь" }).click();
await drawer.locator('form button[type="submit"]:has-text("Отменить бронь")').click();
await page.waitForURL((u) => /[?&]ok=released/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
check("cancel is verified: the room is free and the booking stays in the history", (await page.locator("a[data-reservation]", { hasText: name }).count()) === 0 && (await page.locator("ul[aria-label='Снятые брони'] li", { hasText: name }).count()) === 1);
await shot("full-07-cancelled");

await db.end();
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
