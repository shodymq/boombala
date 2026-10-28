// Lost response and reload through the real Server Actions and PostgreSQL. The browser's request reaches the server; the
// response is then dropped (or the request is dropped before the server sees it). The manager reloads, re-submits with a
// fresh idempotency key, and the database must still hold exactly one request, one payment fact and one reservation.
//   PLATFORM_URL, E2E_PASSWORD, FASTAPI_DATABASE_URL, E2E_CRM_SERVICE_TOKEN, E2E_CRM_STAFF_ASSERTION_SECRET,
//   E2E_FASTAPI_BASE_URL, E2E_LOST_DATE, E2E_ARTIFACTS
import { chromium } from "playwright-core";
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paidUnconfirmedRequest, staffToken, uniquePhone } from "./support/crm-fastapi.mjs";

const ADMIN = process.env.PLATFORM_URL ?? "http://127.0.0.1:3300";
const PW = process.env.E2E_PASSWORD;
const DATE = process.env.E2E_LOST_DATE ?? "2027-03-10";
const ART = process.env.E2E_ARTIFACTS ?? join(process.cwd(), "e2e", "artifacts", "lost-response");
if (!PW || !process.env.FASTAPI_DATABASE_URL) throw new Error("E2E_PASSWORD and FASTAPI_DATABASE_URL are required");
mkdirSync(ART, { recursive: true });
const stamp = Date.now().toString(36);
const phoneRun = uniquePhone();

const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const db = new pg.Client({ connectionString: process.env.FASTAPI_DATABASE_URL.replace("postgresql+psycopg://", "postgresql://") });
await db.connect();
const n = async (sql, params) => (await db.query(sql, params)).rows[0].n;
const countsByName = (name) => Promise.all([
  n("SELECT count(*)::int AS n FROM birthday_requests WHERE customer_name = $1", [name]),
  n("SELECT count(*)::int AS n FROM birthday_payment_facts f JOIN birthday_requests r ON r.id = f.birthday_request_id WHERE r.customer_name = $1", [name]),
  n("SELECT count(*)::int AS n FROM birthday_slot_reservations s JOIN birthday_requests r ON r.id = s.birthday_request_id WHERE r.customer_name = $1 AND s.kind = 'booking' AND s.released_at IS NULL", [name]),
]);
const countsByRequest = (id) => Promise.all([
  n("SELECT count(*)::int AS n FROM birthday_payment_facts WHERE birthday_request_id = $1", [id]),
  n("SELECT count(*)::int AS n FROM birthday_slot_reservations WHERE birthday_request_id = $1 AND kind = 'booking' AND released_at IS NULL", [id]),
]);

