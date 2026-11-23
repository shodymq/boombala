// Booking V2 in a real browser, production-like topology, synthetic local data. Two managers work on the same event.
//
//   npm run build && npm run e2e:booking-card
//
// Self-contained: it starts its own throwaway PostgreSQL cluster (all migrations incl. 017 and 018, the site catalog, the real
// db:roles privileges), a BRIDGE process that owns the database as bb_admin ("the VPS"), and a FRONTEND process with
// CRM_BRIDGE_MODE=legacy and no database variable ("Vercel"). The processes run with VERCEL_ENV=preview so the kz-production
// profile gate does not demand TLS, hosts and MFA; sessions, RBAC and the bridge token are unchanged.
// Scenario: create a booking, fill the program, edit by the other manager, stale-edit conflict, program approval rules,
// move, creator preserved, history, double booking refused, two events in a shared hall, cancellation.
import { chromium, webkit } from "playwright-core";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRoles } from "../scripts/db-roles.ts";
import { findFreePort, initCluster, startCluster, stopCluster } from "../scripts/lib/cluster.mjs";
import { createPool } from "../src/core/db.ts";
import { migrate } from "../src/core/migrate.ts";
import { seedCatalog } from "../src/core/seed.ts";
import { createUser } from "../src/core/users.ts";
import { syntheticPhone } from "../tests/helpers/synthetic-data.ts";
import { birthdayPackages } from "../../src/data/birthdays.ts";
import { birthdayRooms } from "../../src/data/birthdayRooms.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PW = `BbE2e-${randomBytes(24).toString("base64url")}`;
const TOKEN = randomBytes(24).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);

// ── database ────────────────────────────────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "bb-card-e2e-"));
const data = join(dir, "data");
const dbPort = await findFreePort();
initCluster(data);
const socketDir = startCluster(data, dbPort, { fast: true });
const DB = `postgres://postgres@127.0.0.1:${dbPort}/postgres`;
const owner = createPool(DB, { max: 4 });
await owner.query("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;");
await migrate(owner, join(root, "migrations"));
await seedCatalog(owner, {
  packages: birthdayPackages.map((p) => ({ id: p.id, name: p.copy.ru.name, price: p.weekendPrice, weekdayPrice: p.weekdayPrice })),
  rooms: birthdayRooms.map((r) => ({ id: r.id, name: r.name })),
});
const ADMIN_PW = "adm" + randomBytes(12).toString("hex");
await applyRoles(owner, { apiPassword: "api" + randomBytes(12).toString("hex") + "A1", adminPassword: ADMIN_PW });
const named = async (email, name) => {
  const u = await createUser(owner, null, { email, name, role: "manager", password: PW });
  await owner.query("UPDATE bb.users SET name = $2 WHERE id = $1", [u.id, name]);
  return u;
};
const mainPhone = syntheticPhone();
const conflictPhone = syntheticPhone();
const sharedPhoneOne = syntheticPhone();
const sharedPhoneTwo = syntheticPhone();
await named("manager-a@e2e.test", "Synthetic Manager A");
await named("manager-b@e2e.test", "Synthetic Manager B");
await createUser(owner, null, { email: "editor@e2e.test", name: "Synthetic Editor", role: "editor", password: PW });
const adminUrl = new URL(DB);
adminUrl.username = "bb_admin";
adminUrl.password = ADMIN_PW;

