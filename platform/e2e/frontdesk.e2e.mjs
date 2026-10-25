// The cashier's front desk (/attendance) with 100+ synthetic families, in real browsers at 768 px (tablet) and 390 px (phone).
//   DATABASE_URL=postgres://postgres@127.0.0.1:54331/bb_fd npm run e2e:frontdesk
// Needs: the platform built (`npm run build`) and a LOCAL, migrated database. It starts its own staff process (no second factor profile:
// this checks the screen, the isolation profile is covered by e2e:isolation and e2e:kz-flow). Everything is synthetic; the names are fake.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { chromium } from "playwright-core";
import { createPool } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";

const DB = process.env.DATABASE_URL;
if (!DB || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error("DATABASE_URL must point to a LOCAL database");
const OUT = process.env.E2E_SCREENSHOTS ?? "";
if (OUT) mkdirSync(OUT, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.FRONTDESK_PORT ?? 3701);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "correct horse battery staple " + Date.now().toString(36);
let fails = 0;
const ok = (c, m) => (console.log(c ? "  ok  " : "  FAIL", m), c || fails++);

const pool = createPool(DB, { max: 4 });
const cashier = await createUser(pool, null, { email: `fd.cashier.${Date.now()}@example.test`, name: "FD cashier", role: "manager", password: PW });
const cashier2 = await createUser(pool, null, { email: `fd.cashier2.${Date.now()}@example.test`, name: "FD cashier 2", role: "manager", password: PW });
const editor = await createUser(pool, null, { email: `fd.editor.${Date.now()}@example.test`, name: "FD editor", role: "editor", password: PW });

// 100 synthetic registrations of today: the same names, parents without a phone, one very long name
const LONG = "Айгерим Сериккызы-Нурпеисова Жанеке-Алибекова";
const people = [];
for (let i = 0; i < 40; i++) people.push({ name: "Айгерим Сериккызы", kids: 1 + (i % 4), phone: null });
people.push({ name: LONG, kids: 3, phone: null });
for (let i = 0; i < 20; i++) people.push({ name: "Нурлан Ахметов", kids: 2, phone: `+7701555${1000 + i}` });
for (let i = 0; i < 39; i++) people.push({ name: `Семья ФД${i}`, kids: 1 + (i % 3), phone: i % 2 ? null : `+7702555${2000 + i}` });
const seqs = [];
for (const p of people) {
  const c = await pool.query("INSERT INTO bb.contacts (name, name_key, phone_e164, source) VALUES ($1, $2, $3, 'qr') RETURNING id", [p.name, p.name.toLocaleLowerCase("ru-RU"), p.phone]);
  const r = await pool.query("INSERT INTO bb.consent_registrations (idempotency_key, contact_id, children_count) VALUES ($1, $2, $3) RETURNING seq", [randomUUID(), c.rows[0].id, p.kids]);
  seqs.push(Number(r.rows[0].seq));
}
ok(people.length === 100, "100 synthetic registrations created");

const logs = [];
const child = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: root, env: { ...process.env, NODE_ENV: "production", DATABASE_URL: DB, MFA_MODE: "", PLATFORM_PROFILE: "", PLATFORM_ROLE: "", ALLOWED_HOSTS: "", ADMIN_ALLOWED_CIDRS: "" }, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));
const stop = () => child.kill("SIGTERM");
process.on("exit", stop);
for (let i = 0; i < 120; i++) {
  const up = await new Promise((r) => { const s = net.connect(PORT, "127.0.0.1", () => (s.destroy(), r(true))); s.on("error", () => r(false)); });
  if (up) break;
  await new Promise((r) => setTimeout(r, 500));
}

const chrome = process.env.E2E_CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const login = async (ctx, email) => {
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.locator("input[name=email]").fill(email);
  await page.locator("input[name=password]").fill(PW);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  return page;
};
const rows = (page) => page.locator("li[data-registration]");
const noteOf = (page) => page.locator('[data-testid="notice"]').innerText().catch(() => "");
/** Runs a click that submits a server action and waits until the page shows the result (the address may not change). */
const act = async (page, click) => {
  const done = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/attendance"));
  await click();
  await done;
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
};
const searchFor = async (page, text, filter) => {
  await page.locator('input[type="search"][name="q"]').fill(text);
  await act(page, () => (filter ? page.locator(`[data-testid="reg-filters"] button[value="${filter}"]`).click() : page.getByRole("button", { name: "Найти", exact: true }).click()));
};
const horizontal = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

