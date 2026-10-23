// Cross-app check of attendance in real browsers: QR form with the children counter (site) -> confirmation of the entry (admin).
//   SITE_URL=http://localhost:3000 PLATFORM_URL=http://localhost:3100 DATABASE_URL=... E2E_PASSWORD=... npm run e2e:attendance
// Needs: the platform (PII_INTAKE_ENABLED=1), the site with CONSENT_FORM_ENABLED=1 PLATFORM_URL PLATFORM_INTAKE_TOKEN,
// published visit_rules and personal_data_consent documents, QA users (owner@/manager@/editor@qa.test), a migrated database.
// All data is synthetic ("ТЕСТ Посещаемость ..."). Figures are compared with the database, as differences (the day may hold other test data).
import pg from "pg";
import { chromium } from "playwright-core";

const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const ADMIN = process.env.PLATFORM_URL ?? "http://localhost:3100";
const PW = process.env.E2E_PASSWORD;
const DB = process.env.DATABASE_URL;
if (!PW || !DB) throw new Error("E2E_PASSWORD and DATABASE_URL are required");
for (const u of [SITE, ADMIN]) if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) throw new Error("refusing to run against a non-local server: " + u);
// The scenario writes synthetic registrations and entries (append-only tables): it runs against a LOCAL database only.
// Only the host name is ever printed, never the connection string or a password.
let dbHost = "";
try {
  dbHost = new URL(DB).hostname;
} catch {
  throw new Error("DATABASE_URL is not a valid URL");
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost)) throw new Error(`refusing to run against a non-local database (host: ${dbHost})`);
const pool = new pg.Pool({ connectionString: DB, max: 2 });
const scalar = async (q, p = []) => String((await pool.query(q, p)).rows[0].v);
const chrome =
  process.env.E2E_CHROME ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);
const run = Date.now().toString(36);
const MARK = `ТЕСТ Посещаемость`;
// Everything this run creates is TRACKED by the keys it generated or sent (registration idempotency keys, manual-entry keys); the cleanup at
// the end removes exactly these rows and nothing else: no matching by time, by person or by a name pattern.
const created = { regKeys: new Set(), manualKeys: new Set() };
const VERS = Object.fromEntries(
  (await pool.query("SELECT kind::text k, version v FROM bb.legal_documents WHERE status = 'published' AND kind IN ('visit_rules', 'companion_duties', 'personal_data_consent')")).rows.map((d) => [d.k, d.v]),
);
const TODAY_SQL = "(now() AT TIME ZONE 'Asia/Almaty')::date";
const enteredToday = async () => Number(await scalar(`SELECT COALESCE(sum(children_count), 0) v FROM bb.attendance_entries WHERE entry_date = ${TODAY_SQL}`));
const adultsToday = async () => Number(await scalar(`SELECT count(*) v FROM bb.consent_registrations WHERE (created_at AT TIME ZONE 'Asia/Almaty')::date = ${TODAY_SQL}`));
const expectedToday = async () =>
  Number(await scalar(`SELECT COALESCE(sum(r.children_count), 0) v FROM bb.consent_registrations r WHERE (r.created_at AT TIME ZONE 'Asia/Almaty')::date = ${TODAY_SQL}
     AND NOT EXISTS (SELECT 1 FROM bb.attendance_entries e WHERE e.registration_id = r.id)`));

const login = async (page, email) => {
  await page.goto(ADMIN + "/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Пароль").fill(PW);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 });
};
const card = async (page, id) => Number((await page.locator(`[data-testid=${id}] p`).nth(1).innerText()).trim());