// ── processes ───────────────────────────────────────────────────────────────────────────────────────────────────
const P = { front: 3420, bridge: 3421 };
const children = [];
function start(name, port, env) {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env: { ...process.env, VERCEL_ENV: "preview", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`));
}
const cleanup = async () => {
  children.forEach((c) => c.kill("SIGTERM"));
  await owner.end().catch(() => {});
  stopCluster(data, socketDir);
  rmSync(dir, { recursive: true, force: true });
};
process.on("SIGINT", async () => { await cleanup(); process.exit(1); });
start("bridge", P.bridge, { DATABASE_URL: adminUrl.toString(), CRM_SERVICE_TOKEN: TOKEN, PLATFORM_ROLE: "admin", DATABASE_POOL_MAX: "5" });
start("front", P.front, { CRM_BRIDGE_MODE: "legacy", CRM_BRIDGE_URL: `http://127.0.0.1:${P.bridge}`, CRM_SERVICE_TOKEN: TOKEN, UNIFIED_FASTAPI_CRM_ENABLED: "1", DATABASE_URL: "" });
for (const port of [P.bridge, P.front]) {
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" }); break; } catch { await sleep(500); }
  }
}
const FRONT = `http://127.0.0.1:${P.front}`;

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browserType = process.env.E2E_BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ ...(browserType === chromium ? { executablePath: chrome } : {}), headless: true });
const errors = [];
async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.stack ?? e.message}`));
  await page.goto(`${FRONT}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  return page;
}
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }));

