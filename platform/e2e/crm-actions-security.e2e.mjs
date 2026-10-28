// Server Action security and repeat-submit checks on the real Platform.
//  1. Cross-origin: a POST to the booking action with a foreign Origin is refused by Next and writes nothing.
//  2. Double click on the real booking form (one idempotency key): one request, one payment fact, one reservation.
//  3. Second submit with a new key for the same room and time, after the first succeeded: refused by the pre-check, no writes.
//   PLATFORM_URL, E2E_PASSWORD, FASTAPI_DATABASE_URL, E2E_ARTIFACTS, E2E_SECURITY_DATE
import { chromium } from "playwright-core";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { uniquePhone } from "./support/crm-fastapi.mjs";
const runPhone = uniquePhone();
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ADMIN = process.env.PLATFORM_URL ?? "http://127.0.0.1:3300";
const PW = process.env.E2E_PASSWORD;
const DATE = process.env.E2E_SECURITY_DATE ?? "2026-11-24";
const ART = process.env.E2E_ARTIFACTS ?? join(process.cwd(), "e2e", "artifacts", "security");
if (!PW || !process.env.FASTAPI_DATABASE_URL) throw new Error("E2E_PASSWORD and FASTAPI_DATABASE_URL are required");
mkdirSync(ART, { recursive: true });

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
const count = async (sql, params) => (await db.query(sql, params)).rows[0].n;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${ADMIN}/login`);
await page.fill('input[type="email"]', "manager-a@staging.boombala.example.com");
await page.fill('input[type="password"]', PW);
await page.click('button[type="submit"]:has-text("Войти")');
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const pageUrl = `${ADMIN}/bookings?branch=stg-almaty&date=${DATE}`;
await page.goto(pageUrl);
await page.waitForLoadState("networkidle");

// 1. Cross-origin probe with the logged-in cookies and a foreign Origin.
const html = await page.content();
const bookingForm = html.split("<form").slice(1).find((f) => f.includes('name="customerName"'));
const actionId = bookingForm?.match(/name="\$ACTION_ID_([0-9a-f]+)"/)?.[1] ?? "";
check("booking form exposes a server action id", actionId.length > 0);
const probeName = `CSRF ${randomUUID().slice(0, 8)}`;
const probe = await ctx.request.post(pageUrl, {
  headers: { Origin: "http://evil.example", "Next-Action": actionId, Accept: "text/x-component" },
  multipart: {
    [`$ACTION_ID_${actionId}`]: "", branchId: "stg-almaty", date: DATE, roomId: "stg-room-b", startTime: "10:00", packageId: "stg-pkg-start",
    customerName: probeName, phone: runPhone, guestCount: "", agreedPriceKzt: "100000", prepaymentKzt: "10000", prepaymentMethod: "cash",
    note: "", idempotencyKey: randomUUID(),
  },
  maxRedirects: 0,
  failOnStatusCode: false,
});
check("cross-origin action POST is refused (Next aborts it)", probe.status() >= 400, `status=${probe.status()}`);
check("cross-origin POST wrote no request and no payment", (await count("SELECT count(*)::int AS n FROM birthday_requests WHERE customer_name = $1", [probeName])) === 0);

// 2. Double click on the real form: one key, two clicks.
const repeatName = `REP ${randomUUID().slice(0, 8)}`;
const form = page.locator('form:has(input[name="customerName"])');
await form.locator('select[name="roomId"]').selectOption({ label: "Комната B" });
await form.locator('select[name="startTime"]').selectOption("10:00");
await form.locator('input[name="customerName"]').fill(repeatName);
await form.locator('input[name="phone"]').fill(runPhone);
await form.locator('input[name="agreedPriceKzt"]').fill("100000");
await form.locator('input[name="prepaymentKzt"]').fill("10000");
const submit = form.locator('button[type="submit"]');
await submit.dblclick();
await page.waitForURL((u) => /[?&](ok|error)=/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
const requests = await count("SELECT count(*)::int AS n FROM birthday_requests WHERE customer_name = $1", [repeatName]);
const facts = await count("SELECT count(*)::int AS n FROM birthday_payment_facts f JOIN birthday_requests r ON r.id = f.birthday_request_id WHERE r.customer_name = $1", [repeatName]);
const bookings = await count("SELECT count(*)::int AS n FROM birthday_slot_reservations r JOIN birthday_requests q ON q.id = r.birthday_request_id WHERE q.customer_name = $1 AND r.released_at IS NULL", [repeatName]);
check("double click creates one request", requests === 1, `requests=${requests}`);
check("double click records one payment fact", facts === 1, `facts=${facts}`);
check("double click leaves one active booking", bookings === 1, `bookings=${bookings}`);
await page.screenshot({ path: join(ART, "double-submit.png"), fullPage: true });

// 3. A new submit (a new key from a fresh render) for the same room and time is refused by the pre-check: nothing new is written.
await page.goto(pageUrl);
await page.waitForLoadState("networkidle");
const form2 = page.locator('form:has(input[name="customerName"])');
await form2.locator('select[name="roomId"]').selectOption({ label: "Комната B" });
await form2.locator('select[name="startTime"]').selectOption("10:00");
await form2.locator('input[name="customerName"]').fill(`${repeatName} второй`);
await form2.locator('input[name="phone"]').fill(runPhone);
await form2.locator('input[name="agreedPriceKzt"]').fill("100000");
await form2.locator('input[name="prepaymentKzt"]').fill("10000");
await form2.locator('button[type="submit"]').click();
await page.waitForURL((u) => /[?&](ok|error)=/.test(u.search), { timeout: 20000 });
await page.waitForLoadState("networkidle");
check("second submit for the same time is refused with time_conflict", (await page.locator("main [role=alert]", { hasText: "Комната занята" }).count()) === 1);
const requestsAfter = await count("SELECT count(*)::int AS n FROM birthday_requests WHERE customer_name LIKE $1", [`${repeatName}%`]);
check("second submit wrote no request and no payment", requestsAfter === 1, `requests=${requestsAfter}`);

await ctx.close();
await db.end();
await browser.close();
writeFileSync(join(ART, "security-results.json"), JSON.stringify({ at: new Date().toISOString(), date: DATE, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