console.log("## QR form: the children counter (390x844)");
const NAME = `ТЕСТ Посещаемость ${run}`;
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const posts = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/consent") && posts.push(JSON.parse(r.postData() || "{}")));
  await page.goto(SITE + "/consent", { waitUntil: "networkidle" });
  const kids = page.locator('input[name="childrenCount"]');
  const plus = page.getByRole("button", { name: "Увеличить количество детей" });
  const minus = page.getByRole("button", { name: "Уменьшить количество детей" });
  ok((await kids.inputValue()) === "1", "the counter starts at 1");
  ok(await minus.isDisabled(), "− is disabled at 1");
  const box = async (l) => (await l.boundingBox());
  const [bm, bp] = [await box(minus), await box(plus)];
  ok(bm.width >= 44 && bm.height >= 44 && bp.width >= 44 && bp.height >= 44, `− and + are at least 44px (${Math.round(bm.width)}x${Math.round(bm.height)})`);
  await plus.click();
  await plus.click();
  ok((await kids.inputValue()) === "3", "+ twice gives 3");
  await minus.click();
  ok((await kids.inputValue()) === "2", "− gives 2");
  await kids.fill("99");
  await kids.blur();
  ok((await kids.inputValue()) === "50" && (await plus.isDisabled()), "a typed 99 is held at 50 and + is disabled");
  await kids.fill("abc");
  ok((await kids.inputValue()) === "", "letters cannot be typed");
  await kids.blur();
  ok((await kids.inputValue()) === "1", "an empty field returns to 1");
  await plus.click();
  await plus.click();
  ok((await kids.inputValue()) === "3", "3 children");
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "no sideways scroll");
  ok(!/имен[аи] детей|даты рождения детей/i.test(await page.locator("form label").allInnerTexts().then((t) => t.join(" "))) && (await page.locator('form input[name*="child" i]').count()) === 1, "the form asks for a number only: no names, no birth dates of children");
  await page.locator('input[name="name"]').fill(NAME);
  await page.locator('input[name="acceptRules"]').check();
  await page.locator('input[name="acceptPersonalData"]').check();
  const before = { adults: await adultsToday(), entered: await enteredToday() };
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  created.regKeys.add(posts[0].idempotencyKey);
  ok(posts.length === 1 && posts[0].childrenCount === 3, "the request carries childrenCount = 3 (a number)");
  ok((await page.locator("main").innerText()).includes("Детей с вами: 3"), "the confirmation names the number");
  ok(Number(await scalar("SELECT r.children_count v FROM bb.consent_registrations r JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1", [NAME])) === 3, "PostgreSQL stored 3");
  ok((await adultsToday()) === before.adults + 1 && (await enteredToday()) === before.entered, "the registration is not a visit: no children entered");
  // the API cannot be talked into a bad number
  const send = (childrenCount) => fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `ТЕСТ Посещаемость API ${run}`, childrenCount, documentVersions: VERS, acceptRules: true, acceptPersonalData: true, idempotencyKey: crypto.randomUUID() }) });
  for (const bad of [0, 51, -2, 2.5, "x", null]) ok((await send(bad)).status === 400, `API refuses childrenCount ${JSON.stringify(bad)} (400)`);
  ok((await fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `ТЕСТ Посещаемость API ${run}`, documentVersions: VERS, acceptRules: true, acceptPersonalData: true }) })).status === 400, "API refuses a request without the number (400)");
  ok(Number(await scalar("SELECT count(*) v FROM bb.contacts WHERE name = $1", [`ТЕСТ Посещаемость API ${run}`])) === 0, "refused requests left no contact");
  ok(errs.length === 0, "no JavaScript errors");
  await ctx.close();
}

console.log("## QR registrations with 1, 3, 10 and 50 children (390x844)");
for (const n of [1, 3, 10, 50]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const posts = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/consent") && posts.push(JSON.parse(r.postData() || "{}")));
  await page.goto(SITE + "/consent", { waitUntil: "networkidle" });
  const kids = page.locator('input[name="childrenCount"]');
  if (n === 3) {
    await page.getByRole("button", { name: "Увеличить количество детей" }).click();
    await page.getByRole("button", { name: "Увеличить количество детей" }).click();
  } else if (n !== 1) {
    await kids.fill(String(n));
    await kids.blur();
  }
  ok((await kids.inputValue()) === String(n), `${n}: the field shows ${n}`);
  const who = `${MARK} n${n} ${run}`;
  await page.locator('input[name="name"]').fill(who);
  await page.locator('input[name="acceptRules"]').check();
  await page.locator('input[name="acceptPersonalData"]').check();
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.getByText("Регистрация сохранена").waitFor({ timeout: 10000 });
  created.regKeys.add(posts[0].idempotencyKey);
  ok(posts.length === 1 && posts[0].childrenCount === n && typeof posts[0].childrenCount === "number", `${n}: the payload carries childrenCount = ${n} (a number)`);
  ok(Number(await scalar("SELECT r.children_count v FROM bb.consent_registrations r JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1", [who])) === n, `${n}: PostgreSQL stored ${n}`);
  ok((await page.locator("main").innerText()).includes(`Детей с вами: ${n}`), `${n}: the confirmation names the number`);
  await ctx.close();
}

