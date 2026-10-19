// End-to-end check of the running platform in a real browser (login, roles, forged action, foreign origin, logout, lockout).
//   PLATFORM_URL=http://localhost:3100 DATABASE_URL=... E2E_PASSWORD=... [E2E_CHROME=/path/to/chrome] npm run e2e
// The three QA users (owner@/manager@/editor@qa.test) must exist with E2E_PASSWORD (see README).
import { mkdirSync } from "node:fs";
import pg from "pg";
import { chromium } from "playwright-core";

const B = process.env.PLATFORM_URL ?? "http://localhost:3100";
const PW = process.env.E2E_PASSWORD;
const DB = process.env.DATABASE_URL;
const OUT = process.env.E2E_SCREENSHOTS ?? "";
if (!PW || !DB) throw new Error("E2E_PASSWORD and DATABASE_URL are required");
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) throw new Error("e2e refuses to run against a non-local server: " + B);
if (OUT) mkdirSync(OUT, { recursive: true });
const shot = (page, name, opts = {}) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png`, ...opts }) : Promise.resolve());

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const scalar = async (q) => String((await pool.query(q)).rows[0].v);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });

let fails = 0;
const ok = (cond, msg) => {
  console.log(cond ? "  ok  " : "  FAIL", msg);
  if (!cond) fails++;
};
const login = async (page, email, password) => {
  await page.goto(B + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForTimeout(900);
};
const open = async (w, h, mobile) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  return { ctx, page, errs };
};
// No sideways scroll, and the mobile layout viewport was not stretched by over-wide content (innerWidth must stay the device width).
const noHScroll = (page, width) =>
  page.evaluate((w) => {
    scrollTo({ left: 300, top: 0, behavior: "instant" });
    const x = scrollX;
    scrollTo(0, 0);
    return x === 0 && innerWidth === w && document.documentElement.scrollWidth <= w;
  }, width);

console.log("## login (390x844)");
{
  const { ctx, page, errs } = await open(390, 844, true);
  await page.goto(B + "/login", { waitUntil: "networkidle" });
  await shot(page, "390-login");
  ok((await page.locator("meta[name=robots]").getAttribute("content")).includes("noindex"), "login page is noindex");
  await login(page, "owner@qa.test", "wrong password here");
  ok((await page.locator("form [role=alert]").innerText()).includes("Неверный e-mail или пароль"), "wrong password gives the generic message");
  await login(page, "nobody@qa.test", "wrong password here");
  ok((await page.locator("form [role=alert]").innerText()).includes("Неверный e-mail или пароль"), "unknown e-mail gives the same message");
  await login(page, "owner@qa.test", PW);
  ok(new URL(page.url()).pathname === "/", "right password opens the dashboard");
  const cookie = (await ctx.cookies()).find((c) => c.name === "bb_session");
  ok(!!cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/", "session cookie is HttpOnly, SameSite=Lax, Path=/");
  ok(!(await page.evaluate(() => document.cookie)).includes("bb_session"), "cookie is not readable from JavaScript");
  ok((await scalar(`SELECT count(*) AS v FROM sessions WHERE encode(token_hash,'hex') = '${cookie.value}'`)) === "0", "the raw token is not stored in the database");
  const text = (await page.locator("main").innerText()).replace(/[\u00a0\u202f]/g, " ");
  ok(text.includes("QA Owner") && text.includes("37 900") && text.includes("79 990") && text.includes("Roblox Room") && text.includes("10:00–14:00"), "dashboard shows the real catalog from the database");
  await shot(page, "390-dashboard-owner", { fullPage: true });
  ok(await noHScroll(page, 390), "no horizontal scroll on the dashboard");
  await page.goto(B + "/users", { waitUntil: "networkidle" });
  ok((await page.locator("h1").innerText()) === "Сотрудники", "owner opens the staff page");
  await shot(page, "390-users", { fullPage: true });
  ok(await noHScroll(page, 390), "no horizontal scroll on the staff page");
  await page.goto(B + "/audit", { waitUntil: "networkidle" });
  ok(/auth\.login/.test(await page.locator("main").innerText()), "owner sees the audit log with the login");
  await shot(page, "390-audit");
  ok(errs.length === 0, "no JavaScript errors " + errs.join("|"));
  await ctx.close();
}

console.log("## roles are enforced on the server");
for (const [email, role] of [["manager@qa.test", "manager"], ["editor@qa.test", "editor"]]) {
  const { ctx, page } = await open(1440, 900, false);
  await login(page, email, PW);
  ok(new URL(page.url()).pathname === "/", `${role} signs in`);
  const nav = (await page.locator("nav[aria-label=Разделы]").innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
  ok(JSON.stringify(nav) === JSON.stringify(["Обзор", "Мой пароль"]), `${role} sees only: ${nav.join(", ")}`);
  for (const path of ["/users", "/audit"]) {
    await page.goto(B + path, { waitUntil: "networkidle" });
    ok(new URL(page.url()).pathname === "/", `${role} typing ${path} is sent back to the dashboard`);
  }
  await shot(page, `1440-dashboard-${role}`);
  if (role === "manager") {
    // The Owner's Server Action id, replayed with the manager's session.
    const owner = await open(1440, 900, false);
    await login(owner.page, "owner@qa.test", PW);
    await owner.page.goto(B + "/users", { waitUntil: "networkidle" });
    const id = await owner.page.locator("form:has(input[name=email]) input[name^='$ACTION_ID_']").first().getAttribute("name");
    await owner.ctx.close();
    const before = await scalar("SELECT count(*) AS v FROM users");
    const res = await ctx.request.post(B + "/users", {
      multipart: { [id]: "", name: "Hacker", email: "hacker@qa.test", role: "owner", password: "hacker password 12345" },
      maxRedirects: 0,
      headers: { Origin: B },
    });
    ok((await scalar("SELECT count(*) AS v FROM users")) === before, `a forged createUser action sent as manager creates nothing (HTTP ${res.status()})`);
    ok((await scalar("SELECT count(*) AS v FROM users WHERE email = 'hacker@qa.test'")) === "0", "no hacker account exists");
  }
  await ctx.close();
}

console.log("## a state-changing request from another origin is refused (CSRF)");
{
  const { ctx, page } = await open(1440, 900, false);
  await login(page, "owner@qa.test", PW); // a valid Owner session is in the cookie jar
  await page.goto(B + "/users", { waitUntil: "networkidle" });
  const id = await page.locator("form:has(input[name=email]) input[name^='$ACTION_ID_']").first().getAttribute("name");
  const victim = `csrf-${Date.now()}@qa.test`;
  const post = (origin) =>
    ctx.request.post(B + "/users", {
      multipart: { [id]: "", name: "Csrf Test", email: victim, role: "manager", password: "csrf password 12345" },
      maxRedirects: 0,
      headers: { Origin: origin },
    });
  const evil = await post("https://evil.example");
  ok((await scalar(`SELECT count(*) AS v FROM users WHERE email = '${victim}'`)) === "0", `createUser posted with the Owner's cookie from https://evil.example is rejected (HTTP ${evil.status()})`);
  const same = await post(B);
  ok((await scalar(`SELECT count(*) AS v FROM users WHERE email = '${victim}'`)) === "1", `the same request from the real origin works (HTTP ${same.status()}), so the refusal above was the origin check`);
  await pool.query("UPDATE users SET is_active = false WHERE email = $1", [victim]);
  await ctx.close();
}

