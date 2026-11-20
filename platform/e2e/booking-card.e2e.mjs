// Booking V2 in a real browser, production-like topology, synthetic local data. Two managers work on the same event.
//
//   npm run build && node --no-warnings e2e/booking-card.e2e.mjs
//
// Self-contained: it starts its own throwaway PostgreSQL cluster (all migrations incl. 017 and 018, the site catalog, the real
// db:roles privileges), a BRIDGE process that owns the database as bb_admin ("the VPS"), and a FRONTEND process with
// CRM_BRIDGE_MODE=legacy and no database variable ("Vercel"). The processes run with VERCEL_ENV=preview so the kz-production
// profile gate does not demand TLS, hosts and MFA; sessions, RBAC and the bridge token are unchanged.
// Scenario: create a booking, fill the program, edit by the other manager, stale-edit conflict, program approval rules,
// move, creator preserved, history, double booking refused, two events in a shared hall, cancellation.
import { chromium } from "playwright-core";
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
import { birthdayPackages } from "../../src/data/birthdays.ts";
import { birthdayRooms } from "../../src/data/birthdayRooms.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PW = "correct horse battery staple " + Date.now();
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
  packages: birthdayPackages.map((p) => ({ id: p.id, name: p.name, price: p.price, weekdayPrice: p.weekdayPrice })),
  rooms: birthdayRooms.map((r) => ({ id: r.id, name: r.name })),
});
const ADMIN_PW = "adm" + randomBytes(12).toString("hex");
await applyRoles(owner, { apiPassword: "api" + randomBytes(12).toString("hex") + "A1", adminPassword: ADMIN_PW });
const named = async (email, name) => {
  const u = await createUser(owner, null, { email, name, role: "manager", password: PW });
  await owner.query("UPDATE bb.users SET name = $2 WHERE id = $1", [u.id, name]);
  return u;
};
await named("anna@e2e.test", "Анна");
await named("boris@e2e.test", "Борис");
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
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
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