console.log("## admin (manager): confirm an entry, repeat, manual entry, correction");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, "manager@qa.test");
  ok((await page.getByRole("link", { name: "Посещаемость" }).count()) >= 1, "the Manager sees «Посещаемость» in the menu");
  const dashEntered = await page.locator("[data-testid=dash-attendance] dd").nth(0).innerText();
  ok(Number(dashEntered) === (await enteredToday()), "the dashboard shows the true figure of today (from the database)");
  await page.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
  const e0 = await card(page, "card-entered");
  const adults0 = await card(page, "card-adults");
  const exp0 = await card(page, "card-expected");
  ok(e0 === (await enteredToday()) && adults0 === (await adultsToday()) && exp0 === (await expectedToday()), "the cards match the database");
  const li = page.locator("li[data-registration]", { hasText: NAME });
  ok((await li.locator("[data-status]").innerText()) === "Ожидает входа" && (await li.innerText()).includes("Заявлено детей: 3"), "the registration is «Ожидает входа» with 3 declared children");
  ok((await li.getByRole("button", { name: "Подтвердить вход" }).count()) === 1, "the action «Подтвердить вход» is offered");
  // the actual number differs from the declared one
  await li.locator('input[name="childrenCount"]').fill("2");
  await li.getByRole("button", { name: "Подтвердить вход" }).dblclick();
  await page.waitForURL(/notice=/);
  const li2 = page.locator("li[data-registration]", { hasText: NAME });
  ok((await li2.locator("[data-status]").innerText()) === "Вход подтверждён", "the status is «Вход подтверждён»");
  ok((await card(page, "card-entered")) === e0 + 2 && (await enteredToday()) === e0 + 2, "entered children grew by exactly the confirmed 2 (a double tap counted once)");
  ok((await card(page, "card-expected")) === exp0 - 3 && (await card(page, "card-adults")) === adults0, "expected fell by the declared 3, registered adults unchanged");
  ok((await li2.getByRole("button", { name: "Подтвердить вход" }).count()) === 0, "the confirmation button is gone");

  // manual entry (without QR); double click = one entry
  const manual = page.locator("[data-testid=manual-form]");
  await manual.locator('input[name="childrenCount"]').fill("4");
  const manualKey = await manual.locator('input[name="idempotencyKey"]').inputValue();
  created.manualKeys.add(manualKey);
  const listed = await page.locator("[data-testid=entries] li[data-entry]").count();
  await manual.getByRole("button", { name: "Записать вход" }).dblclick();
  // the previous action may have ended in a "duplicate" notice too, so wait for the NEW row, not for the URL
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=entries] li[data-entry]").length === n + 1, listed, { timeout: 10000 });
  await page.waitForLoadState("networkidle");
  const dbNow = await enteredToday();
  const shown = await card(page, "card-entered");
  ok(dbNow === e0 + 6 && shown === e0 + 6, `a manual entry of 4 added 4 once (before ${e0}, database ${dbNow}, screen ${shown})`);
  ok(Number(await scalar("SELECT count(*) v FROM bb.attendance_entries WHERE method = 'manual' AND idempotency_key = $1 AND children_count = 4", [manualKey])) === 1, "exactly one manual row was written (by the form's own key)");

  // correction with a reason, kept in the log
  const entry = page.locator("[data-testid=entries] li[data-entry]", { hasText: `QR (${NAME})` });
  await entry.getByText("Исправить количество").click();
  await entry.locator('input[name="newCount"]').fill("3");
  await entry.locator('select[name="reason"]').selectOption("late_arrivals");
  await entry.getByRole("button", { name: "Сохранить исправление" }).click();
  await page.waitForURL(/notice=corrected/);
  ok((await enteredToday()) === e0 + 7 && (await card(page, "card-entered")) === e0 + 7, "the correction 2 → 3 moved the day by +1");
  const logged = await page.locator("[data-testid=entries] li[data-entry]", { hasText: `QR (${NAME})` }).innerText();
  ok(/2 → 3/.test(logged) && /Дети пришли позже/.test(logged), "the correction history is shown (2 → 3, reason)");
  ok(Number(await scalar("SELECT count(*) v FROM bb.attendance_corrections k JOIN bb.attendance_entries e ON e.id = k.entry_id JOIN bb.consent_registrations r ON r.id = e.registration_id JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1 AND k.old_count = 2 AND k.new_count = 3", [NAME])) === 1, "the database holds the correction row");
  ok(Number(await scalar("SELECT count(*) v FROM bb.audit_log WHERE action = 'attendance.corrected' AND at > now() - interval '5 minutes'")) >= 1, "the audit log has the correction");

  // a cancelled entry is a decision: it is not "expected" again
  const regC = `${MARK} cancel ${run}`;
  const keyC = crypto.randomUUID();
  created.regKeys.add(keyC);
  {
    const r = await fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: regC, childrenCount: 3, documentVersions: VERS, acceptRules: true, acceptPersonalData: true, idempotencyKey: keyC }) });
    ok(r.status === 200, "a second synthetic registration (3 children) was made through the real site API");
    await page.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
    const expBefore = await card(page, "card-expected");
    const li3 = page.locator("li[data-registration]", { hasText: regC });
    await li3.locator('input[name="childrenCount"]').fill("3");
    await li3.getByRole("button", { name: "Подтвердить вход" }).click();
    await page.waitForURL(/notice=confirmed/);
    ok((await card(page, "card-expected")) === expBefore - 3, "confirmed 3: expected fell by 3");
    const en3 = page.locator("[data-testid=entries] li[data-entry]", { hasText: `QR (${regC})` });
    await en3.getByText("Исправить количество").click();
    await en3.locator('input[name="newCount"]').fill("0");
    await en3.locator('select[name="reason"]').selectOption("wrong_registration");
    await en3.getByRole("button", { name: "Сохранить исправление" }).click();
    await page.waitForURL(/notice=corrected/);
    ok((await card(page, "card-expected")) === expBefore - 3 && (await card(page, "card-expected")) === (await expectedToday()), "corrected to 0: the 3 children are NOT expected again");
    ok((await page.locator("li[data-registration]", { hasText: regC }).locator("[data-status]").innerText()) === "Вход отменён", "the registration reads «Вход отменён», not «Ожидает входа»");
  }

  // a forged date in the form: the server refuses (the hidden field of the form is changed before sending)
  {
    const regT = `${MARK} tamper ${run}`;
    const keyT = crypto.randomUUID();
    created.regKeys.add(keyT);
    await fetch(SITE + "/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: regT, childrenCount: 2, documentVersions: VERS, acceptRules: true, acceptPersonalData: true, idempotencyKey: keyT }) });
    await page.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
    const yesterdayStr = await scalar(`SELECT to_char(${TODAY_SQL} - 1, 'YYYY-MM-DD') v`);
    const liT = page.locator("li[data-registration]", { hasText: regT });
    await liT.locator('input[name="date"]').evaluate((el, v) => (el.value = v), yesterdayStr);
    const before = await enteredToday();
    await liT.getByRole("button", { name: "Подтвердить вход" }).click();
    await page.waitForURL(/error=past/);
    ok((await enteredToday()) === before && Number(await scalar("SELECT count(*) v FROM bb.attendance_entries e JOIN bb.consent_registrations r ON r.id = e.registration_id JOIN bb.contacts c ON c.id = r.contact_id WHERE c.name = $1", [regT])) === 0, "a forged past date in a confirmation is refused on the server: nothing was written");
    await page.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
    const man = page.locator("[data-testid=manual-form]");
    created.manualKeys.add(await man.locator('input[name="idempotencyKey"]').inputValue());
    await man.locator('input[name="date"]').evaluate((el, v) => (el.value = v), yesterdayStr);
    await man.locator('input[name="childrenCount"]').fill("5");
    await man.getByRole("button", { name: "Записать вход" }).click();
    await page.waitForURL(/error=past/);
    ok((await enteredToday()) === before, "a forged past date in a manual entry is refused too");
  }

  // a past day is read-only for new entries, readable, and its existing entries stay correctable
  {
    const dayBefore = await scalar(`SELECT to_char(${TODAY_SQL} - 1, 'YYYY-MM-DD') v`);
    await page.goto(`${ADMIN}/attendance?date=${dayBefore}`, { waitUntil: "networkidle" });
    ok((await page.locator("[data-testid=manual-form]").count()) === 0 && (await page.locator("[data-testid=manual-closed]").count()) === 1, "on a past day the manual form is not offered");
    ok((await page.getByRole("button", { name: "Подтвердить вход" }).count()) === 0, "on a past day there is no «Подтвердить вход»");
  }

  // chart, table and date change
  ok((await page.locator('svg[role="img"]').count()) === 1 && (await page.locator("[data-testid=series] tbody tr").count()) === 14, "a chart and a 14-day table are shown");
  const yesterday = await scalar(`SELECT to_char(${TODAY_SQL} - 1, 'YYYY-MM-DD') v`);
  await page.goto(`${ADMIN}/attendance?date=${yesterday}`, { waitUntil: "networkidle" });
  const yEntered = Number(await scalar("SELECT COALESCE(sum(children_count), 0) v FROM bb.attendance_entries WHERE entry_date = $1::date", [yesterday]));
  ok((await card(page, "card-entered")) === yEntered, `another day shows its own figure (${yEntered}), not today's`);
  ok(!(await page.locator("li[data-registration]", { hasText: NAME }).count()), "today's registration is not listed under another date");
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "the page fits a phone");
  await ctx.close();
}

