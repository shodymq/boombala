// CRM calendar, manager E2E against local staging. Two independent browser contexts (two cookie jars), real server actions,
// real FastAPI state read back after every step. Synthetic data only. Run with the staging env set (see README in the PR).
//   PLATFORM_URL, E2E_PASSWORD, PLATFORM_DATABASE_URL, FASTAPI_DATABASE_URL, E2E_CRM_SERVICE_TOKEN,
//   E2E_CRM_STAFF_ASSERTION_SECRET, E2E_ARTIFACTS, [E2E_DATE], [E2E_CHROME]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { lead, paidUnconfirmedRequest, staffToken, uniquePhone } from "./support/crm-fastapi.mjs";

const ADMIN = process.env.PLATFORM_URL ?? "http://127.0.0.1:3300";
const PW = process.env.E2E_PASSWORD;
const ART = process.env.E2E_ARTIFACTS;
const DATE = process.env.E2E_DATE ?? "2026-11-10";
const BRANCH = "stg-almaty";
const ROOM_A = "Комната A";
const ROOM_B = "Комната B";
const PACKAGE_START = "stg-pkg-start";
// Browsers render thousands separators with no-break spaces; compare on normal spaces.
const plain = (text) => text.replace(/[\u00a0\u202f]/g, " ");
const alertWith = (page, text) => page.locator("main [role=alert]", { hasText: text });
if (!PW || !ART || !process.env.PLATFORM_DATABASE_URL || !process.env.FASTAPI_DATABASE_URL) throw new Error("env is incomplete");
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
const shot = (page, name) => page.screenshot({ path: join(ART, `${name}.png`), fullPage: true });

