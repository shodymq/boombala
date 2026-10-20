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
  ok((await scalar(`SELECT count(*) AS v FROM bb.sessions WHERE encode(token_hash,'hex') = '${cookie.value}'`)) === "0", "the raw token is not stored in the database");
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
  const expectedNav = role === "manager" ? ["Обзор", "Клиенты", "Мой пароль"] : ["Обзор", "Мой пароль"];
  ok(JSON.stringify(nav) === JSON.stringify(expectedNav), `${role} sees only: ${nav.join(", ")}`);
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
    const before = await scalar("SELECT count(*) AS v FROM bb.users");
    const res = await ctx.request.post(B + "/users", {
      multipart: { [id]: "", name: "Hacker", email: "hacker@qa.test", role: "owner", password: "hacker password 12345" },
      maxRedirects: 0,
      headers: { Origin: B },
    });
    ok((await scalar("SELECT count(*) AS v FROM bb.users")) === before, `a forged createUser action sent as manager creates nothing (HTTP ${res.status()})`);
    ok((await scalar("SELECT count(*) AS v FROM bb.users WHERE email = 'hacker@qa.test'")) === "0", "no hacker account exists");
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
  ok((await scalar(`SELECT count(*) AS v FROM bb.users WHERE email = '${victim}'`)) === "0", `createUser posted with the Owner's cookie from https://evil.example is rejected (HTTP ${evil.status()})`);
  const same = await post(B);
  ok((await scalar(`SELECT count(*) AS v FROM bb.users WHERE email = '${victim}'`)) === "1", `the same request from the real origin works (HTTP ${same.status()}), so the refusal above was the origin check`);
  await pool.query("UPDATE bb.users SET is_active = false WHERE email = $1", [victim]);
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
  await pool.query("DELETE FROM bb.login_attempts");
}