const plusDays = (n) => new Date(Date.now() + 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const D = plusDays(30);
const text = async (page, sel = "body") => (await page.locator(sel).first().innerText()).replace(/\s+/g, " ");
const dbOne = async (sql, p = []) => (await owner.query(sql, p)).rows[0];
let checkedMobileTimeStep = false;

async function createBooking(page, { name, phone, room, start, pkg = "star-party", child, extra = {} }) {
  await page.goto(`${FRONT}/bookings?date=${D}`);
  await page.locator(`[data-mobile-room="${room}"]`).getByRole("link", { name: /Создать бронь ·/ }).click();
  await page.waitForSelector('form[aria-label="Новая бронь"]');
  await page.fill('input[name="customerName"]', name);
  await page.fill('input[name="phone"]', phone);
  await page.selectOption('select[name="roomId"]', room);
  if (!checkedMobileTimeStep) {
    const time = page.locator('form[aria-label="Новая бронь"] input[name="startTime"]');
    ok((await time.getAttribute("step")) === "3600", "the booking form uses full-hour time steps");
    await time.fill("13:30");
    ok(await time.evaluate((el) => !el.validity.valid && !el.form.checkValidity()), "the mobile form rejects a non-hour start before submission");
    checkedMobileTimeStep = true;
  }
  await page.fill('input[name="startTime"]', start);
  await page.selectOption('select[name="packageId"]', pkg);
  await page.fill('input[name="agreedPriceKzt"]', "79900");
  if (child) await page.fill('input[name="childName"]', child);
  for (const [k, v] of Object.entries(extra)) {
    const sel = `[name="${k}"]`;
    if ((await page.locator(sel).evaluate((el) => el.tagName)) === "SELECT") await page.selectOption(sel, v);
    else await page.fill(sel, String(v));
  }
  await page.click('form[aria-label="Новая бронь"] button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await sleep(300);
}
const reservationOf = async (phone) =>
  (await dbOne(
    `SELECT r.id FROM bb.slot_reservations r JOIN bb.contacts c ON c.id = r.contact_id WHERE c.phone_e164 = $1 AND r.released_at IS NULL ORDER BY r.created_at DESC LIMIT 1`,
    [phone],
  ))?.id;
const openCard = async (page, id) => {
  await page.goto(`${FRONT}/bookings?date=${D}&reservation=${id}&card=1`);
  await page.waitForSelector('[data-testid="booking-card-form"]');
};

try {
  const anna = await session("manager-a@e2e.test");
  const boris = await session("manager-b@e2e.test");
  const editor = await session("editor@e2e.test");
  const editorPrimaryHrefs = await editor.locator("nav[aria-label='Быстрая навигация'] a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  ok(editorPrimaryHrefs.includes("/") && !["/requests", "/bookings", "/operations"].some((href) => editorPrimaryHrefs.includes(href)), "mobile quick navigation hides sections outside editor RBAC");
  await editor.getByRole("button", { name: "Меню" }).click();
  const editorNavHrefs = await editor.locator("nav[aria-label='Разделы'] a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  ok(!["/requests", "/bookings", "/operations"].some((href) => editorNavHrefs.includes(href)), "secondary mobile menu also respects editor RBAC");
  await editor.context().close();

  console.log("0. Mobile layout at required widths, without horizontal page overflow");
  for (const width of [320, 360, 375, 390, 430, 1440]) {
    await anna.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await anna.goto(`${FRONT}/bookings?date=${D}`);
    await anna.waitForSelector(width < 768 ? "[data-mobile-calendar]" : "[data-timeline]");
    const overflow = await anna.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 1, `${width}px calendar has no horizontal overflow (actual ${overflow}px)`);
    if (width === 1440) await shot(anna, "06-desktop-calendar-1440");
    if (width === 390) {
      const links = await anna.locator("nav[aria-label='Быстрая навигация'] a").evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }));
      ok(links.length === 4 && links.every((r) => r.width >= 44 && r.height >= 44), "mobile primary navigation has 44px touch targets");
      await shot(anna, "00-mobile-calendar-390");
    }
  }
  await anna.setViewportSize({ width: 390, height: 450 });
  await anna.goto(`${FRONT}/bookings?date=${D}`);
  await anna.locator('[data-mobile-room="roblox-room"]').getByRole("link", { name: /Создать бронь ·/ }).click();
  const mobileSubmit = anna.locator('form[aria-label="Новая бронь"] button[type="submit"]');
  await mobileSubmit.scrollIntoViewIfNeeded();
  const mobileSubmitIsReachable = await mobileSubmit.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
    return r.height >= 44 && r.top >= 0 && r.bottom <= window.innerHeight && document.elementFromPoint(x, y) === el;
  });
  ok(mobileSubmitIsReachable, "booking CTA remains visible and tappable in the short viewport used when the keyboard is open");
  await shot(anna, "00-mobile-booking-short-viewport");
  await anna.getByRole("link", { name: "Закрыть" }).click();
  await anna.setViewportSize({ width: 390, height: 844 });

  console.log("1. Synthetic Manager A creates a Star Party booking with the customer card");
  await createBooking(anna, { name: "Synthetic Customer A", phone: mainPhone, room: "roblox-room", start: "13:00", child: "Synthetic Birthday Child", extra: { childAge: 7, childrenTotal: 9, adultsTotal: 2, preferredLanguage: "kk" } });
  let id = await reservationOf(mainPhone);
  ok(Boolean(id), "the booking exists in PostgreSQL");
  ok((await text(anna)).includes("Бронь создана и подтверждена"), "the calendar confirms it from the system's own state");
  const prepaid = await dbOne("SELECT amount_kzt FROM bb.manual_payment_facts f JOIN bb.lead_requests l ON l.id = f.lead_request_id JOIN bb.slot_reservations r ON r.lead_request_id = l.id WHERE r.id = $1", [id]);
  ok(prepaid?.amount_kzt === 10000, "the 10 000 ₸ prepayment is a recorded manual fact");
  await shot(anna, "01-calendar-after-create");

  console.log("2. The card shows the data, the V4.2 terms and an honest, incomplete amount");
  await openCard(anna, id);
  const card = await text(anna);
  ok(card.includes("условия v4.2"), "the package terms version is recorded");
  ok((await anna.inputValue('input[name="childName"]')) === "Synthetic Birthday Child" && (await anna.inputValue('input[name="childAge"]')) === "7", "synthetic child name and age are saved");
  ok((await anna.inputValue('input[name="childrenTotal"]')) === "9" && (await anna.inputValue('input[name="adultsTotal"]')) === "2", "children and adults are saved");
  ok((await anna.inputValue('select[name="preferredLanguage"]')) === "kk", "language is saved");
  ok(card.includes("Создал Synthetic Manager A"), "the synthetic creator is shown");
  ok((await text(anna, "[data-card-total]")) === "не рассчитано", "no approved extra-guest tariff: the total is not invented");
  ok((await text(anna, "[data-pricing-incomplete]")).includes("тариф входа дополнительных детей"), "the reason is explained");
  ok((await text(anna, "[data-card-remaining]")).includes("неизвестен"), "the remainder is unknown, not zero");
  ok((await anna.locator('fieldset[data-program-kind="show"] input').count()) === 4, "Star: 4 shows offered");
  ok((await anna.locator('fieldset[data-program-kind="challenge"] input').count()) === 4, "Star: 4 challenges offered");
  ok((await anna.locator('fieldset[data-program-kind="master_class"]').count()) === 0, "Star: no master class");
  await shot(anna, "02-card-star");

  console.log("3. Synthetic Manager B fills the program and approves it");
  await openCard(boris, id);
  ok(await boris.locator('fieldset[data-program-kind="show"] input[value="beauty-bar"]').count() === 0, "a Boom Bala-only show is not offered for Star");
  await boris.check('fieldset[data-program-kind="show"] input[value="silver-show"]');
  await boris.check('fieldset[data-program-kind="show"] input[value="neon-show"]');
  await boris.check('fieldset[data-program-kind="challenge"] input[value="fortune-wheel"]');
  await boris.check('fieldset[data-program-kind="animation"] input[value="board-games"]');
  await boris.selectOption('select[name="propsStatus"]', "preparing");
  await boris.selectOption('select[name="responsibleUserId"]', { label: "Synthetic Manager B" });
  await boris.fill('textarea[name="wishes"]', "Без орехов");
  await boris.check('input[name="programApproved"]');
  await boris.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await boris.waitForURL(/saved=card/);
  if (process.env.E2E_VERBOSE) console.log("    page alerts:", await boris.locator('[role="alert"], [role="status"]').allInnerTexts(), boris.url());
  ok((await text(boris)).includes("Карточка сохранена"), "saved by the second manager");
  ok((await text(boris)).includes("программа: согласована"), "«Программа согласована» is set (server validated the full program)");
  ok((await text(boris)).includes("Создал Synthetic Manager A") && (await text(boris)).includes("Ответственный Synthetic Manager B"), "creator stays Manager A; responsible is Manager B");
  await shot(boris, "03-card-approved");

  console.log("4. Manager A's stale form is refused, not silently overwriting Manager B");
  await anna.fill('textarea[name="wishes"]', "Перезапись");
  await anna.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await anna.locator('[data-booking-action-error="card_version_conflict"]').waitFor();
  ok((await text(anna)).includes("Другой сотрудник изменил карточку"), "version conflict message");
  ok((await anna.inputValue('textarea[name="wishes"]')) === "Перезапись", "the stale form keeps the unsaved value until the manager refreshes");
  await openCard(anna, id);
  ok((await anna.inputValue('textarea[name="wishes"]')) === "Без орехов", "the page now shows Boris's saved data");

  console.log("5. Approval is validated on the server");
  await openCard(boris, id);
  await boris.uncheck('fieldset[data-program-kind="show"] input[value="neon-show"]');
  await boris.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await boris.locator('[data-booking-action-error="program_incomplete"]').waitFor();
  ok((await text(boris)).includes("Программу нельзя согласовать"), "an incomplete program cannot stay approved");
  ok((await dbOne("SELECT program_status FROM bb.booking_cards WHERE reservation_id = $1", [id])).program_status === "approved", "nothing changed in the database");
  await openCard(boris, id);
  await boris.uncheck('fieldset[data-program-kind="show"] input[value="neon-show"]');
  await boris.uncheck('input[name="programApproved"]');
  await boris.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await boris.waitForURL(/saved=card/);
  ok((await text(boris)).includes("программа: не согласована"), "the approval can be withdrawn and the program stays a draft");

  console.log("6. Boris moves the event; the card follows and the creator is preserved");
  await boris.goto(`${FRONT}/bookings?date=${D}&reservation=${id}&move=1`);
  await boris.waitForSelector('form[aria-label="Перенос брони"]');
  await boris.selectOption('form[aria-label="Перенос брони"] select[name="roomId"]', "ice-room");
  await boris.fill('form[aria-label="Перенос брони"] input[name="startTime"]', "15:00");
  await boris.click('form[aria-label="Перенос брони"] button[type="submit"]');
  await boris.waitForLoadState("networkidle");
  await sleep(300);
  const movedId = await reservationOf(mainPhone);
  ok(movedId && movedId !== id, "a new reservation row was written by the move");
  await openCard(boris, movedId);
  ok((await boris.inputValue('input[name="childName"]')) === "Synthetic Birthday Child", "the card followed the event");
  ok((await text(boris)).includes("Создал Synthetic Manager A"), "the original creator is preserved");
  ok((await text(boris, "[data-card-history]")).includes("Бронь перенесена · Synthetic Manager B"), "the move is in the history, by Manager B");
  ok((await dbOne("SELECT count(*)::int n FROM bb.booking_cards WHERE lead_request_id = (SELECT lead_request_id FROM bb.slot_reservations WHERE id = $1)", [movedId])).n === 1, "still one card");
  await shot(boris, "04-card-history");

  console.log("7. Double booking is refused; a shared hall takes simultaneous events");
  await createBooking(anna, { name: "Synthetic Customer B", phone: conflictPhone, room: "ice-room", start: "16:00" });
  ok(!(await reservationOf(conflictPhone)), "no second reservation in an occupied exclusive room");
  ok((await text(anna)).includes("Комната занята"), "the manager is told, not silently accepted");
  ok((await anna.inputValue('input[name="customerName"]')) === "Synthetic Customer B", "the conflict leaves the synthetic customer name in the form");
  ok((await anna.inputValue('input[name="phone"]')) === conflictPhone, "the conflict leaves the phone in the form");
  ok((await anna.inputValue('select[name="roomId"]')) === "ice-room" && (await anna.inputValue('input[name="startTime"]')) === "16:00", "the conflict leaves the requested room and time in the form");
  await createBooking(anna, { name: "Synthetic Shared Customer A", phone: sharedPhoneOne, room: "general-hall", start: "11:00" });
  await createBooking(boris, { name: "Synthetic Shared Customer B", phone: sharedPhoneTwo, room: "general-hall", start: "12:00" });
  ok(Boolean(await reservationOf(sharedPhoneOne)) && Boolean(await reservationOf(sharedPhoneTwo)), "two overlapping events in the shared hall");
  await anna.goto(`${FRONT}/bookings?date=${D}`);
  await anna.waitForSelector("[data-summary-counts]");
  await shot(anna, "05-calendar-shared-hall");

  console.log("8. Manager A cancels; the history keeps it");
  await anna.goto(`${FRONT}/bookings?date=${D}&reservation=${movedId}`);
  await anna.locator("summary", { hasText: "Отменить бронь" }).click();
  await anna.fill('input[name="reason"]', "Synthetic E2E cancellation");
  await anna.click('form[action] button:has-text("Отменить бронь")');
  await anna.waitForLoadState("networkidle");
  await sleep(300);
  await openCard(anna, movedId);
  ok((await text(anna, "[data-card-history]")).includes("Бронь отменена · Synthetic Manager A"), "the cancellation is in the history");
  ok((await anna.locator("fieldset[disabled]").count()) >= 1, "a cancelled event is read-only");
  ok((await dbOne("SELECT amount_kzt FROM bb.manual_payment_facts WHERE lead_request_id = (SELECT lead_request_id FROM bb.slot_reservations WHERE id = $1)", [movedId])).amount_kzt === 10000, "the prepayment fact is untouched");

  console.log("9. Page errors");
  ok(errors.length === 0, `no uncaught page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} catch (error) {
  fails++;
  console.error("E2E ERROR:", error);
} finally {
  await browser.close();
  await cleanup();
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