async function createBooking(page, { name, phone, room, start, pkg = "star-party", child, extra = {} }) {
  await page.goto(`${FRONT}/bookings?date=${D}&new=1`);
  await page.waitForSelector('form[aria-label="Новая бронь"]');
  await page.fill('input[name="customerName"]', name);
  await page.fill('input[name="phone"]', phone);
  await page.selectOption('select[name="roomId"]', room);
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
  const anna = await session("anna@e2e.test");
  const boris = await session("boris@e2e.test");

  console.log("1. Anna creates a Star Party booking with the customer card");
  await createBooking(anna, { name: "Тест Клиент", phone: "+77075550201", room: "roblox-room", start: "13:25", child: "Алия", extra: { childAge: 7, childrenTotal: 9, adultsTotal: 2, preferredLanguage: "kk" } });
  let id = await reservationOf("+77075550201");
  ok(Boolean(id), "the booking exists in PostgreSQL");
  ok((await text(anna)).includes("Бронь создана и подтверждена"), "the calendar confirms it from the system's own state");
  const prepaid = await dbOne("SELECT amount_kzt FROM bb.manual_payment_facts f JOIN bb.lead_requests l ON l.id = f.lead_request_id JOIN bb.slot_reservations r ON r.lead_request_id = l.id WHERE r.id = $1", [id]);
  ok(prepaid?.amount_kzt === 10000, "the 10 000 ₸ prepayment is a recorded manual fact");
  await shot(anna, "01-calendar-after-create");

  console.log("2. The card shows the data, the V4.2 terms and an honest, incomplete amount");
  await openCard(anna, id);
  const card = await text(anna);
  ok(card.includes("условия v4.2"), "the package terms version is recorded");
  ok((await anna.inputValue('input[name="childName"]')) === "Алия" && (await anna.inputValue('input[name="childAge"]')) === "7", "child name and age are saved");
  ok((await anna.inputValue('input[name="childrenTotal"]')) === "9" && (await anna.inputValue('input[name="adultsTotal"]')) === "2", "children and adults are saved");
  ok((await anna.inputValue('select[name="preferredLanguage"]')) === "kk", "language is saved");
  ok(card.includes("Создал Анна"), "the creator is shown");
  ok((await text(anna, "[data-card-total]")) === "не рассчитано", "no approved extra-guest tariff: the total is not invented");
  ok((await text(anna, "[data-pricing-incomplete]")).includes("тариф входа дополнительных детей"), "the reason is explained");
  ok((await text(anna, "[data-card-remaining]")).includes("неизвестен"), "the remainder is unknown, not zero");
  ok((await anna.locator('fieldset[data-program-kind="show"] input').count()) === 4, "Star: 4 shows offered");
  ok((await anna.locator('fieldset[data-program-kind="challenge"] input').count()) === 4, "Star: 4 challenges offered");
  ok((await anna.locator('fieldset[data-program-kind="master_class"]').count()) === 0, "Star: no master class");
  await shot(anna, "02-card-star");

  console.log("3. Boris (another manager) fills the program and approves it");
  await openCard(boris, id);
  ok(await boris.locator('fieldset[data-program-kind="show"] input[value="beauty-bar"]').count() === 0, "a Boom Bala-only show is not offered for Star");
  await boris.check('fieldset[data-program-kind="show"] input[value="silver-show"]');
  await boris.check('fieldset[data-program-kind="show"] input[value="neon-show"]');
  await boris.check('fieldset[data-program-kind="challenge"] input[value="fortune-wheel"]');
  await boris.check('fieldset[data-program-kind="animation"] input[value="board-games"]');
  await boris.selectOption('select[name="propsStatus"]', "preparing");
  await boris.selectOption('select[name="responsibleUserId"]', { label: "Борис" });
  await boris.fill('textarea[name="wishes"]', "Без орехов");
  await boris.check('input[name="programApproved"]');
  await boris.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await boris.waitForURL(/saved=card/);
  if (process.env.E2E_VERBOSE) console.log("    page alerts:", await boris.locator('[role="alert"], [role="status"]').allInnerTexts(), boris.url());
  ok((await text(boris)).includes("Карточка сохранена"), "saved by the second manager");
  ok((await text(boris)).includes("программа: согласована"), "«Программа согласована» is set (server validated the full program)");
  ok((await text(boris)).includes("Создал Анна") && (await text(boris)).includes("Ответственный Борис"), "creator stays Anna; responsible is Boris");
  await shot(boris, "03-card-approved");

  console.log("4. Anna's stale form is refused, not silently overwriting Boris");
  await anna.fill('textarea[name="wishes"]', "Перезапись");
  await anna.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await anna.waitForURL(/cerror=card_version_conflict/);
  ok((await text(anna)).includes("уже изменил другой менеджер"), "version conflict message");
  ok((await anna.inputValue('textarea[name="wishes"]')) === "Без орехов", "the page now shows Boris's saved data");

  console.log("5. Approval is validated on the server");
  await openCard(boris, id);
  await boris.uncheck('fieldset[data-program-kind="show"] input[value="neon-show"]');
  await boris.click('form[aria-label="Карточка брони"] button[type="submit"]');
  await boris.waitForURL(/cerror=program_incomplete/);
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
  await boris.fill('form[aria-label="Перенос брони"] input[name="startTime"]', "15:10");
  await boris.click('form[aria-label="Перенос брони"] button[type="submit"]');
  await boris.waitForLoadState("networkidle");
  await sleep(300);
  const movedId = await reservationOf("+77075550201");
  ok(movedId && movedId !== id, "a new reservation row was written by the move");
  await openCard(boris, movedId);
  ok((await boris.inputValue('input[name="childName"]')) === "Алия", "the card followed the event");
  ok((await text(boris)).includes("Создал Анна"), "the original creator is preserved");
  ok((await text(boris, "[data-card-history]")).includes("Бронь перенесена · Борис"), "the move is in the history, by Boris");
  ok((await dbOne("SELECT count(*)::int n FROM bb.booking_cards WHERE lead_request_id = (SELECT lead_request_id FROM bb.slot_reservations WHERE id = $1)", [movedId])).n === 1, "still one card");
  await shot(boris, "04-card-history");

  console.log("7. Double booking is refused; a shared hall takes simultaneous events");
  await createBooking(anna, { name: "Второй Клиент", phone: "+77075550202", room: "ice-room", start: "16:00" });
  ok(!(await reservationOf("+77075550202")), "no second reservation in an occupied exclusive room");
  ok((await text(anna)).includes("Комната занята"), "the manager is told, not silently accepted");
  await createBooking(anna, { name: "Зал Один", phone: "+77075550203", room: "general-hall", start: "11:00" });
  await createBooking(boris, { name: "Зал Два", phone: "+77075550204", room: "general-hall", start: "12:00" });
  ok(Boolean(await reservationOf("+77075550203")) && Boolean(await reservationOf("+77075550204")), "two overlapping events in the shared hall");
  await anna.goto(`${FRONT}/bookings?date=${D}`);
  await anna.waitForSelector("[data-summary-counts]");
  await shot(anna, "05-calendar-shared-hall");

  console.log("8. Anna cancels; the history keeps it");
  await anna.goto(`${FRONT}/bookings?date=${D}&reservation=${movedId}`);
  await anna.locator("summary", { hasText: "Отменить бронь" }).click();
  await anna.fill('input[name="reason"]', "Семья отказалась");
  await anna.click('form[action] button:has-text("Отменить бронь")');
  await anna.waitForLoadState("networkidle");
  await sleep(300);
  await openCard(anna, movedId);
  ok((await text(anna, "[data-card-history]")).includes("Бронь отменена · Анна"), "the cancellation is in the history");
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