console.log("## logout revokes the session on the server");
{
  const { ctx, page } = await open(1440, 900, false);
  await login(page, "manager@qa.test", PW);
  const token = (await ctx.cookies()).find((c) => c.name === "bb_session").value;
  await page.getByRole("button", { name: "Выйти" }).click();
  await page.waitForTimeout(800);
  ok(new URL(page.url()).pathname === "/login", "logout lands on the login page");
  ok(!(await ctx.cookies()).some((c) => c.name === "bb_session"), "the cookie is removed");
  const ctx2 = await browser.newContext();
  await ctx2.addCookies([{ name: "bb_session", value: token, domain: new URL(B).hostname, path: "/" }]);
  const page2 = await ctx2.newPage();
  await page2.goto(B + "/", { waitUntil: "networkidle" });
  ok(new URL(page2.url()).pathname === "/login", "the old token no longer works");
  await ctx2.close();
  await ctx.close();
}

console.log("## lockout through the UI");
{
  const { ctx, page } = await open(1440, 900, false);
  for (let i = 0; i < 5; i++) await login(page, "editor@qa.test", "wrong password " + i);
  await login(page, "editor@qa.test", PW);
  const msg = await page.locator("form [role=alert]").innerText();
  ok(/Слишком много/.test(msg), "the 6th attempt with the RIGHT password is locked: " + msg);
  await ctx.close();
  await pool.query("DELETE FROM login_attempts");
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
process.exit(fails ? 1 : 0);