console.log("## CRM: machine endpoints, pages, export (needs PLATFORM_INTAKE_TOKEN, CRON_SECRET and a mock Telegram, see README)");
{
  const TOKEN = process.env.PLATFORM_INTAKE_TOKEN;
  const CRON = process.env.CRON_SECRET;
  if (!TOKEN || !CRON) throw new Error("PLATFORM_INTAKE_TOKEN and CRON_SECRET are required for the CRM section");
  const call = (path, init = {}) => fetch(B + path, { redirect: "manual", ...init });
  const post = (path, body, token = TOKEN) =>
    call(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const key = crypto.randomUUID();
  const date = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  const lead = { idempotencyKey: key, name: "E2E Гость", phone: "+77470000001", date, children: 5, consent: true };

  ok((await post("/api/intake/lead", lead, null)).status === 401, "intake without a token is refused");
  ok((await post("/api/intake/lead", lead, "x".repeat(40))).status === 401, "intake with a wrong token is refused");
  ok((await call("/api/cron/outbox")).status === 401, "cron without a secret is refused");
  ok((await call("/api/public/legal")).status === 401, "public legal endpoint needs the server token too");
  ok((await call("/api/export", { method: "POST", headers: { origin: B } })).status !== 200, "export without a session is not served");

  // Local dev DB only: retire what earlier runs published, so "nothing published" is the starting point of this run.
  await pool.query("UPDATE bb.legal_documents SET status = 'retired' WHERE status = 'published'");
  await pool.query("DELETE FROM bb.legal_documents WHERE status = 'draft' AND kind = 'privacy_policy'");
  const noDoc = await post("/api/intake/lead", lead);
  ok(noDoc.status === 503 && (await noDoc.json()).error === "consent_unavailable", "no published consent document: enquiry is refused (503)");

  const { ctx, page } = await open(1280, 800, false);
  await login(page, "owner@qa.test", PW);
  await page.goto(B + "/legal", { waitUntil: "networkidle" });
  const KIND_LABEL = { personal_data_consent: "Согласие на обработку данных", visit_rules: "Правила посещения", privacy_policy: "Политика обработки данных" };
  const draftVia = async (kind, title, body) => {
    await page.goto(B + "/legal", { waitUntil: "networkidle" });
    await page.locator("form:has(textarea[name=body]) select[name=kind]").first().selectOption(kind);
    await page.locator("form:has(textarea[name=body]) input[name=title]").first().fill(title);
    await page.locator("form:has(textarea[name=body]) textarea[name=body]").first().fill(body);
    await page.getByRole("button", { name: "Создать черновик" }).click();
    await page.waitForTimeout(800);
    const version = await scalar(`SELECT max(version) AS v FROM bb.legal_documents WHERE kind = '${kind}'`);
    return page.locator("article", { hasText: `${KIND_LABEL[kind]} · редакция ${version}` });
  };
  for (const [kind, title] of [["personal_data_consent", "Согласие E2E"], ["visit_rules", "Правила E2E"]]) {
    const card = await draftVia(kind, title, "Тестовый текст документа");
    await card.getByRole("button", { name: "Утвердить" }).click();
    await page.waitForTimeout(800);
    await card.getByRole("button", { name: "Опубликовать" }).click();
    await page.waitForTimeout(800);
  }
  ok((await scalar("SELECT count(*) AS v FROM bb.legal_documents WHERE status = 'published'")) === "2", "owner drafted, approved and published two documents through the UI");
  // placeholder text cannot be approved
  const ph = await draftVia("privacy_policy", "Политика E2E", "ТОО [ТРЕБУЕТСЯ: название]");
  await ph.getByRole("button", { name: "Утвердить" }).click();
  await page.waitForTimeout(800);
  ok((await page.locator("[role=alert]").first().innerText()).includes("ТРЕБУЕТСЯ"), "a draft with placeholders cannot be approved");
  ok((await scalar("SELECT count(*) AS v FROM bb.legal_documents WHERE kind = 'privacy_policy' AND status <> 'draft'")) === "0", "and it stays a draft");

  const docs = await (await call("/api/public/legal", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(docs.ok && docs.documents.length === 2 && !JSON.stringify(docs).includes("@"), "published documents are served to the site without personal data");

  const first = await post("/api/intake/lead", lead);
  const firstBody = await first.json();
  ok(first.status === 201 && firstBody.ok && !firstBody.duplicate, "enquiry is saved (201) after the database commit");
  const again = await post("/api/intake/lead", lead);
  ok(again.status === 200 && (await again.json()).duplicate === true, "the same idempotency key returns the first result");
  ok((await scalar(`SELECT count(*) AS v FROM bb.lead_requests WHERE idempotency_key = '${key}'`)) === "1", "one enquiry in the database");
  await new Promise((r) => setTimeout(r, 1500));
  ok((await scalar(`SELECT o.status AS v FROM bb.outbox o JOIN bb.lead_requests l ON l.id = o.ref_id WHERE l.idempotency_key = '${key}'`)) === "sent", "Telegram message was sent (mock)");
  const bad = await post("/api/intake/lead", { ...lead, idempotencyKey: crypto.randomUUID(), phone: "12" });
  ok(bad.status === 422, "invalid enquiry is refused (422)");

  const reg = { idempotencyKey: crypto.randomUUID(), name: "E2E QR", phone: "+77470000002", acceptRules: true, acceptPersonalData: true };
  const r1 = await post("/api/intake/consent", reg);
  ok(r1.status === 201, "QR registration saved");
  ok((await post("/api/intake/consent", reg)).status === 200, "QR registration is idempotent");
  ok((await post("/api/intake/consent", { ...reg, idempotencyKey: crypto.randomUUID(), acceptPersonalData: false })).status === 422, "QR without the data consent is refused");

  const cron = await call("/api/cron/outbox", { headers: { authorization: `Bearer ${CRON}` } });
  ok(cron.status === 200 && (await cron.json()).ok, "cron endpoint works with the secret");

  await page.goto(B + "/contacts?q=E2E", { waitUntil: "networkidle" });
  const list = await page.locator("main").innerText();
  ok(list.includes("E2E Гость") && list.includes("E2E QR"), "contacts list finds both people");
  await page.getByRole("link", { name: /E2E Гость/ }).click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const card = await page.locator("main").innerText();
  ok(/Заявки \(\d+\)/.test(card) && card.includes("Согласие на обработку данных") && card.includes("не является электронной цифровой подписью"), "contact card shows the enquiry and the consent history");
  await page.goto(B + "/export", { waitUntil: "networkidle" });
  ok((await page.locator("h1").innerText()).includes("Выгрузка"), "owner sees the export page");
  const dl = await ctx.request.post(B + "/api/export", { headers: { origin: B }, multipart: (() => { const f = new FormData(); f.append("format", "csv"); f.append("columns", "name"); f.append("columns", "phone"); return f; })() });
  ok(dl.status() === 200 && (await dl.text()).includes("E2E Гость") && dl.headers()["content-disposition"].includes("attachment"), "owner downloads a CSV");
  ok((await ctx.request.post(B + "/api/export", { headers: { origin: "https://evil.example" }, form: { format: "csv" } })).status() === 403, "export from a foreign origin is refused");
  ok(Number(await scalar("SELECT count(*) AS v FROM bb.export_log")) >= 1, "the export is written to the log");
  await ctx.close();

  for (const [email, expectExport] of [["manager@qa.test", false], ["editor@qa.test", false]]) {
    const o = await open(1280, 800, false);
    await login(o.page, email, PW);
    const r = await o.ctx.request.post(B + "/api/export", { headers: { origin: B }, form: { format: "csv" } });
    ok(r.status() === 403, `${email} cannot export (403)`);
    await o.page.goto(B + "/export", { waitUntil: "networkidle" });
    ok(new URL(o.page.url()).pathname === "/", `${email} is sent away from the export page`);
    if (email.startsWith("editor")) {
      await o.page.goto(B + "/contacts", { waitUntil: "networkidle" });
      ok(new URL(o.page.url()).pathname === "/", "editor cannot open clients");
    } else {
      await o.page.goto(B + "/legal", { waitUntil: "networkidle" });
      ok(new URL(o.page.url()).pathname === "/", "manager cannot manage legal documents");
    }
    await o.ctx.close();
  }
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
process.exit(fails ? 1 : 0);