async function login(page, email) {
  await page.goto(`${ADMIN}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]:has-text("Войти")');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

async function openCalendar(page, extra = "") {
  await page.goto(`${ADMIN}/bookings?branch=${BRANCH}&date=${DATE}${extra}`);
  await page.waitForLoadState("networkidle");
}

/** Waits for the server action's redirect (an outcome parameter in the address) and the page that follows it. */
async function afterAction(page) {
  await page.waitForURL((u) => /[?&](ok|error)=/.test(u.search), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
}

async function createBooking(page, { room, start, name, price, prepay, phone }) {
  const form = page.locator('form:has(input[name="customerName"])');
  await form.locator('select[name="roomId"]').selectOption({ label: room });
  await form.locator('select[name="startTime"]').selectOption(start);
  await form.locator('input[name="customerName"]').fill(name);
  await form.locator('input[name="phone"]').fill(phone);
  await form.locator('input[name="agreedPriceKzt"]').fill(String(price));
  await form.locator('input[name="prepaymentKzt"]').fill(String(prepay));
  await form.locator('button[type="submit"]').click();
  await afterAction(page);
}

const phoneA = uniquePhone();
const phoneB = uniquePhone();
const tokenA = await staffToken({ email: "manager-a@staging.boombala.example.com", staffId: "stg-manager-a" });
const dbA = new pg.Client({ connectionString: process.env.FASTAPI_DATABASE_URL.replace("postgresql+psycopg://", "postgresql://") });
await dbA.connect();

const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

try {
  // 1. Manager A signs in, the catalog and calendar load without 403.
  await login(pageA, "manager-a@staging.boombala.example.com");
  await openCalendar(pageA);
  const bodyA = await pageA.locator("main").innerText();
  check("manager A calendar loads (catalog without 403)", bodyA.includes("Календарь") && !bodyA.includes("Не удалось загрузить"));
  const branchOptions = await pageA.locator('select[name="branch"] option').allInnerTexts();
  check("manager A (global booking role) sees every active branch from the catalog", branchOptions.length >= 2, branchOptions.join(", "));
  await shot(pageA, "01-manager-a-calendar");

  // 2. A creates and confirms 14:00–18:00 in Room A with a test manual prepayment; success only after read-back.
  await createBooking(pageA, { room: ROOM_A, start: "14:00", name: "Тест Клиент E2E A", price: 180000, prepay: 20000, phone: phoneA });
  const okA = await pageA.locator('[role="status"]').innerText().catch(() => "");
  check("A: booking 14:00–18:00 shown as verified only after FastAPI read-back", okA.includes("Проверено по данным системы"), okA);
  await shot(pageA, "02-a-booked-14-18");

  // 3. Manager B, in its own context, sees A's booking with the responsible name and the manual prepayment wording.
  await login(pageB, "manager-b@staging.boombala.example.com");
  await openCalendar(pageB);
  const bodyB = await pageB.locator("main").innerText();
  check("B sees A's booking with the manual prepayment label", bodyB.includes("Тест Клиент E2E A") && bodyB.includes("записана вручную"));
  await shot(pageB, "03-b-sees-a-booking");

  // 4. B tries 16:00–20:00 in the same room: refused with time_conflict, nothing new is written.
  const beforeCount = (await pageB.locator('[role="listitem"][data-reservation]').count());
  await createBooking(pageB, { room: ROOM_A, start: "16:00", name: "Тест Клиент Конфликт", price: 150000, prepay: 10000, phone: phoneB });
  check("B: 16:00–20:00 refused with time_conflict", (await alertWith(pageB, "Комната занята").count()) === 1);
  const afterCount = await pageB.locator('[role="listitem"][data-reservation]').count();
  check("B: conflicting attempt wrote no second reservation", afterCount === beforeCount);
  await shot(pageB, "04-b-conflict-409");

  // 5. Paid but unconfirmed request, created through the FastAPI kernel with a real manual prepayment (20 000 ₸).
  const requestId = await paidUnconfirmedRequest(tokenA, { branchId: BRANCH, packageId: PACKAGE_START, amountKzt: 20000, customerName: "Тест Оплачено", requestedDate: DATE });
  await openCalendar(pageB, `&request=${requestId}`);
  let pending = plain(await pageB.locator('section[aria-labelledby="paid-request"]').innerText().catch(() => ""));
  check("B: paid unconfirmed request shows FastAPI amount 20 000 ₸ and a no-repay confirm", pending.includes("20 000") && pending.includes("без повторной предоплаты"), pending.slice(0, 160));
  await shot(pageB, "05-b-paid-unconfirmed");

  // 5b. Forged URL hints: a request id FastAPI does not know, with success parameters: no success, no pending block.
  await openCalendar(pageB, "&request=00000000000000000000000000000000&ok=booked&reservation=fake&paid=1");
  const forged = await pageB.locator("main").innerText();
  check("forged ok/paid parameters show no success", !forged.includes("Проверено по данным системы") && !forged.includes("без повторной предоплаты"));
  check("unknown request state is reported as unknown", forged.includes("Не удалось прочитать заявку"));

  // 6. Real 409: the paid request is confirmed at 16:00 in Room A where 14:00–18:00 is held. Refused, fact kept.
  await openCalendar(pageB, `&request=${requestId}`);
  const form = pageB.locator('form:has(input[name="requestId"])');
  await form.locator('select[name="roomId"]').selectOption({ label: ROOM_A });
  await form.locator('select[name="startTime"]').selectOption("16:00");
  await form.locator('input[name="agreedPriceKzt"]').fill("150000");
  await form.locator('button[type="submit"]').click();
  await afterAction(pageB);
  check("B: confirm after payment shows time_conflict, not success", (await alertWith(pageB, "Комната занята").count()) === 1);
  const afterConflict = await lead(tokenA, requestId);
  check("FastAPI after 409: request not booked, payment fact still 20 000", afterConflict.body.bookedAt === null && afterConflict.body.manualPaymentFactAmountKzt === 20000, JSON.stringify({ bookedAt: afterConflict.body.bookedAt, fact: afterConflict.body.manualPaymentFactAmountKzt }));
  pending = plain(await pageB.locator('section[aria-labelledby="paid-request"]').innerText().catch(() => ""));
  check("after 409 the paid request stays visible with its id and a way forward", (await pageB.locator("main").innerText()).includes(requestId) && pending.includes("без повторной предоплаты"));
  await shot(pageB, "06-paid-409-kept");

  // 7. Confirm the same paid request at 18:00 in Room B: no second payment, success only after read-back.
  const form2 = pageB.locator('form:has(input[name="requestId"])');
  await form2.locator('select[name="roomId"]').selectOption({ label: ROOM_B });
  await form2.locator('select[name="startTime"]').selectOption("18:00");
  await form2.locator('input[name="agreedPriceKzt"]').fill("150000");
  await form2.locator('button[type="submit"]').click();
  await afterAction(pageB);
  const okB = await pageB.locator('[role="status"]').innerText().catch(() => "");
  check("B: paid request confirmed at 18:00 Room B, verified", okB.includes("Проверено по данным системы"), okB.slice(0, 60));
  const afterConfirm = await lead(tokenA, requestId);
  check("FastAPI: request booked, still exactly one payment fact of 20 000", afterConfirm.body.bookedAt !== null && afterConfirm.body.manualPaymentFactAmountKzt === 20000);
  const facts = await dbA.query("SELECT count(*)::int AS n FROM birthday_payment_facts WHERE birthday_request_id = $1", [requestId]);
  check("DB: exactly one manual payment fact for the request", facts.rows[0].n === 1, `n=${facts.rows[0].n}`);
  await shot(pageB, "07-paid-confirmed-no-repay");

  // 8. RBAC on manual blocks: the sales manager is refused by FastAPI (403), so the page says so and nothing is blocked.
  await openCalendar(pageA);
  const blockForm = pageA.locator('form:has(input[aria-label="Причина блокировки"])');
  await blockForm.locator('select[aria-label="Комната блокировки"]').selectOption({ label: ROOM_B });
  await blockForm.locator('select[aria-label="Начало блокировки"]').selectOption("10:00");
  await blockForm.locator('input[aria-label="Причина блокировки"]').fill("E2E блок менеджера");
  await blockForm.locator('button[type="submit"]').click();
  await afterAction(pageA);
  check("manager A: manual block refused with a clear forbidden message", (await alertWith(pageA, "Недостаточно прав").count()) === 1);
  check("manager A: refused block left no block on the grid", (await pageA.locator('[data-state="blocked"]').count()) === 0);
  await shot(pageA, "08-a-block-forbidden");

  // 8b. The owner (super_admin in FastAPI) blocks Room B 10:00–14:00 in its own context: verified.
  const ctxOwner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageOwner = await ctxOwner.newPage();
  await login(pageOwner, "owner-a@staging.boombala.example.com");
  await openCalendar(pageOwner);
  const ownerBlock = pageOwner.locator('form:has(input[aria-label="Причина блокировки"])');
  await ownerBlock.locator('select[aria-label="Комната блокировки"]').selectOption({ label: ROOM_B });
  await ownerBlock.locator('select[aria-label="Начало блокировки"]').selectOption("10:00");
  await ownerBlock.locator('input[aria-label="Причина блокировки"]').fill("E2E блок");
  await ownerBlock.locator('button[type="submit"]').click();
  await afterAction(pageOwner);
  const blockOk = await pageOwner.locator('main [role="status"]').innerText().catch(() => "");
  check("owner: manual block verified", blockOk.includes("Время заблокировано"), blockOk.slice(0, 60));
  await shot(pageOwner, "08b-owner-block");
  await ctxOwner.close();

  // 9. A cancels the 14:00–18:00 booking. The history keeps it as cancelled and the room is free in the grid.
  const bookingCard = pageA.locator("article", { hasText: "Тест Клиент E2E A" }).first();
  await bookingCard.locator("summary", { hasText: "Отменить бронь" }).click();
  await bookingCard.locator('button:has-text("Отменить бронь")').click();
  await afterAction(pageA);
  const releasedOk = await pageA.locator('[role="status"]').innerText().catch(() => "");
  check("A: release verified", releasedOk.includes("Бронь отменена"), releasedOk.slice(0, 60));
  const history = await pageA.locator("main").innerText();
  check("history keeps the cancelled booking", history.includes("Отменено"));
  await shot(pageA, "09-a-cancelled-history");

  // 10. Token revocation: the FastAPI bridge session of manager A is revoked; the next load re-issues and works.
  await dbA.query("UPDATE admin_sessions SET revoked_at = now() WHERE admin_user_id = 'stg-manager-a' AND revoked_at IS NULL");
  await openCalendar(pageA);
  const afterRevoke = await pageA.locator("main").innerText();
  check("after revocation the calendar re-issues a token and loads", afterRevoke.includes("Календарь") && !afterRevoke.includes("Не удалось загрузить"));

  // 11. Unlink manager A: nothing is sent to FastAPI; relink restores access.
  const env = { ...process.env, DATABASE_URL: process.env.PLATFORM_DATABASE_URL };
  execFileSync("npm", ["run", "-s", "user:link-fastapi", "--", "--email", "manager-a@staging.boombala.example.com", "--unlink"], { cwd: process.cwd(), env, stdio: "pipe" });
  await openCalendar(pageA);
  const unlinked = await pageA.locator("main").innerText();
  check("unlinked manager A is refused (fail closed)", unlinked.includes("Не удалось загрузить") && !unlinked.includes("Новая бронь"));
  await shot(pageA, "11-a-unlinked-fail-closed");
  execFileSync("npm", ["run", "-s", "user:link-fastapi", "--", "--email", "manager-a@staging.boombala.example.com", "--admin-user-id", "stg-manager-a"], { cwd: process.cwd(), env, stdio: "pipe" });
  await openCalendar(pageA);
  check("relinked manager A works again", (await pageA.locator("main").innerText()).includes("Новая бронь"));

  // 12. Logout invalidates the Platform session; login again works.
  await pageA.click('button:has-text("Выйти")');
  await pageA.waitForURL((u) => u.pathname.startsWith("/login") || u.pathname === "/", { timeout: 15000 });
  await pageA.goto(`${ADMIN}/bookings`);
  check("logged-out context cannot open the calendar", pageA.url().includes("/login"));
  await login(pageA, "manager-a@staging.boombala.example.com");
  await openCalendar(pageA);
  check("logout then login restores the calendar", (await pageA.locator("main").innerText()).includes("Календарь"));

  // 12b. RBAC in the Platform: an editor (no bookings.manage) cannot open the calendar at all.
  const editorEmail = "editor-e2e@staging.boombala.example.com";
  try {
    execFileSync("npm", ["run", "-s", "user:create", "--", "--email", editorEmail, "--name", "E2E редактор", "--role", "editor"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.PLATFORM_DATABASE_URL, BB_PASSWORD: PW }, stdio: "pipe",
    });
  } catch {
    // Already exists from an earlier run.
  }
  const ctxEditor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageEditor = await ctxEditor.newPage();
  await login(pageEditor, editorEmail);
  await pageEditor.goto(`${ADMIN}/bookings?branch=${BRANCH}&date=${DATE}`);
  await pageEditor.waitForLoadState("networkidle");
  const editorBody = await pageEditor.locator("body").innerText();
  check("editor cannot open the calendar (no grid, no booking form)", !editorBody.includes("Новая бронь на 4 часа") && !editorBody.includes("Занятость"));
  await ctxEditor.close();

  // 12c. Branch scope: an unknown or foreign branch id in the URL never reaches FastAPI; the page falls back to a visible branch.
  await pageA.goto(`${ADMIN}/bookings?branch=foreign-branch-id&date=${DATE}`);
  await pageA.waitForLoadState("networkidle");
  const selectedBranch = await pageA.locator('select[name="branch"]').inputValue();
  check("branch scope: a foreign branch id falls back to a visible branch", selectedBranch === "stg-almaty" || selectedBranch === "stg-shymkent", selectedBranch);

  // 12d. Session expiry: an expired Platform session is refused on the next request and sent to login.
  const platformDb = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
  await platformDb.connect();
  await platformDb.query("UPDATE bb.sessions SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM bb.users WHERE email = $1) AND revoked_at IS NULL", ["manager-a@staging.boombala.example.com"]);
  await platformDb.end();
  await pageA.goto(`${ADMIN}/bookings?branch=${BRANCH}&date=${DATE}`);
  await pageA.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 15000 }).catch(() => {});
  check("expired Platform session is sent to login", pageA.url().includes("/login"), pageA.url());
  await login(pageA, "manager-a@staging.boombala.example.com");

  // 13. Tablet width: no horizontal page overflow.
  await pageA.setViewportSize({ width: 768, height: 1024 });
  await openCalendar(pageA);
  const overflow = await pageA.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("tablet 768px: no horizontal page overflow", overflow <= 1, `overflow=${overflow}`);
  await shot(pageA, "13-tablet");
} catch (error) {
  check("E2E ran to completion", false, error instanceof Error ? error.message : String(error));
} finally {
  writeFileSync(join(ART, "results.json"), JSON.stringify({ at: new Date().toISOString(), date: DATE, results }, null, 2));
  await dbA.end();
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