try {
  for (const dev of [
    { label: "tablet 768", viewport: { width: 768, height: 1024 }, shot: "tablet" },
    { label: "phone 390", viewport: { width: 390, height: 844 }, shot: "phone" },
  ]) {
    console.log(`## ${dev.label}`);
    const ctx = await browser.newContext({ viewport: dev.viewport, hasTouch: true, isMobile: true });
    const page = await login(ctx, cashier.email);
    await page.goto(BASE + "/attendance", { waitUntil: "networkidle" });
    if (OUT) await page.screenshot({ path: `${OUT}/after-${dev.shot}-all.png`, fullPage: true });
    ok(!(await horizontal(page)), "no horizontal scroll");
    const searchTop = await page.locator('input[type="search"][name="q"]').evaluate((e) => Math.round(e.getBoundingClientRect().top + scrollY));
    ok(searchTop < dev.viewport.height, `the search is on the first screen (y = ${searchTop}px of ${dev.viewport.height}px)`);
    const first = rows(page).first();
    const btnY = await first.getByRole("button", { name: "Подтвердить вход" }).evaluate((e) => Math.round(e.getBoundingClientRect().top + scrollY));
    ok(btnY < (dev.viewport.height * 1.6), `the first «Подтвердить вход» is reachable without long scrolling (y = ${btnY}px, screen ${dev.viewport.height}px)`);
    ok((await rows(page).count()) <= 50, `at most 50 rows are sent to the browser (${await rows(page).count()})`);
    ok(/Показано 50 из \d+/.test(await page.locator("main").innerText()), "«Показано 50 из N» and «Показать ещё» for the rest");

    // search by name, any case, a part of the name
    await searchFor(page, "АЙГЕРИМ");
    const n = await rows(page).count();
    ok(n === 41, `search «АЙГЕРИМ» (any letter case): 41 families (${n})`);
    ok(!/q=|%D0/.test(page.url()), "the search text is not in the address (it would reach the access logs)");
    const cookie = (await ctx.cookies()).find((c) => c.name === "bb_att");
    ok(!!cookie && cookie.httpOnly && cookie.path === "/attendance", "the search is kept in an HttpOnly cookie of this section");
    // the long name is whole, not cut
    await searchFor(page, "нурпеисова");
    const longRow = rows(page).first().locator("p").first();
    const cut = await longRow.evaluate((e) => ({ over: e.scrollWidth > e.clientWidth + 1, ell: getComputedStyle(e).textOverflow, text: e.textContent }));
    ok(cut.text === LONG && !cut.over && cut.ell !== "ellipsis", "a long name is shown whole (it wraps, it is not cut)");
    // the card: name, number, time, declared, status
    const card = (await rows(page).first().innerText()).replace(/\s+/g, " ");
    ok(/№ \d+/.test(card) && /зарегистрирован в \d\d:\d\d/.test(card) && /Заявлено детей: 3/.test(card) && /Ожидает входа/.test(card), `card: ${card.slice(0, 120)}`);
    // tap targets
    const small = await page.evaluate(() => [...document.querySelectorAll("main form button, main form input:not([type=hidden])")].filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.height < 44; }).map((e) => `${e.tagName}:${(e.textContent || e.getAttribute("name") || "").trim().slice(0, 14)}=${Math.round(e.getBoundingClientRect().height)}`));
    ok(small.length === 0, `search, filters and confirm controls are at least 44px tall (${small.join("; ") || "ok"})`);
    // number search
    await searchFor(page, `№ ${seqs[70]}`);
    ok((await rows(page).count()) === 1 && (await rows(page).first().innerText()).includes(`№ ${seqs[70]}`), "search by the registration number finds exactly one");
    // nothing found
    await searchFor(page, "такого человека нет");
    ok((await rows(page).count()) === 0 && /Ничего не найдено по «такого человека нет»/.test(await page.locator('[data-testid="reg-empty"]').innerText()), "«Ничего не найдено» with the search shown and a hint");
    if (OUT) await page.screenshot({ path: `${OUT}/after-${dev.shot}-empty.png` });

    // confirm: double tap, the notice, the search is kept, the family leaves the «waiting» list
    await searchFor(page, "нурлан");
    const before = await rows(page).count();
    const target = rows(page).first();
    const seqText = (await target.innerText()).match(/№ (\d+)/)[1];
    await target.locator('input[name="childrenCount"]').fill("1");
    await target.getByRole("button", { name: "Подтвердить вход" }).dblclick();
    await page.waitForURL(/notice=/);
    await page.waitForLoadState("networkidle");
    ok(new RegExp(`Вход подтверждён: № ${seqText}, вошло 1 ребёнок`).test(await noteOf(page)) || new RegExp(`Вход уже записан: № ${seqText}, вошло 1`).test(await noteOf(page)), `a clear confirmation with the number: «${await noteOf(page)}»`);
    ok((await page.locator('input[type="search"][name="q"]').inputValue()) === "нурлан", "the search is still there for the next family");
    ok((await rows(page).count()) === before - 1, "the confirmed family left the «waiting» list, the others stayed");
    const entries = Number((await pool.query("SELECT count(*) v FROM bb.attendance_entries e JOIN bb.consent_registrations r ON r.id = e.registration_id WHERE r.seq = $1", [seqText])).rows[0].v);
    ok(entries === 1, "one entry after a double tap");
    // filters
    await act(page, () => page.locator('[data-testid="reg-filters"] button[value="confirmed"]').click());
    const mine = rows(page).filter({ hasText: `№ ${seqText}` });
    ok((await mine.count()) === 1 && /Вход подтверждён/.test(await mine.first().innerText()) && /вошло 1/.test(await mine.first().innerText()), "filter «Подтверждены»: the family appears, with «вошло 1»");
    await act(page, () => page.locator('[data-testid="reg-filters"] button[value="all"]').click());
    ok((await rows(page).count()) === 20, "filter «Все»: all 20 of «нурлан»");
    await act(page, () => page.getByRole("button", { name: "Сбросить" }).click());
    ok((await page.locator('input[type="search"][name="q"]').inputValue()) === "" && (await page.locator('[data-testid="reg-filters"] button[aria-pressed="true"]').innerText()).startsWith("Ожидают входа"), "«Сбросить» returns to the default: everybody, «Ожидают входа»");
    ok(!(await horizontal(page)), "no horizontal scroll after the actions");
    await ctx.close();
  }

  console.log("## two cashiers at once, correction, rights, logs");
  {
    const a = await login(await browser.newContext({ viewport: { width: 768, height: 1024 } }), cashier.email);
    const b = await login(await browser.newContext({ viewport: { width: 768, height: 1024 } }), cashier2.email);
    for (const p of [a, b]) {
      await p.goto(BASE + "/attendance", { waitUntil: "networkidle" });
      await searchFor(p, "ФД7");
    }
    const ra = rows(a).first(), rb = rows(b).first();
    const seq = (await ra.innerText()).match(/№ (\d+)/)[1];
    await ra.locator('input[name="childrenCount"]').fill("2");
    await rb.locator('input[name="childrenCount"]').fill("3");
    await Promise.all([ra.getByRole("button", { name: "Подтвердить вход" }).click(), rb.getByRole("button", { name: "Подтвердить вход" }).click()]);
    await Promise.all([a.waitForURL(/notice=/), b.waitForURL(/notice=/)]);
    const notes = [await noteOf(a), await noteOf(b)];
    const q = await pool.query("SELECT count(*)::int n, min(e.children_count) c FROM bb.attendance_entries e JOIN bb.consent_registrations r ON r.id = e.registration_id WHERE r.seq = $1", [seq]);
    ok(q.rows[0].n === 1, "two cashiers confirming the same family at the same moment: one entry");
    ok(notes.some((t) => /Вход подтверждён/.test(t)) && notes.some((t) => /Вход уже записан/.test(t)), `one is told «подтверждён», the other «уже записан» (${notes.join(" | ")})`);
    // correction by the second cashier
    await a.goto(BASE + "/attendance", { waitUntil: "networkidle" });
    const entry = a.locator("[data-testid=entries] li").filter({ hasText: `QR (Семья ФД7` }).first();
    await entry.locator("summary").click();
    await entry.locator('input[name="newCount"]').fill("1");
    await entry.getByRole("button", { name: "Сохранить исправление" }).click();
    await a.waitForURL(/notice=corrected/);
    ok(Number((await pool.query("SELECT e.children_count v FROM bb.attendance_entries e JOIN bb.consent_registrations r ON r.id = e.registration_id WHERE r.seq = $1", [seq])).rows[0].v) === 1, "a correction of the number of children works from the list of entries");
    // rights
    const ed = await login(await browser.newContext({ viewport: { width: 768, height: 1024 } }), editor.email);
    await ed.goto(BASE + "/attendance", { waitUntil: "load" });
    ok(new URL(ed.url()).pathname !== "/attendance" && !/Айгерим|Нурлан|Семья/.test(await ed.locator("body").innerText()), "an editor does not get the front desk and sees no names");
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(BASE + "/attendance", { waitUntil: "load" });
    ok(new URL(anon.url()).pathname === "/login", "without a session: sent to the login");
    const all = logs.join("");
    ok(!/Айгерим|Нурлан|Семья ФД|нурпеисова/i.test(all) && !all.includes("+7701555"), "no names or phones in the server's log");
  }
} finally {
  await browser.close().catch(() => {});
  stop();
  await pool.end().catch(() => {});
}
console.log(fails ? `\nFAILS: ${fails}` : "\nALL OK");
process.exit(fails ? 1 : 0);