// The harness token for the same staff account as the browser, fetched once.
let cachedTokenA = null;
const tokenA0 = () => cachedTokenA;
cachedTokenA = await staffToken({ email: "manager-a@staging.boombala.example.com", staffId: "stg-manager-a" });

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${ADMIN}/login`);
await page.fill('input[type="email"]', "manager-a@staging.boombala.example.com");
await page.fill('input[type="password"]', PW);
await page.click('button[type="submit"]:has-text("Войти")');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
const pageUrl = `${ADMIN}/bookings?branch=stg-almaty&date=${DATE}`;

// Drops one server action's response (or the request itself), once. `mode`: "after-server" lets the server finish first.
let armed = null;
await page.route("**/bookings**", async (route) => {
  const request = route.request();
  const isAction = request.method() === "POST" && request.headers()["next-action"];
  if (isAction && armed) {
    const mode = armed;
    armed = null;
    if (mode === "after-server") {
      await route.fetch();
      await route.abort("connectionreset");
    } else {
      await route.abort("connectionreset");
    }
    return;
  }
  await route.continue();
});

async function submitCreate(p, { room, start, name, price, prepay, phone = phoneRun }) {
  const form = p.locator('form:has(input[name="customerName"])');
  await form.locator('select[name="roomId"]').selectOption({ label: room });
  await form.locator('select[name="startTime"]').selectOption(start);
  await form.locator('input[name="customerName"]').fill(name);
  await form.locator('input[name="phone"]').fill(phone);
  await form.locator('input[name="agreedPriceKzt"]').fill(String(price));
  await form.locator('input[name="prepaymentKzt"]').fill(String(prepay));
  await form.locator('button[type="submit"]').click();
}
async function waitForOutcome(p) {
  await p.waitForURL((u) => /[?&](ok|error)=/.test(u.search), { timeout: 20000 }).catch(() => {});
  await p.waitForLoadState("networkidle");
}

// D. The response was lost after the manual payment, before the confirmation. The request exists and is paid; FastAPI shows it.
// The manager's next attempt for the same phone must not create a second request or a second payment.
const phoneD = uniquePhone();
const reqD = await paidUnconfirmedRequest(tokenA0(), { branchId: "stg-almaty", packageId: "stg-pkg-start", amountKzt: 20000, customerName: `LOST-D ${stamp}`, phone: phoneD, requestedDate: DATE });
const byPhone = () => Promise.all([
  n("SELECT count(*)::int AS n FROM birthday_requests WHERE phone = $1", [phoneD]),
  n("SELECT count(*)::int AS n FROM birthday_payment_facts f JOIN birthday_requests r ON r.id = f.birthday_request_id WHERE r.phone = $1", [phoneD]),
]);
await page.goto(pageUrl);
await page.waitForLoadState("networkidle");
await submitCreate(page, { room: "Комната B", start: "14:00", name: `LOST-D2 ${stamp}`, price: 100000, prepay: 10000, phone: phoneD });
await waitForOutcome(page);
check("D: a new attempt for a phone with a paid, unconfirmed request is refused, with that request shown", (await page.locator("main [role=alert]", { hasText: "оплаченная заявка" }).count()) >= 1);
let [reqsD, factsD] = await byPhone();
check("D: no second request and no second payment fact for the phone", reqsD === 1 && factsD === 1, `requests=${reqsD} facts=${factsD}`);
check("D: the page names the existing request", (await page.locator("main").innerText()).includes(reqD));

// A. Create, response lost after the server finished. Reload. Re-submit with a new key.
await page.goto(pageUrl);
await page.waitForLoadState("networkidle");
const nameA = `LOST-A ${stamp}`;
armed = "after-server";
await submitCreate(page, { room: "Комната B", start: "10:00", name: nameA, price: 100000, prepay: 10000 });
await page.waitForTimeout(4000);
check("A: the browser saw no response (the action was dropped after the server ran)", armed === null);
let [req, pay, res] = await countsByName(nameA);
check("A: the server recorded exactly one request, one payment and one reservation", req === 1 && pay === 1 && res === 1, `req=${req} pay=${pay} res=${res}`);

await page.reload();
await page.waitForLoadState("networkidle");
check("A: after reload the booking is visible from FastAPI state", (await page.locator("main").innerText()).includes(nameA));

await submitCreate(page, { room: "Комната B", start: "10:00", name: nameA, price: 100000, prepay: 10000 });
await waitForOutcome(page);
check("A: re-submit with a new key is refused by the room check, no duplicate", (await page.locator("main [role=alert]", { hasText: "Комната занята" }).count()) === 1);
[req, pay, res] = await countsByName(nameA);
check("A: after re-submit still one request, one payment, one reservation", req === 1 && pay === 1 && res === 1, `req=${req} pay=${pay} res=${res}`);
await page.screenshot({ path: join(ART, "a-after-lost-response-and-reload.png"), fullPage: true });

// B. Paid, unconfirmed request. Confirm dropped BEFORE the server saw it. Reload shows it still unconfirmed; confirm once.
const tokenA = await staffToken({ email: "manager-a@staging.boombala.example.com", staffId: "stg-manager-a" });
const reqB = await paidUnconfirmedRequest(tokenA, { branchId: "stg-almaty", packageId: "stg-pkg-start", amountKzt: 20000, customerName: `LOST-B ${stamp}`, requestedDate: DATE });
await page.goto(`${pageUrl}&request=${reqB}`);
await page.waitForLoadState("networkidle");
const confirmForm = page.locator('form:has(input[name="requestId"])');
const confirmB = async (room, start, price) => {
  await confirmForm.locator('select[name="roomId"]').selectOption({ label: room });
  await confirmForm.locator('select[name="startTime"]').selectOption(start);
  await confirmForm.locator('input[name="agreedPriceKzt"]').fill(String(price));
  await confirmForm.locator('button[type="submit"]').click();
};
armed = "before-server";
await confirmB("Комната A", "18:00", 150000);
await page.waitForTimeout(3000);
check("B: a dropped confirm leaves the request unconfirmed", (await countsByRequest(reqB))[1] === 0);
await page.reload();
await page.waitForLoadState("networkidle");
check("B: reload still offers the paid request, without a new payment", (await page.locator('section[aria-labelledby="paid-request"]').count()) === 1);
await confirmB("Комната A", "18:00", 150000);
await waitForOutcome(page);
check("B: confirm after reload succeeds and is verified", (await page.locator('main [role=status]').innerText().catch(() => "")).includes("Проверено по данным системы"));
let [pay2, res2] = await countsByRequest(reqB);
check("B: one payment fact and one reservation for the paid request", pay2 === 1 && res2 === 1, `pay=${pay2} res=${res2}`);

// C. Confirm processed by the server, response lost, then the manager re-submits the same paid request with a new key.
const reqC = await paidUnconfirmedRequest(tokenA, { branchId: "stg-almaty", packageId: "stg-pkg-start", amountKzt: 20000, customerName: `LOST-C ${stamp}`, requestedDate: DATE });
await page.goto(`${pageUrl}&request=${reqC}`);
await page.waitForLoadState("networkidle");
armed = "after-server";
await page.locator('form:has(input[name="requestId"])').locator('select[name="roomId"]').selectOption({ label: "Комната B" });
await page.locator('form:has(input[name="requestId"])').locator('select[name="startTime"]').selectOption("18:00");
await page.locator('form:has(input[name="requestId"])').locator('input[name="agreedPriceKzt"]').fill("150000");
await page.locator('form:has(input[name="requestId"])').locator('button[type="submit"]').click();
await page.waitForTimeout(4000);
await page.reload();
await page.waitForLoadState("networkidle");
check("C: after a lost response the reload shows the request as booked, not offered again", (await page.locator('section[aria-labelledby="paid-request"]').count()) === 0);
const pageC = await page.locator("main").innerText();
check("C: the booked state is read from FastAPI", pageC.includes("Бронь: подтверждена") || pageC.includes("Подтверждено"), "");
[pay2, res2] = await countsByRequest(reqC);
check("C: still one payment fact and one reservation", pay2 === 1 && res2 === 1, `pay=${pay2} res=${res2}`);

await ctx.close();
await db.end();
await browser.close();
writeFileSync(join(ART, "lost-response-results.json"), JSON.stringify({ at: new Date().toISOString(), date: DATE, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