console.log("## the Editor has no access; the Owner has");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, "editor@qa.test");
  ok((await page.getByRole("link", { name: "Посещаемость" }).count()) === 0, "the Editor's menu has no «Посещаемость»");
  ok((await page.locator("[data-testid=dash-attendance]").count()) === 0, "the Editor's dashboard has no attendance figures");
  await page.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
  ok(new URL(page.url()).pathname === "/", "the Editor is sent away from /attendance");
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await ctx2.newPage();
  await login(p2, "owner@qa.test");
  await p2.goto(ADMIN + "/attendance", { waitUntil: "networkidle" });
  ok((await card(p2, "card-entered")) === (await enteredToday()), "the Owner sees the same true figure");
  await ctx2.close();
}

// ── cleanup: no synthetic record stays in the database ─────────────────────────────────────────────────────────
// Entries, corrections, consent history and the audit log are append-only by design; the database owner removes THIS run's rows with
// triggers bypassed inside one transaction. If the role is not allowed to, the rows are reported (names only) and nothing else is touched.
try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    // exactly the rows whose keys this run generated or sent
    const regs = (await c.query("SELECT id, contact_id FROM bb.consent_registrations WHERE idempotency_key = ANY($1::uuid[])", [[...created.regKeys]])).rows;
    const regIds = regs.map((r) => r.id);
    const contactIds = [...new Set(regs.map((r) => r.contact_id))];
    const entries = (await c.query("SELECT id FROM bb.attendance_entries WHERE registration_id = ANY($1::uuid[]) OR idempotency_key = ANY($2::uuid[])", [regIds, [...created.manualKeys]])).rows.map((r) => r.id);
    await c.query("DELETE FROM bb.attendance_corrections WHERE entry_id = ANY($1::uuid[])", [entries]);
    await c.query("DELETE FROM bb.attendance_entries WHERE id = ANY($1::uuid[])", [entries]);
    await c.query("DELETE FROM bb.consent_events WHERE registration_id = ANY($1::uuid[])", [regIds]);
    await c.query("DELETE FROM bb.audit_log WHERE entity_id = ANY($1::text[])", [[...entries, ...regIds]]);
    await c.query("DELETE FROM bb.consent_registrations WHERE id = ANY($1::uuid[])", [regIds]);
    await c.query("DELETE FROM bb.contacts WHERE id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM bb.consent_events e WHERE e.contact_id = contacts.id)", [contactIds]);
    await c.query("COMMIT");
    console.log(`  cleanup: removed ${regIds.length} synthetic registrations and ${entries.length} entries of this run`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.log(`  cleanup skipped (${e.code ?? "error"}): this run's synthetic rows (tracked by key) remain in the local database`);
  } finally {
    c.release();
  }
} catch {
  console.log("  cleanup skipped: no database connection");
}

console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
await browser.close();
await pool.end();
process.exit(fails ? 1 : 0);
